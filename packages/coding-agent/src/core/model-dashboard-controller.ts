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

type PendingLayer = (target: string, scope: ModelDashboardScope) => ModelPreferences | undefined;

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
		{ id: "main", label: "Default" },
		{ id: "btw", label: "Btw" },
		...roles.map((role) => ({ id: `role:${role.name}`, label: `Agent ${role.name}` })),
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

	function layers(
		target: string,
		scope: ModelDashboardScope,
		draft: ModelPreferences,
		pending?: PendingLayer,
	): ModelPreferences {
		const layer = (scope: "global" | "project") =>
			pending?.(target, scope) ?? settings.getModelPreferences(scope, target);
		return {
			...(scope !== "global" ? layer("global") : {}),
			...(scope === "session" ? layer("project") : {}),
			...draft,
		};
	}

	function startup(
		scope: ModelDashboardScope,
		draft: ModelPreferences,
		pending?: PendingLayer,
	): ResolvedModelPreferences {
		// Main null resets that scope's field, revealing lower-scope defaults rather than storing null in legacy keys.
		const clean = Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== null));
		const preferences = layers("main", scope, clean, pending);
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

	function resolve(
		target: string,
		scope: ModelDashboardScope,
		draft: ModelPreferences,
		pending?: PendingLayer,
	): ResolvedModelPreferences {
		if (target === "main") {
			if (scope !== "session") {
				const selection = startup(scope, draft, pending);
				if (draft.thinkingLevel != null && selection.model)
					selection.thinkingLevel = clampThinkingLevel(selection.model, draft.thinkingLevel);
				return selection;
			}
			if (draft.model && draft.thinkingLevel != null && draft.fastMode != null)
				return resolveModelTarget(draft, current(), session.modelRuntime);
			const defaults = {
				...(pending?.("main", "project") ?? settings.getModelPreferences("project", "main")),
				...(draft.model ? { model: draft.model } : {}),
			};
			// Effort inheritance belongs to the final selected model, not the startup model being replaced.
			return resolveModelTarget(draft, startup("project", defaults, pending), session.modelRuntime);
		}
		const role = roles.find((role) => target === `role:${role.name}`);
		let main = current();
		if (pending) {
			for (const layer of ["session", "project", "global"] as const) {
				const mainDraft = pending("main", layer);
				if (!mainDraft) continue;
				main = resolve("main", layer, mainDraft, pending);
				break;
			}
		}
		return resolveModelTarget(layers(target, scope, draft, pending), main, session.modelRuntime, role);
	}

	return {
		targets,
		...(definitions.errors.length
			? {
					warning: `Profile configuration errors: ${definitions.errors.map(({ path, error }) => `${path}: ${error}`).join("; ")}`,
				}
			: {}),
		signal,
		modelRuntime: session.modelRuntime,
		scopedModels: session.scopedModels,
		projectTrusted: settings.isProjectTrusted(),
		read,
		resolve(target, scope, draft, pending) {
			try {
				return resolve(target, scope, draft, pending);
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
