import { randomUUID } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "../../src/core/jobs/manager.ts";
import type { JobInfo } from "../../src/core/jobs/state.ts";
import { createJobsExtension } from "../../src/extensions/jobs/index.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];

async function fixture(options: HarnessOptions = {}) {
	const manager = new JobManager("/tmp/pi-job-continuation-not-created");
	const id = randomUUID();
	let job: JobInfo = {
		id,
		name: "Check background evidence",
		command: "printf background-evidence",
		cwd: "/tmp",
		createdAt: 1,
		runtime: { state: "running", startedAt: 1, workerPid: 1, processPid: 2, port: 1234 },
		logPath: `/tmp/${id}.log`,
		workerLogPath: `/tmp/${id}-worker.log`,
	};
	vi.spyOn(manager, "list").mockImplementation(async () => [job]);
	vi.spyOn(manager, "inspect").mockImplementation(async () => job);
	let listener: Parameters<JobManager["watch"]>[1] | undefined;
	vi.spyOn(manager, "watch").mockImplementation((_id, onChange) => {
		listener = onChange;
		return () => {
			listener = undefined;
		};
	});
	const harness = await createHarness({
		...options,
		settings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", ...options.settings },
		extensionFactories: [createJobsExtension(manager), ...(options.extensionFactories ?? [])],
	});
	harnesses.push(harness);
	harness.sessionManager.appendMessage({ role: "user", content: "Check the evidence", timestamp: 1 });
	harness.sessionManager.appendMessage(fauxAssistantMessage("Checking in the background", { timestamp: 2 }));
	harness.session.refreshContext();
	await harness.session.bindExtensions({ mode: "json" });
	return {
		harness,
		job,
		complete() {
			job = { ...job, runtime: { state: "completed", startedAt: 1, endedAt: 2, exitCode: 0 } };
			const changed = listener;
			changed?.("runtime.json");
			changed?.("runtime.json");
		},
	};
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.abort();
		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	vi.restoreAllMocks();
});

describe("background job parent continuation", () => {
	it("continues an idle parent once with the completed job notice", async () => {
		const { harness, job, complete } = await fixture();
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context)).toContain(job.id);
				expect(JSON.stringify(context)).toContain(job.logPath);
				return fauxAssistantMessage("Parent consumed the completed job");
			},
		]);
		complete();
		await vi.waitFor(() => {
			expect(getMessageText(harness.session.messages.at(-1))).toBe("Parent consumed the completed job");
			expect(harness.session.isStreaming).toBe(false);
		});
		expect(harness.faux.state.callCount).toBe(1);
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "background-job",
			),
		).toHaveLength(1);
	});

	it("records the notice without starting a turn when the only user chat is on another branch", async () => {
		const { harness, job, complete } = await fixture();
		harness.sessionManager.resetLeaf();
		harness.sessionManager.appendCustomEntry("branch-state");
		harness.session.refreshContext();
		complete();
		await vi.waitFor(() => expect(getMessageText(harness.session.messages.at(-1))).toContain(job.logPath));
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.recovery.info().queuedInputs).toBe(0);
	});

	it("records the notice without starting a turn while a user prompt is blocked in an input hook", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { harness, job, complete } = await fixture({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						entered.resolve();
						await release.promise;
						return { action: "continue" };
					});
				},
			],
		});
		const prompt = "What did the job find?";
		harness.setResponses([
			(context) => {
				expect(getMessageText(context.messages.at(-1))).toBe(prompt);
				return fauxAssistantMessage("Answered the user's prompt");
			},
		]);
		const running = harness.session.prompt(prompt);
		await entered.promise;
		try {
			complete();
			await vi.waitFor(() =>
				expect(harness.session.messages).toContainEqual(
					expect.objectContaining({
						customType: "background-job",
						display: true,
						content: expect.stringContaining(job.logPath),
					}),
				),
			);
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			release.resolve();
			await running;
		}
		expect(harness.faux.state.callCount).toBe(1);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("Answered the user's prompt");
	});

	it("records the notice without queueing a turn during the parent's current tool work", async () => {
		const { harness, job, complete } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				started.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage(
					{ type: "toolCall", id: "read-cwd", name: "bash", arguments: { command: "pwd" } },
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("Current work finished"),
		]);
		const running = harness.session.prompt("Finish current work first");
		await started.promise;
		complete();
		await vi.waitFor(() => expect(harness.session.recovery.info().queuedInputs).toBe(1));
		release.resolve();
		await running;
		expect(harness.faux.state.callCount).toBe(2);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("Current work finished");
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({ role: "custom", display: true, content: expect.stringContaining(job.logPath) }),
		);
	});

	it("records the notice during manual compaction without starting a turn afterward", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { harness, job, complete } = await fixture({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						entered.resolve();
						await release.promise;
						return {
							compaction: {
								summary: "Preserved earlier work",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harness.sessionManager.appendMessage({ role: "user", content: "Earlier goal", timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("Earlier evidence".repeat(200), { timestamp: 2 }));
		harness.session.refreshContext();
		const compacting = harness.session.compact();
		await entered.promise;
		complete();
		try {
			await new Promise((resolve) => setImmediate(resolve));
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.session.isStreaming).toBe(false);
		} finally {
			release.resolve();
			await compacting;
		}
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({ role: "custom", display: true, content: expect.stringContaining(job.logPath) }),
		);
		expect(harness.session.recovery.info().queuedInputs).toBe(0);
	});

	it("retains a late completion until recovery approval and includes it in the recovered parent request", async () => {
		const { harness, job, complete } = await fixture();
		expect(harness.session.recovery.info().main).toBe(false);
		let interrupted = true;
		const unregister = harness.session.recovery.registerPeer({
			pause: async () => {},
			resume: () => {},
			pending: () => (interrupted ? [{ id: "interrupted-child", label: "Interrupted child" }] : []),
			recover: async () => {
				interrupted = false;
			},
			discard: async () => {
				interrupted = false;
			},
		});
		const errors: unknown[] = [];
		const unsubscribe = harness.session.extensionRunner?.onError((error) => errors.push(error));
		harness.setResponses([
			fauxAssistantMessage("Parent recovery approved"),
			(context) => {
				expect(JSON.stringify(context)).toContain(job.id);
				return fauxAssistantMessage("Parent consumed the approved recovery evidence");
			},
		]);
		complete();
		await vi.waitFor(() => expect(harness.session.recovery.info().queuedInputs).toBe(1));
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.recovery.needsRecovery).toBe(true);
		await harness.session.recovery.recover();
		unregister();
		unsubscribe?.();
		expect(errors).toEqual([]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("Parent consumed the approved recovery evidence");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "background-job",
			),
		).toHaveLength(1);
	});

	it("parks a completion-triggered request until the paused parent is continued", async () => {
		const { harness, complete } = await fixture();
		await harness.session.recovery.pause();
		harness.setResponses([fauxAssistantMessage("Parent consumed the job after continue")]);
		complete();
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.recovery.isPaused).toBe(true);
		harness.session.recovery.resume();
		await vi.waitFor(() => {
			expect(getMessageText(harness.session.messages.at(-1))).toBe("Parent consumed the job after continue");
			expect(harness.session.isStreaming).toBe(false);
		});
		expect(harness.faux.state.callCount).toBe(1);
	});
});
