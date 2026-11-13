import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { JobManager } from "../src/core/jobs/manager.ts";
import type { JobInfo } from "../src/core/jobs/state.ts";
import { openPane, type PaneHandle } from "../src/core/panes/host.ts";
import { createJobsExtension } from "../src/extensions/jobs/index.ts";

vi.mock("../src/core/panes/host.ts", () => ({ openPane: vi.fn() }));

const id = "12345678-1234-1234-1234-123456789abc";
const otherId = "abcdef12-1234-1234-1234-123456789abc";

function job(state: JobInfo["runtime"]["state"] = "running", jobId = id): JobInfo {
	const runtime: JobInfo["runtime"] =
		state === "running"
			? { state, startedAt: 1, workerPid: 1, processPid: 2, port: 1234 }
			: state === "starting"
				? { state, startedAt: 1 }
				: state === "unreachable" || state === "lost"
					? { state, startedAt: 1, error: "Worker unavailable" }
					: { state, startedAt: 1, endedAt: 2, exitCode: state === "completed" ? 0 : 1 };
	return {
		id: jobId,
		name: "Check chat UI",
		command: "npm run check",
		cwd: "/tmp/project",
		createdAt: 1,
		runtime,
		logPath: "/tmp/project/job.log",
		workerLogPath: "/tmp/project/worker.log",
	};
}

function pane(): PaneHandle {
	const closed = Promise.withResolvers<void>();
	return {
		backend: "rex",
		placement: "floating",
		closed: closed.promise,
		close: vi.fn(async () => closed.resolve()),
		show: vi.fn(async () => {}),
		minimize: vi.fn(async () => {}),
	};
}

describe("job pane completion cleanup", () => {
	let cleanup: (() => Promise<void>) | undefined;

	beforeEach(() => {
		vi.stubEnv("REX_SESSION", "session:test");
		vi.stubEnv("REX_BLOCK", "block:test");
		vi.mocked(openPane).mockReset();
	});

	afterEach(async () => {
		await cleanup?.();
		cleanup = undefined;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	async function fixture() {
		const manager = new JobManager("/tmp/pi-job-pane-test-not-created");
		const inspect = vi.spyOn(manager, "inspect").mockResolvedValue(job());
		vi.spyOn(manager, "list").mockResolvedValue([]);
		const watchers = new Map<string, Parameters<JobManager["watch"]>[1]>();
		vi.spyOn(manager, "watch").mockImplementation((jobId, listener) => {
			watchers.set(jobId, listener);
			return () => watchers.delete(jobId);
		});
		const runtime = createExtensionRuntime();
		const notices = vi.fn();
		runtime.sendMessage = notices;
		const notify = vi.fn();
		const context = {
			mode: "tui",
			cwd: "/tmp/project",
			ui: {
				getRexSettings: () => ({ enabled: true, mode: "floating", minimizedJobs: true }),
				setStatus: vi.fn(),
				notify,
			},
		} as unknown as ExtensionContext;
		const extension = await loadExtensionFromFactory(
			createJobsExtension(manager),
			"/tmp/project",
			createEventBus(),
			runtime,
		);
		const emit = async (type: string, event: unknown = { type }) => {
			for (const handler of extension.handlers.get(type) ?? []) await handler(event, context);
		};
		cleanup = () => emit("session_shutdown");
		const submit = (jobId = id) =>
			emit("tool_result", {
				type: "tool_result",
				toolName: "bash",
				input: { async: true },
				isError: false,
				details: { jobId, jobState: "running" },
			});
		return { manager, inspect, watchers, notices, notify, extension, context, emit, submit };
	}

	it.each(["completed", "failed", "stopped", "timed_out", "lost"] as const)(
		"closes only the finished job's pane for %s and retains its notice and records",
		async (state) => {
			const active = pane();
			const unrelated = pane();
			vi.mocked(openPane).mockResolvedValueOnce(active).mockResolvedValueOnce(unrelated);
			const test = await fixture();
			test.inspect.mockImplementation(async (jobId) => job("running", jobId));
			await test.submit();
			await test.submit(otherId);
			await vi.waitFor(() => expect(openPane).toHaveBeenCalledTimes(2));
			test.inspect.mockImplementation(async (jobId) => job(jobId === id ? state : "running", jobId));
			test.watchers.get(id)?.("runtime.json");
			await vi.waitFor(() => expect(active.close).toHaveBeenCalledTimes(1));
			expect(unrelated.close).not.toHaveBeenCalled();
			expect(test.notices).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "background-job", content: expect.stringContaining(state) }),
				{ triggerTurn: false },
			);
			expect(test.notify).not.toHaveBeenCalled();
		},
	);

	it("waits for a pane still opening when its job finishes, then closes it once", async () => {
		const opening = Promise.withResolvers<PaneHandle>();
		const active = pane();
		vi.mocked(openPane).mockReturnValue(opening.promise);
		const test = await fixture();
		await test.submit();
		await vi.waitFor(() => expect(openPane).toHaveBeenCalledOnce());
		test.inspect.mockResolvedValue(job("completed"));
		test.watchers.get(id)?.("runtime.json");
		await vi.waitFor(() => expect(test.notices).toHaveBeenCalledOnce());
		expect(active.close).not.toHaveBeenCalled();
		opening.resolve(active);
		await vi.waitFor(() => expect(active.close).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setImmediate(resolve));
		expect(test.notices).toHaveBeenCalledOnce();
	});

	it("closes an automatically opened pane for a job already finished at acknowledgment", async () => {
		const active = pane();
		vi.mocked(openPane).mockResolvedValue(active);
		const test = await fixture();
		test.inspect.mockResolvedValue(job("completed"));
		await test.submit();
		await vi.waitFor(() => expect(active.close).toHaveBeenCalledTimes(1));
	});

	it("keeps unreachable jobs open and continues observing until a final state is known", async () => {
		const active = pane();
		vi.mocked(openPane).mockResolvedValue(active);
		const test = await fixture();
		await test.submit();
		await vi.waitFor(() => expect(openPane).toHaveBeenCalledOnce());
		test.inspect.mockResolvedValue(job("unreachable"));
		test.watchers.get(id)?.("runtime.json");
		await new Promise((resolve) => setImmediate(resolve));
		expect(active.close).not.toHaveBeenCalled();
		expect(test.notices).not.toHaveBeenCalled();
		test.inspect.mockResolvedValue(job("completed"));
		test.watchers.get(id)?.("runtime.json");
		await vi.waitFor(() => expect(active.close).toHaveBeenCalledOnce());
	});

	it("also closes a manually opened active job when it finishes", async () => {
		const active = pane();
		vi.mocked(openPane).mockResolvedValue(active);
		const test = await fixture();
		const command = test.extension.commands.get("jobs");
		if (!command) throw new Error("Missing jobs command");
		await command.handler(id, test.context as Parameters<typeof command.handler>[1]);
		test.inspect.mockResolvedValue(job("completed"));
		test.watchers.get(id)?.("runtime.json");
		await vi.waitFor(() => expect(active.close).toHaveBeenCalledOnce());
	});

	it("keeps the general jobs list and deliberately reopened historical views available", async () => {
		const list = pane();
		const historical = pane();
		vi.mocked(openPane).mockResolvedValueOnce(list).mockResolvedValueOnce(historical);
		const test = await fixture();
		test.inspect.mockResolvedValue(job("completed"));
		const command = test.extension.commands.get("jobs");
		if (!command) throw new Error("Missing jobs command");
		await command.handler("", test.context as Parameters<typeof command.handler>[1]);
		await command.handler(id, test.context as Parameters<typeof command.handler>[1]);
		expect(list.close).not.toHaveBeenCalled();
		expect(historical.close).not.toHaveBeenCalled();
	});
});
