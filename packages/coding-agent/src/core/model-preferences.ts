// Resolves model controls across saved scopes and branch-local overrides without changing existing child selections.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { resolveModelReference } from "./model-resolver.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ReadonlySessionManager, SessionManager } from "./session-manager.ts";
import { type ModelPreferences, ModelPreferencesSchema, type Settings } from "./settings-schema.ts";
import type { AgentDefinition } from "./subagents/definitions.ts";

export interface ResolvedModelPreferences {
	model: Model<string> | undefined;
	thinkingLevel: ThinkingLevel;
	/** Requested priority state; inactive on models that do not support it. */
	fastMode: boolean;
}

const targetStateType = "pi.model-targets";
const targetsValidator = Compile(Type.Record(Type.String(), ModelPreferencesSchema));
const preferencesValidator = Compile(ModelPreferencesSchema);

/** Whether the selected model accepts Codex priority-tier requests. */
export function supportsFastMode(model: Model<string> | undefined): boolean {
	return model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

/** Restore the current branch's priority preference, retaining the existing /fast entry format. */
export function getSessionFastMode(session: ReadonlySessionManager, fallback = false): boolean {
	const entry = session
		.getBranch()
		.findLast((entry) => entry.type === "custom" && entry.customType === "chatgpt-fast-mode");
	if (!entry || entry.type !== "custom") return fallback;
	// Custom entries are unvalidated session JSON, not typed in-process preferences.
	const data = entry.data;
	if (data === null || typeof data !== "object" || !("enabled" in data) || typeof data.enabled !== "boolean") {
		throw new Error("Invalid saved fast-mode preference");
	}
	return data.enabled;
}

/** Apply priority only to the actual supported request model, leaving auxiliary callers opt-in. */
export function applyFastMode(payload: unknown, model: Model<string>, enabled: boolean): unknown {
	if (!enabled || !supportsFastMode(model)) return payload;
	// Provider payloads are a wire boundary: never claim priority on an invalid request.
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Codex fast mode requires an object request payload");
	}
	return { ...payload, service_tier: "priority" };
}

/** Read the latest complete branch-local snapshot; omitted targets/fields clear older overrides. */
export function getSessionModelPreferences(session: ReadonlySessionManager): Record<string, ModelPreferences> {
	const entry = session
		.getBranch()
		.findLast((entry) => entry.type === "custom" && entry.customType === targetStateType);
	if (!entry || entry.type !== "custom") return {};
	// Custom-entry data comes from session JSONL and must be validated before selecting models.
	if (!targetsValidator.Check(entry.data)) throw new Error("Invalid saved model-target preferences");
	return entry.data;
}

/** Replace one target's session layer while preserving other targets in the same branch. */
export function setSessionModelPreferences(
	session: SessionManager,
	target: string,
	preferences: ModelPreferences,
): void {
	const targets = { ...getSessionModelPreferences(session) };
	if (Object.keys(preferences).length) targets[target] = preferences;
	else delete targets[target];
	session.appendCustomEntry(targetStateType, targets);
}

/** Merge target settings with this branch's overrides, retaining null as explicit main inheritance. */
export function getModelTargetPreferences(
	settings: Settings,
	session: ReadonlySessionManager,
	target: string,
): ModelPreferences {
	const saved = settings.modelTargets?.[target] ?? {};
	// Settings JSON is not validated on load; malformed target controls must fail explicitly.
	if (!preferencesValidator.Check(saved)) throw new Error(`Invalid model preferences for ${target}`);
	return { ...saved, ...getSessionModelPreferences(session)[target] };
}

/** Resolve each field independently over the role baseline, with null bypassing it to inherit main. */
export function resolveModelTarget(
	preferences: ModelPreferences,
	main: ResolvedModelPreferences,
	runtime: ModelRuntime,
	role?: Pick<AgentDefinition, "model" | "thinkingLevel">,
): ResolvedModelPreferences {
	let model = main.model;
	if (preferences.model) {
		model = runtime.getModel(preferences.model.provider, preferences.model.id);
		if (!model) throw new Error(`Model is unavailable: ${preferences.model.provider}/${preferences.model.id}`);
	} else if (preferences.model === undefined && role?.model) {
		const resolved = resolveModelReference(
			{ text: role.model, thinkingSuffix: "none", fuzzy: true },
			runtime.getModels(),
			(provider) => runtime.hasConfiguredAuth(provider),
		);
		if (resolved.status !== "resolved") throw new Error(`Sub-agent model ${role.model} is ${resolved.status}`);
		model = resolved.model;
	}
	const thinking =
		preferences.thinkingLevel === null
			? main.thinkingLevel
			: (preferences.thinkingLevel ?? role?.thinkingLevel ?? main.thinkingLevel);
	return {
		model,
		thinkingLevel: model ? clampThinkingLevel(model, thinking) : thinking,
		fastMode: preferences.fastMode ?? main.fastMode,
	};
}
