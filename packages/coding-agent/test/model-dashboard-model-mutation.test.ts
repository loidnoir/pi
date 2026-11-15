import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("guarded direct model mutation", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await createHarness({
			models: [
				{ id: "original", reasoning: true },
				{ id: "next", reasoning: true },
			],
			settings: { defaultThinkingLevel: "medium" },
		});
		const original = harness.getModel();
		harness.settingsManager.setDefaultModelAndProvider(original.provider, original.id);
		harness.session.setThinkingLevel("high");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		harness.cleanup();
	});

	it.each(["busy", "aborted"] as const)(
		"does not mutate the model, transcript, or defaults when %s during authentication",
		async (interruption) => {
			const { session, sessionManager, settingsManager } = harness;
			const original = session.model;
			const entries = [...sessionManager.getEntries()];
			const next = harness.getModel("next")!;
			const configuredAuth = await session.modelRuntime.checkAuth(next.provider);
			const auth = Promise.withResolvers<Awaited<ReturnType<typeof session.modelRuntime.checkAuth>>>();
			vi.spyOn(session.modelRuntime, "checkAuth").mockReturnValueOnce(auth.promise);
			const idle = vi.spyOn(session, "isIdle", "get").mockReturnValue(true);
			const emit = vi.spyOn(session.extensionRunner, "emit");
			const controller = new AbortController();
			const mutation = session.setModel(next, { persist: true, signal: controller.signal, when: "idle" });
			const rejection = expect(mutation).rejects.toThrow(
				interruption === "busy" ? "Wait for the current operation to finish" : "Dashboard closed",
			);

			if (interruption === "busy") idle.mockReturnValue(false);
			else controller.abort(new Error("Dashboard closed"));
			auth.resolve(configuredAuth);
			await rejection;

			expect(session.model).toBe(original);
			expect(session.thinkingLevel).toBe("high");
			expect(sessionManager.getEntries()).toEqual(entries);
			expect(settingsManager.getDefaultModel()).toBe("original");
			expect(settingsManager.getDefaultThinkingLevel()).toBe("medium");
			expect(emit).not.toHaveBeenCalled();
		},
	);

	it("applies an authenticated guarded selection while still idle", async () => {
		const { session, sessionManager, settingsManager } = harness;
		const next = harness.getModel("next")!;
		const emit = vi.spyOn(session.extensionRunner, "emit");
		const controller = new AbortController();

		await session.setModel(next, { persist: false, signal: controller.signal, when: "idle" });

		expect(session.model).toBe(next);
		expect(session.thinkingLevel).toBe("medium");
		expect(sessionManager.getEntries().findLast((entry) => entry.type === "model_change")).toMatchObject({
			provider: next.provider,
			modelId: next.id,
		});
		expect(settingsManager.getDefaultModel()).toBe("original");
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "model_select", model: next, source: "set" }));
	});

	it.each([undefined, { persist: true }])("preserves unguarded behavior with options %j", async (options) => {
		const { session, sessionManager, settingsManager } = harness;
		const next = harness.getModel("next")!;
		const idle = vi.spyOn(session, "isIdle", "get").mockReturnValue(false);

		await session.setModel(next, options);

		expect(session.model).toBe(next);
		expect(sessionManager.getEntries().findLast((entry) => entry.type === "model_change")).toMatchObject({
			provider: next.provider,
			modelId: next.id,
		});
		expect(settingsManager.getDefaultModel()).toBe(options?.persist ? "next" : "original");
		expect(idle).not.toHaveBeenCalled();
	});

	it("rejects an already aborted selection before authentication", async () => {
		const { session, sessionManager } = harness;
		const entries = [...sessionManager.getEntries()];
		const checkAuth = vi.spyOn(session.modelRuntime, "checkAuth");
		const controller = new AbortController();
		controller.abort(new Error("Dashboard closed"));

		await expect(
			session.setModel(harness.getModel("next")!, { signal: controller.signal, when: "idle" }),
		).rejects.toThrow("Dashboard closed");

		expect(checkAuth).not.toHaveBeenCalled();
		expect(session.model?.id).toBe("original");
		expect(sessionManager.getEntries()).toEqual(entries);
	});
});
