// Scoped model preferences, branch resets, and shared fast-mode request controls.
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyFastMode,
	getModelTargetPreferences,
	getSessionFastMode,
	getSessionModelPreferences,
	resolveModelTarget,
	setSessionModelPreferences,
	supportsFastMode,
} from "../src/core/model-preferences.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager, type SettingsScope, type SettingsStorage } from "../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

class Storage implements SettingsStorage {
	values: Record<SettingsScope, string | undefined>;
	constructor(global = {}, project = {}) {
		this.values = { global: JSON.stringify(global), project: JSON.stringify(project) };
	}
	withLock(scope: SettingsScope, update: (current: string | undefined) => string | undefined): void {
		const value = update(this.values[scope]);
		if (value !== undefined) this.values[scope] = value;
	}
}

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

describe("scoped model preferences", () => {
	it("keeps raw layers separate and preserves false and explicit main inheritance", async () => {
		const settings = SettingsManager.fromStorage(
			new Storage(
				{
					defaultProvider: "provider",
					defaultModel: "base",
					modelTargets: { btw: { fastMode: true, thinkingLevel: "high" } },
				},
				{ modelTargets: { btw: { fastMode: false, thinkingLevel: null } } },
			),
		);
		expect(settings.getModelPreferences("project", "main")).toEqual({});
		expect(settings.getModelPreferences("global", "btw")).toEqual({ fastMode: true, thinkingLevel: "high" });
		expect(getModelTargetPreferences(settings.getSettings(), SessionManager.inMemory(), "btw")).toEqual({
			fastMode: false,
			thinkingLevel: null,
		});
		settings.setModelPreferences("project", "btw", {});
		await settings.flush();
		expect(settings.getSettings().modelTargets?.btw).toEqual({ fastMode: true, thinkingLevel: "high" });
	});

	it("writes only the selected target under the storage lock", async () => {
		const storage = new Storage({ theme: "dark", modelTargets: { "role:worker": { fastMode: false } } });
		const settings = SettingsManager.fromStorage(storage);
		storage.values.global = JSON.stringify({
			theme: "light",
			modelTargets: { "role:worker": { fastMode: false }, "role:reviewer": { thinkingLevel: "high" } },
		});
		settings.setModelPreferences("global", "btw", { thinkingLevel: "low" });
		await settings.flush();
		expect(JSON.parse(storage.values.global!)).toEqual({
			theme: "light",
			modelTargets: {
				"role:worker": { fastMode: false },
				"role:reviewer": { thinkingLevel: "high" },
				btw: { thinkingLevel: "low" },
			},
		});
	});

	it("maps main defaults to existing settings and leaves per-model effort untouched", async () => {
		const storage = new Storage({ modelThinkingLevels: { "provider/model": "low" } });
		const settings = SettingsManager.fromStorage(storage);
		settings.setModelPreferences("global", "main", {
			model: { provider: "provider", id: "model" },
			thinkingLevel: "high",
			fastMode: true,
		});
		await settings.flush();
		expect(settings.getSettings()).toMatchObject({
			defaultProvider: "provider",
			defaultModel: "model",
			defaultThinkingLevel: "high",
			defaultFastMode: true,
			modelThinkingLevels: { "provider/model": "low" },
		});
		expect(settings.getSettings().modelTargets).toBeUndefined();
		settings.setModelPreferences("global", "main", { model: null, thinkingLevel: null, fastMode: null });
		await settings.flush();
		expect(JSON.parse(storage.values.global!)).toEqual({ modelThinkingLevels: { "provider/model": "low" } });
	});

	it("rejects untrusted project writes and malformed stored preferences", () => {
		const settings = SettingsManager.inMemory({}, { projectTrusted: false });
		expect(() => settings.setModelPreferences("project", "btw", { fastMode: true })).toThrow("not trusted");
		const malformed = SettingsManager.fromStorage(new Storage({ modelTargets: { btw: { fastMode: "yes" } } }));
		expect(() => malformed.getModelPreferences("global", "btw")).toThrow("Invalid global");
		expect(() => getModelTargetPreferences(malformed.getSettings(), SessionManager.inMemory(), "btw")).toThrow(
			"Invalid model preferences",
		);
	});

	it("does not overwrite a settings file that failed to parse", () => {
		const storage = new Storage();
		storage.values.global = "{";
		const settings = SettingsManager.fromStorage(storage);
		expect(() => settings.setModelPreferences("global", "main", {})).toThrow("Cannot save global");
		expect(storage.values.global).toBe("{");
	});

	it("replaces session snapshots instead of resurrecting cleared fields", () => {
		const session = SessionManager.inMemory();
		setSessionModelPreferences(session, "btw", { thinkingLevel: "high", fastMode: true });
		setSessionModelPreferences(session, "role:worker", { fastMode: false });
		setSessionModelPreferences(session, "btw", { thinkingLevel: null });
		expect(getModelTargetPreferences({ modelTargets: { btw: { fastMode: false } } }, session, "btw")).toEqual({
			thinkingLevel: null,
			fastMode: false,
		});
		setSessionModelPreferences(session, "btw", {});
		expect(getSessionModelPreferences(session)).toEqual({ "role:worker": { fastMode: false } });
	});

	it("resolves explicit overrides, role baselines, and null independently", async () => {
		harness = await createHarness({
			models: [
				{ id: "main", reasoning: true },
				{ id: "worker", reasoning: true },
			],
		});
		const main = { model: harness.getModel("main"), thinkingLevel: "high" as const, fastMode: true };
		const role = { model: "worker", thinkingLevel: "low" as const };
		const runtime = harness.session.modelRuntime;
		expect(resolveModelTarget({}, main, runtime, role)).toMatchObject({
			model: { id: "worker" },
			thinkingLevel: "low",
			fastMode: true,
		});
		expect(
			resolveModelTarget({ model: null, thinkingLevel: null, fastMode: false }, main, runtime, role),
		).toMatchObject({ model: { id: "main" }, thinkingLevel: "high", fastMode: false });
		expect(() => resolveModelTarget({ model: { provider: "missing", id: "missing" } }, main, runtime)).toThrow(
			"unavailable",
		);
	});
});

describe("shared fast mode", () => {
	it("uses the latest branch entry and a fallback only when no selection was saved", () => {
		const session = SessionManager.inMemory();
		expect(getSessionFastMode(session, true)).toBe(true);
		session.appendCustomEntry("chatgpt-fast-mode", { enabled: false });
		expect(getSessionFastMode(session, true)).toBe(false);
		session.appendCustomEntry("chatgpt-fast-mode", { enabled: true });
		expect(getSessionFastMode(session)).toBe(true);
		session.appendCustomEntry("chatgpt-fast-mode", { enabled: "yes" });
		expect(() => getSessionFastMode(session)).toThrow("Invalid saved fast-mode");
	});

	it("adds priority only to actual Codex requests without mutating payloads", async () => {
		harness = await createHarness();
		const other = harness.getModel();
		const codex: Model<string> = { ...other, provider: "openai-codex", api: "openai-codex-responses" };
		const payload = { input: [] };
		expect(supportsFastMode(codex)).toBe(true);
		expect(supportsFastMode(undefined)).toBe(false);
		expect(applyFastMode(payload, other, true)).toBe(payload);
		expect(applyFastMode(payload, codex, false)).toBe(payload);
		expect(applyFastMode(payload, codex, true)).toEqual({ input: [], service_tier: "priority" });
		expect(payload).toEqual({ input: [] });
		expect(() => applyFastMode(null, codex, true)).toThrow("object request payload");
	});
});
