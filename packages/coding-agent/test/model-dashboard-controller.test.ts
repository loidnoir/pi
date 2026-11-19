// Dashboard scope previews and apply/save behavior using local faux models only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelDashboardOptions } from "../src/core/model-dashboard-controller.ts";
import {
	getSessionFastMode,
	getSessionModelPreferences,
	setSessionModelPreferences,
} from "../src/core/model-preferences.ts";
import { SettingsManager, type SettingsScope, type SettingsStorage } from "../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

describe("model dashboard controller", () => {
	it("shows main, BTW and discovered roles, and previews the selected layer", async () => {
		harness = await createHarness({
			models: [
				{ id: "main", reasoning: true },
				{ id: "worker", reasoning: true },
			],
		});
		const { session, settingsManager, tempDir } = harness;
		settingsManager.setModelPreferences("global", "btw", {
			model: { provider: harness.getModel().provider, id: "worker" },
			thinkingLevel: "low",
		});
		settingsManager.setModelPreferences("project", "btw", { fastMode: true });
		setSessionModelPreferences(session.sessionManager, "btw", { thinkingLevel: "high" });
		const options = createModelDashboardOptions(session, settingsManager, tempDir);
		expect(options.targets).toEqual(
			expect.arrayContaining([
				{ id: "main", label: "Default" },
				{ id: "btw", label: "Btw" },
				{ id: "role:worker", label: "Agent worker" },
				{ id: "role:reviewer", label: "Agent reviewer" },
			]),
		);
		expect(options).not.toHaveProperty("warning");
		expect(options.resolve("btw", "global", options.read("btw", "global"))).toMatchObject({
			model: { id: "worker" },
			thinkingLevel: "low",
			fastMode: false,
		});
		expect(options.resolve("btw", "project", options.read("btw", "project"))).toMatchObject({
			model: { id: "worker" },
			thinkingLevel: "low",
			fastMode: true,
		});
		expect(options.resolve("btw", "session", options.read("btw", "session"))).toMatchObject({
			model: { id: "worker" },
			thinkingLevel: "high",
			fastMode: true,
		});
	});

	it("reports discovery failures separately from the remaining targets", async () => {
		harness = await createHarness();
		const agents = join(harness.tempDir, "agents");
		mkdirSync(agents, { recursive: true });
		const path = join(agents, "broken.md");
		writeFileSync(path, "Missing profile metadata");
		const options = createModelDashboardOptions(harness.session, harness.settingsManager, harness.tempDir);
		expect(options).toMatchObject({ warning: expect.stringContaining(`${path}: Invalid agent frontmatter`) });
		expect(options.targets).toEqual([
			{ id: "main", label: "Default" },
			{ id: "btw", label: "Btw" },
		]);
	});

	it("previews staged lower scopes and the pending Default without changing the session", async () => {
		harness = await createHarness({
			models: [
				{ id: "main", reasoning: true },
				{ id: "other", reasoning: true },
			],
		});
		const { session, settingsManager, tempDir } = harness;
		const options = createModelDashboardOptions(session, settingsManager, tempDir);
		const other = { provider: harness.getModel().provider, id: "other" };
		const pending = (id: string, scope: string) => {
			if (id === "main" && scope === "project") return { model: other, thinkingLevel: "high" as const };
			if (id === "btw" && scope === "global") return { fastMode: true };
			return undefined;
		};
		expect(options.resolve("btw", "session", {}, pending)).toMatchObject({
			model: other,
			thinkingLevel: "high",
			fastMode: true,
		});
		expect(session.model?.id).toBe("main");
		expect(options.read("btw", "global")).toEqual({});
	});

	it("applies main selection now and saves only the raw chosen scope", async () => {
		harness = await createHarness({
			models: [
				{ id: "main", reasoning: true },
				{ id: "other", reasoning: true },
			],
		});
		const { session, settingsManager, tempDir } = harness;
		const options = createModelDashboardOptions(session, settingsManager, tempDir);
		const model = harness.getModel("other")!;
		await options.save("main", "project", {
			model: { provider: model.provider, id: model.id },
			thinkingLevel: "high",
			fastMode: true,
		});
		expect(session.model?.id).toBe("other");
		expect(session.thinkingLevel).toBe("high");
		expect(getSessionFastMode(session.sessionManager)).toBe(true);
		expect(settingsManager.getProjectSettings()).toMatchObject({
			defaultModel: "other",
			defaultThinkingLevel: "high",
			defaultFastMode: true,
		});
		expect(settingsManager.getGlobalSettings().defaultModel).toBeUndefined();
	});

	it("restores startup values on main session reset without deleting saved defaults", async () => {
		harness = await createHarness({
			models: [
				{ id: "main", reasoning: true },
				{ id: "other", reasoning: true },
			],
		});
		const { session, settingsManager, tempDir } = harness;
		settingsManager.setModelPreferences("global", "main", {
			model: { provider: harness.getModel().provider, id: "main" },
			thinkingLevel: "low",
			fastMode: true,
		});
		await session.setModel(harness.getModel("other")!);
		session.setThinkingLevel("high");
		const options = createModelDashboardOptions(session, settingsManager, tempDir);
		await options.save("main", "session", {});
		expect(session.model?.id).toBe("main");
		expect(session.thinkingLevel).toBe("low");
		expect(getSessionFastMode(session.sessionManager)).toBe(true);
		expect(settingsManager.getGlobalSettings().defaultModel).toBe("main");
	});

	it("saves raw inheritance rather than pinning effective values", async () => {
		harness = await createHarness({ models: [{ id: "main", reasoning: true }] });
		const { session, settingsManager, tempDir } = harness;
		const options = createModelDashboardOptions(session, settingsManager, tempDir);
		await options.save("btw", "global", { thinkingLevel: null, fastMode: false });
		expect(settingsManager.getGlobalSettings().modelTargets?.btw).toEqual({ thinkingLevel: null, fastMode: false });
		await options.save("role:worker", "session", { model: null, thinkingLevel: "low" });
		expect(getSessionModelPreferences(session.sessionManager)["role:worker"]).toEqual({
			model: null,
			thinkingLevel: "low",
		});
		expect(session.model?.id).toBe("main");
		await options.save("role:worker", "session", {});
		expect(getSessionModelPreferences(session.sessionManager)["role:worker"]).toBeUndefined();
	});

	it("keeps unavailable model preferences editable but rejects Apply", async () => {
		harness = await createHarness();
		const { session, settingsManager, tempDir } = harness;
		const options = createModelDashboardOptions(session, settingsManager, tempDir);
		const draft = { model: { provider: "missing", id: "missing" } };
		expect(options.resolve("btw", "session", draft).model).toBeUndefined();
		await expect(options.save("btw", "session", draft)).rejects.toThrow("unavailable");
		expect(getSessionModelPreferences(session.sessionManager)).toEqual({});
	});

	it("does not mutate main while active or after its lifetime was aborted", async () => {
		harness = await createHarness();
		const { session, settingsManager, tempDir } = harness;
		const lifetime = new AbortController();
		const options = createModelDashboardOptions(session, settingsManager, tempDir, lifetime.signal);
		const idle = vi.spyOn(session, "isIdle", "get").mockReturnValue(false);
		await expect(options.save("main", "session", {})).rejects.toThrow("finish");
		idle.mockRestore();
		const configuredAuth = await session.modelRuntime.checkAuth(session.model!.provider);
		const auth = Promise.withResolvers<Awaited<ReturnType<typeof session.modelRuntime.checkAuth>>>();
		vi.spyOn(session.modelRuntime, "checkAuth").mockReturnValue(auth.promise);
		const save = options.save("main", "session", options.read("main", "session"));
		lifetime.abort();
		auth.resolve(configuredAuth);
		await expect(save).rejects.toThrow();
		expect(
			session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "chatgpt-fast-mode"),
		).toBe(false);
	});

	it("reports persistent write failure without pretending the main apply was rolled back", async () => {
		harness = await createHarness();
		const values: Record<SettingsScope, string | undefined> = { global: "{}", project: "{}" };
		let fail = false;
		const storage: SettingsStorage = {
			withLock(scope, update) {
				const next = update(values[scope]);
				if (next !== undefined) {
					if (fail) throw new Error("read-only storage");
					values[scope] = next;
				}
			},
		};
		const settings = SettingsManager.fromStorage(storage);
		const options = createModelDashboardOptions(harness.session, settings, harness.tempDir);
		fail = true;
		await expect(
			options.save("main", "global", { ...options.read("main", "session"), fastMode: true }),
		).rejects.toThrow("current selection was applied");
		expect(getSessionFastMode(harness.sessionManager)).toBe(true);
	});
});
