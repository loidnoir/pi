import { TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { JobInfo } from "../src/core/jobs/state.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SessionRecovery, type SessionRecoveryInfo } from "../src/core/session-recovery.ts";
import type { SubagentActivity } from "../src/core/subagents/activity.ts";
import type { SubagentStatus } from "../src/core/subagents/state.ts";
import { RecoveryMenu } from "../src/extensions/recovery/menu.ts";
import { icon, setIconPreset } from "../src/modes/interactive/icons.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const menus: RecoveryMenu[] = [];
const recoveries: SessionRecovery[] = [];

beforeAll(() => initTheme("dark"));
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const menu of menus.splice(0)) menu.dispose();
	for (const recovery of recoveries.splice(0)) recovery.dispose();
	vi.restoreAllMocks();
	vi.useRealTimers();
	setIconPreset("unicode");
});

function fixture(overrides: Partial<SessionRecoveryInfo> = {}, recovering = false) {
	const recovery = new SessionRecovery(SessionManager.inMemory(), "/unused", {
		isRunning: () => false,
		abort() {},
		restoreInputs() {},
		clearInputs() {},
		async continueWork() {},
		refreshContext() {},
	});
	recoveries.push(recovery);
	const info: SessionRecoveryInfo = { ...recovery.info(), status: "paused", ...overrides };
	vi.spyOn(recovery, "info").mockImplementation(() => info);
	vi.spyOn(recovery, "needsRecovery", "get").mockReturnValue(recovering);
	const listeners = new Set<() => void>();
	let statuses: SubagentStatus[] = [];
	let source: SubagentActivity | undefined = {
		list: () => statuses,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const jobs = vi.fn<() => Promise<JobInfo[]>>().mockResolvedValue([]);
	const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
	const render = vi.spyOn(tui, "requestRender");
	const done = vi.fn();
	const menu = new RecoveryMenu(
		recovery,
		{ subagents: () => source, jobs },
		tui,
		theme,
		new KeybindingsManager(),
		done,
	);
	menus.push(menu);
	return {
		menu,
		info,
		recovery,
		jobs,
		done,
		render,
		listeners,
		text: () => stripAnsi(menu.render(120).join("\n")),
		children: (next: SubagentStatus[]) => {
			statuses = next;
			for (const listener of listeners) listener();
		},
		missingChildren: () => {
			source = undefined;
		},
	};
}

function job(runtime: JobInfo["runtime"]): JobInfo {
	return {
		id: "job-id",
		name: "job",
		command: "not executed",
		cwd: "/project",
		createdAt: 0,
		runtime,
		logPath: "/unused/output.log",
		workerLogPath: "/unused/worker.log",
	};
}

describe("pause advisory checklist", () => {
	it.each(["unicode", "nerd"] as const)(
		"shows four green checked idle rows with %s icons and fits narrow widths",
		async (preset) => {
			setIconPreset(preset);
			const f = fixture();
			expect(f.text()).toContain("Job activity unknown");
			expect(f.text()).not.toContain("Safe to");
			await Promise.resolve();
			for (const text of [
				"0 active model responses",
				"0 running tool calls",
				"0 running sub-agents",
				"0 running jobs",
			])
				expect(f.menu.render(120)).toContain(theme.fg("success", `${icon("checkboxChecked")} ${text}`));
			expect(f.text()).toContain(`${icon("pause")} Session paused`);
			expect(f.text()).toContain(`${icon("pause")} Keep paused`);
			expect(f.text()).toContain("Safe to leave paused.");
			for (const width of [1, 3, 12, 30, 80])
				expect(f.menu.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
			setIconPreset(preset === "nerd" ? "unicode" : "nerd");
			f.menu.invalidate();
			expect(f.text()).toContain(`${icon("checkboxChecked")} 0 running jobs`);
		},
	);

	it("marks live model/tool/child work yellow without blocking Continue or Keep paused", async () => {
		const f = fixture({ status: "pausing", modelActive: true, activeTools: 2 });
		f.children(["running", "running", "queued", "paused", "completed"]);
		await Promise.resolve();
		for (const text of ["1 active model response", "2 running tool calls", "2 running sub-agents · 1 queued"])
			expect(f.menu.render(120)).toContain(theme.fg("warning", `${icon("checkboxUnchecked")} ${text}`));
		expect(f.text()).not.toContain("Safe to");
		f.menu.handleInput("\r");
		expect(f.done).toHaveBeenLastCalledWith("continue");
		f.menu.handleInput("\u001b");
		expect(f.done).toHaveBeenLastCalledWith("keep");
	});

	it("counts starting/running jobs and keeps unreachable/lost jobs yellow instead of idle", async () => {
		const f = fixture();
		f.jobs.mockResolvedValue([
			job({ state: "starting", startedAt: 0 }),
			job({ state: "running", startedAt: 0, workerPid: 1, processPid: 2, port: 3 }),
			job({ state: "completed", startedAt: 0, endedAt: 1, exitCode: 0 }),
		]);
		await vi.advanceTimersByTimeAsync(2000);
		expect(f.menu.render(120)).toContain(theme.fg("warning", `${icon("checkboxUnchecked")} 2 running jobs`));
		f.jobs.mockResolvedValue([
			job({ state: "unreachable", startedAt: 0, error: "offline" }),
			job({ state: "lost", startedAt: 0, error: "lost" }),
		]);
		await vi.advanceTimersByTimeAsync(2000);
		expect(f.text()).toContain("2 jobs with unknown activity");
		expect(f.text()).not.toContain("0 running jobs");
		expect(f.text()).not.toContain("Safe to");
	});

	it("never treats missing child activity or failed job inspection as zero", async () => {
		const f = fixture();
		f.missingChildren();
		f.jobs.mockRejectedValue(new Error("catalog unreadable"));
		await vi.advanceTimersByTimeAsync(2000);
		for (const text of ["Sub-agent activity unknown", "Job activity unknown"])
			expect(f.menu.render(120)).toContain(theme.fg("warning", `${icon("checkboxUnchecked")} ${text}`));
		expect(f.text()).not.toContain("0 running sub-agents");
		expect(f.text()).not.toContain("0 running jobs");
		expect(f.text()).not.toContain("Safe to");
	});

	it("does not count interrupted saved children as running", async () => {
		const f = fixture();
		f.children(["interrupted"]);
		await Promise.resolve();
		expect(f.text()).toContain("1 interrupted; activity unknown");
		expect(f.text()).not.toContain("running sub-agents");
		expect(f.text()).not.toContain("Safe to");
	});

	it("updates on recovery/child events and job polling, then releases subscriptions and timers", async () => {
		const f = fixture({ status: "pausing", modelActive: true });
		f.children(["running"]);
		f.jobs.mockResolvedValue([job({ state: "starting", startedAt: 0 })]);
		await vi.advanceTimersByTimeAsync(2000);
		expect(f.text()).not.toContain("Safe to");
		f.info.status = "paused";
		f.info.modelActive = false;
		f.render.mockClear();
		f.recovery.modelFinished();
		expect(f.render).toHaveBeenCalled();
		f.children(["paused"]);
		f.jobs.mockResolvedValue([]);
		await vi.advanceTimersByTimeAsync(2000);
		expect(f.text()).toContain("Safe to leave paused.");
		f.menu.dispose();
		expect(f.listeners.size).toBe(0);
		f.render.mockClear();
		f.jobs.mockClear();
		f.recovery.modelFinished();
		await vi.advanceTimersByTimeAsync(4000);
		expect(f.render).not.toHaveBeenCalled();
		expect(f.jobs).not.toHaveBeenCalled();
	});

	it("ignores job inspection results arriving after disposal", async () => {
		const f = fixture();
		await Promise.resolve();
		const result = Promise.withResolvers<JobInfo[]>();
		f.jobs.mockReturnValue(result.promise);
		await vi.advanceTimersByTimeAsync(2000);
		f.menu.dispose();
		f.render.mockClear();
		result.resolve([]);
		await Promise.resolve();
		expect(f.render).not.toHaveBeenCalled();
	});

	it("preserves interrupted evidence, branch gating, and all three recovery choices", () => {
		const f = fixture(
			{
				status: "interrupted",
				branchMatches: false,
				main: true,
				queuedInputs: 2,
				tools: [
					{ id: "unknown-id", name: "write", outcome: "unknown" },
					{ id: "saved-id", name: "read", outcome: "completed" },
				],
				children: [{ id: "child-id", label: "Inspect child history" }],
			},
			true,
		);
		const text = f.text();
		for (const warning of [
			"No work resumes until you choose Continue",
			"outcome unknown — inspect before repeating",
			"completed result saved",
			"Interrupted child tools may have unknown outcomes",
			"Pending work belongs to another branch",
		])
			expect(text).toContain(warning);
		expect(text).not.toContain("Safe to");
		f.menu.handleInput("\u001b[A");
		f.menu.handleInput("\r");
		expect(f.done).not.toHaveBeenCalled();
		f.info.branchMatches = true;
		f.menu.handleInput("\r");
		expect(f.done).toHaveBeenLastCalledWith("continue");
		f.menu.handleInput("\u001b[B");
		f.menu.handleInput("\r");
		expect(f.done).toHaveBeenLastCalledWith("keep");
		f.menu.handleInput("\u001b[B");
		f.menu.handleInput("\r");
		expect(f.done).toHaveBeenLastCalledWith("discard");
	});
});
