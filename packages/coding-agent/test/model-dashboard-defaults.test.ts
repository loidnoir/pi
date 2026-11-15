// Regression coverage for legacy default layering and interrupted dashboard applies.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelDashboardOptions } from "../src/core/model-dashboard-controller.ts";
import { getSessionFastMode } from "../src/core/model-preferences.ts";
import { SettingsManager, type SettingsScope } from "../src/core/settings-manager.ts";
import type { Settings } from "../src/core/settings-schema.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function settingsFromLayers(global: Settings, project: Settings): SettingsManager {
	const values: Record<SettingsScope, string> = { global: JSON.stringify(global), project: JSON.stringify(project) };
	return SettingsManager.fromStorage({
		withLock(scope, update) {
			const next = update(values[scope]);
			if (next !== undefined) values[scope] = next;
		},
	});
}

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

describe("legacy main default layering", () => {
	it("keeps independently scoped model IDs when another field is saved", async () => {
		harness = await createHarness({
			models: [
				{ id: "main", reasoning: true },
				{ id: "project", reasoning: true },
			],
		});
		const provider = harness.getModel().provider;
		const settings = settingsFromLayers(
			{ defaultProvider: provider, defaultModel: "main" },
			{ defaultModel: "project" },
		);
		const options = createModelDashboardOptions(harness.session, settings, harness.tempDir);
		const draft = { ...options.read("main", "project"), fastMode: true };
		expect(draft.model).toEqual({ provider, id: "project" });
		expect(options.resolve("main", "project", draft).model?.id).toBe("project");
		await options.save("main", "project", draft);
		expect(settings.getProjectSettings()).toMatchObject({ defaultModel: "project", defaultFastMode: true });
		expect(settings.getProjectSettings().defaultProvider).toBeUndefined();
		expect(harness.session.model?.id).toBe("project");
	});

	it("keeps independently scoped providers without pinning the inherited model ID", async () => {
		const settings = settingsFromLayers(
			{ defaultProvider: "global", defaultModel: "model" },
			{ defaultProvider: "project" },
		);
		const draft = { ...settings.getModelPreferences("project", "main"), thinkingLevel: "high" as const };
		expect(draft.model).toEqual({ provider: "project", id: "model" });
		settings.setModelPreferences("project", "main", draft);
		await settings.flush();
		expect(settings.getProjectSettings().defaultProvider).toBe("project");
		expect(settings.getProjectSettings().defaultModel).toBeUndefined();
	});

	it("prefers per-model effort over inherited thinking defaults but honors an explicit draft", async () => {
		harness = await createHarness({ models: [{ id: "main", reasoning: true }] });
		const provider = harness.getModel().provider;
		const settings = settingsFromLayers(
			{
				defaultProvider: provider,
				defaultModel: "main",
				defaultThinkingLevel: "medium",
				modelThinkingLevels: { [`${provider}/main`]: "high" },
			},
			{},
		);
		const options = createModelDashboardOptions(harness.session, settings, harness.tempDir);
		expect(options.resolve("main", "project", { fastMode: true }).thinkingLevel).toBe("high");
		await options.save("main", "project", { fastMode: true });
		expect(harness.session.thinkingLevel).toBe("high");
		await options.save("main", "project", { thinkingLevel: "low", fastMode: true });
		expect(harness.session.thinkingLevel).toBe("low");
		expect(settings.getSettings().modelThinkingLevels?.[`${provider}/main`]).toBe("high");
		await options.save("main", "session", {});
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("inherits effort for the draft model rather than the startup model", async () => {
		harness = await createHarness({
			models: [
				{ id: "main", reasoning: true },
				{ id: "other", reasoning: true },
			],
		});
		const provider = harness.getModel().provider;
		const settings = settingsFromLayers(
			{
				defaultProvider: provider,
				defaultModel: "main",
				defaultThinkingLevel: "medium",
				modelThinkingLevels: { [`${provider}/main`]: "low", [`${provider}/other`]: "high" },
			},
			{},
		);
		const options = createModelDashboardOptions(harness.session, settings, harness.tempDir);
		const draft = { model: { provider, id: "other" }, thinkingLevel: null, fastMode: false };
		expect(options.resolve("main", "session", draft).thinkingLevel).toBe("high");
		await options.save("main", "session", draft);
		expect(harness.session.model?.id).toBe("other");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("can replace current model settings even when a saved startup model was removed", async () => {
		harness = await createHarness({ models: [{ id: "main", reasoning: true }] });
		const settings = settingsFromLayers({ defaultProvider: "missing", defaultModel: "removed" }, {});
		const options = createModelDashboardOptions(harness.session, settings, harness.tempDir);
		await options.save("main", "session", { ...options.read("main", "session"), fastMode: true });
		expect(getSessionFastMode(harness.sessionManager)).toBe(true);
	});

	it("rejects malformed paid-tier defaults at the settings-file boundary", () => {
		const settings = SettingsManager.fromStorage({
			withLock(_scope, update) {
				update('{"defaultFastMode":"false"}');
			},
		});
		expect(settings.getSettings().defaultFastMode).toBeUndefined();
		expect(() => settings.getModelPreferences("global", "main")).toThrow("expected a boolean");
	});
});

describe("interrupted dashboard apply", () => {
	it("stops after model-selection handlers abort its lifetime", async () => {
		harness = await createHarness({
			models: [
				{ id: "main", reasoning: true },
				{ id: "next", reasoning: true },
			],
		});
		const lifetime = new AbortController();
		const options = createModelDashboardOptions(
			harness.session,
			harness.settingsManager,
			harness.tempDir,
			lifetime.signal,
		);
		const original = harness.session.setModel.bind(harness.session);
		vi.spyOn(harness.session, "setModel").mockImplementation(async (model, mutation) => {
			await original(model, mutation);
			lifetime.abort();
		});
		await expect(
			options.save("main", "global", {
				model: { provider: harness.getModel().provider, id: "next" },
				thinkingLevel: "high",
				fastMode: true,
			}),
		).rejects.toThrow("remaining settings were not applied");
		expect(harness.session.model?.id).toBe("next");
		expect(getSessionFastMode(harness.sessionManager)).toBe(false);
		expect(harness.settingsManager.getGlobalSettings().defaultModel).toBeUndefined();
	});
});
