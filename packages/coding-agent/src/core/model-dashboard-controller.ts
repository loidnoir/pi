// Connects dashboard drafts to scoped settings and branch-local selections without changing existing children.
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import {
	getSessionFastMode,
	getSessionModelPreferences,
	type ResolvedModelPreferences,
	resolveModelTarget,
	setSessionModelPreferences,
} from "./model-preferences.ts";
import { defaultModelPerProvider } from "./model-resolver.ts";
import type { ModelDashboardOptions, ModelDashboardScope, ModelDashboardTarget } from "./panes/model-dashboard.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { ModelPreferences } from "./settings-schema.ts";
import { discoverAgentDefinitions } from "./subagents/definitions.ts";

/** Build a controller tied to one runtime; persistent main saves also apply to the current conversation. */
export function createModelDashboardOptions(
	session: AgentSession,
	settings: SettingsManager,
	agentDir: string,
	signal?: AbortSignal,
): ModelDashboardOptions {
	const definitions = discoverAgentDefinitions(session.sessionManager.getCwd(), agentDir);
	const roles = definitions.agents.filter((role) => role.source !== "project" || settings.isProjectTrusted());
	const targets: ModelDashboardTarget[] = [
		{
			id: "main",
			label: "Main thread",
			description:
				"Apply now; project/global also save startup defaults. Saved per-model effort still applies when switching models." +
				(definitions.errors.length
					? ` Profile configuration errors: ${definitions.errors.map((error) => `${error.path}: ${error.error}`).join("; ")}`
					: ""),
		},
		{
			id: "btw",
			label: "BTW default",
			description: "Only new side chats use these defaults; existing chats keep their saved settings.",
		},
		...roles.map((role) => ({
			id: `role:${role.name}`,
			label: `Sub-agent: ${role.name}`,
			description: `${role.description} New launches only; submitted and resumed children keep their selections.`,
		})),
	];

	function current(): ResolvedModelPreferences {
		return {
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			fastMode: getSessionFastMode(session.sessionManager, settings.getSettings().defaultFastMode ?? false),
		};
	}

	function read(target: string, scope: ModelDashboardScope): ModelPreferences {
		if (scope !== "session") return settings.getModelPreferences(scope, target);
		if (target !== "main") return { ...getSessionModelPreferences(session.sessionManager)[target] };
		const selection = current();
		return {
			...(selection.model ? { model: { provider: selection.model.provider, id: selection.model.id } } : {}),
			thinkingLevel: selection.thinkingLevel,
			fastMode: selection.fastMode,
		};
	}

	function layers(target: string, scope: ModelDashboardScope, draft: ModelPreferences): ModelPreferences {
		return {
			...(scope !== "global" ? settings.getModelPreferences("global", target) : {}),
			...(scope === "session" ? settings.getModelPreferences("project", target) : {}),
			...draft,
		};
	}

	function startup(scope: ModelDashboardScope, draft: ModelPreferences): ResolvedModelPreferences {
		// Main null resets that scope's field, revealing lower-scope defaults rather than storing null in legacy keys.
		const clean = Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== null));
		const preferences = layers("main", scope, clean);
		const available = session.modelRuntime.getAvailableSnapshot();
		const automatic =
			session.scopedModels[0]?.model ??
			Object.entries(defaultModelPerProvider)
				.map(([provider, id]) => available.find((model) => model.provider === provider && model.id === id))
				.find((model) => model !== undefined) ??
			available[0];
		const fallback: ResolvedModelPreferences = {
			model: automatic,
			thinkingLevel: DEFAULT_THINKING_LEVEL,
			fastMode: false,
		};
		const resolved = resolveModelTarget(preferences, fallback, session.modelRuntime);
		if (resolved.model) {
			const key = `${resolved.model.provider}/${resolved.model.id}`;
			const perModel =
				scope === "global"
					? settings.getGlobalSettings().modelThinkingLevels?.[key]
					: settings.getSettings().modelThinkingLevels?.[key];
			if (perModel !== undefined) resolved.thinkingLevel = clampThinkingLevel(resolved.model, perModel);
		}
		return resolved;
	}

	function resolve(target: string, scope: ModelDashboardScope, draft: ModelPreferences): ResolvedModelPreferences {
		if (target === "main") {
			if (scope !== "session") {
				const selection = startup(scope, draft);
				if (draft.thinkingLevel != null && selection.model)
					selection.thinkingLevel = clampThinkingLevel(selection.model, draft.thinkingLevel);
				return selection;
			}
			if (draft.model && draft.thinkingLevel != null && draft.fastMode != null)
				return resolveModelTarget(draft, current(), session.modelRuntime);
			const defaults = {
				...settings.getModelPreferences("project", "main"),
				...(draft.model ? { model: draft.model } : {}),
			};
			// Effort inheritance belongs to the final selected model, not the startup model being replaced.
			return resolveModelTarget(draft, startup("project", defaults), session.modelRuntime);
		}
		const role = roles.find((role) => target === `role:${role.name}`);
		return resolveModelTarget(layers(target, scope, draft), current(), session.modelRuntime, role);
	}

	return {
		targets,
		modelRuntime: session.modelRuntime,
		scopedModels: session.scopedModels,
		projectTrusted: settings.isProjectTrusted(),
		read,
		resolve(target, scope, draft) {
			try {
				return resolve(target, scope, draft);
			} catch {
				// A removed model must remain editable; Apply still reports the precise resolution failure below.
				return {
					model: undefined,
					thinkingLevel: draft.thinkingLevel ?? current().thinkingLevel,
					fastMode: draft.fastMode ?? current().fastMode,
				};
			}
		},
		async save(target, scope, draft) {
			signal?.throwIfAborted();
			if (!targets.some((entry) => entry.id === target)) throw new Error(`Unknown model target: ${target}`);
			if (scope === "project" && !settings.isProjectTrusted()) throw new Error("Project is not trusted");
			if (target === "main" && !session.isIdle)
				throw new Error("Wait for the main thread to finish before changing its model settings");
			const selection = resolve(target, scope, draft);
			if (!selection.model) throw new Error("Choose an available model before applying settings");
			if (!(await session.modelRuntime.checkAuth(selection.model.provider)))
				throw new Error(`No authentication configured for ${selection.model.provider}`);
			signal?.throwIfAborted();
			if (target === "main") {
				if (!session.isIdle)
					throw new Error("Wait for the main thread to finish before changing its model settings");
				await session.setModel(selection.model, { persist: false, signal, when: "idle" });
				if (signal?.aborted || !session.isIdle)
					throw new Error(
						"Main model was applied, but remaining settings were not applied because the view closed or work started",
					);
				session.setThinkingLevel(selection.thinkingLevel, { persist: false });
				session.sessionManager.appendCustomEntry("chatgpt-fast-mode", { enabled: selection.fastMode });
			} else if (scope === "session") {
				setSessionModelPreferences(session.sessionManager, target, draft);
			}
			if (scope !== "session") {
				settings.setModelPreferences(
					scope,
					target,
					target === "main" && Object.keys(draft).length === 0
						? { model: null, thinkingLevel: null, fastMode: null }
						: draft,
				);
				await settings.flush();
				const failures = settings.drainErrors();
				if (failures.length)
					throw new Error(
						`Could not save defaults${target === "main" ? " (current selection was applied)" : ""}: ${failures.map(({ error }) => error.message).join("; ")}`,
					);
			}
		},
	};
}
