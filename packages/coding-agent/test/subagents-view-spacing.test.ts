import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SubagentManager } from "../src/core/subagents/manager.ts";
import type { SubagentEvent, SubagentInfo } from "../src/core/subagents/state.ts";
import { SubagentsView } from "../src/core/subagents/view.ts";
import { createUsageTotals } from "../src/core/usage-totals.ts";
import { icon, iconPrefix, setIconPreset } from "../src/modes/interactive/icons.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	setKeybindings(previousKeys);
	setIconPreset("unicode");
});

function agent(id: string, status: SubagentInfo["status"]): SubagentInfo {
	return {
		id,
		role: "worker",
		label: `日本語 ${id}`,
		status,
		model: "test/model",
		thinkingLevel: "off",
		tools: [],
		createdAt: 0,
		updatedAt: 0,
		run: 1,
		async: true,
		originEntryId: null,
		preview: "",
		usage: createUsageTotals(),
	};
}

function setup(entries: SubagentInfo[]) {
	let listener: (event: SubagentEvent) => void;
	const manager = {
		list: vi.fn(() => entries.slice()),
		remove: vi.fn((id: string) => listener({ type: "deleted", id })),
		cancel: vi.fn(async (_id: string) => {}),
		inspect: vi.fn((id: string) => entries.find((entry) => entry.id === id)),
		subscribe: (callback: typeof listener) => {
			listener = callback;
			return () => {};
		},
		transcript: vi.fn(() => ({ cwd: process.cwd(), messages: [], offset: 0, totalMessages: 0 })),
	};
	const controls = { invalidate: vi.fn(), close: vi.fn(), minimize: async () => {}, setTitle: async () => {} };
	const view = new SubagentsView(manager as unknown as SubagentManager, controls, {
		definitions: () => ({
			agents: ["worker", "scout", "planner"].map((name) => ({
				name,
				description: "Implement tasks",
				systemPrompt: "",
				source: "builtin" as const,
			})),
			errors: [],
		}),
		start: async () => entries[0],
		resume: async () => entries[0],
	});
	const render = () => view.render(100, 24).map(stripAnsi);
	return { view, controls, manager, render, emit: (event: SubagentEvent) => listener(event) };
}

describe("sub-agent pane rows", () => {
	it("animates visible active rows together and leaves static views idle", () => {
		const entries = [agent("active", "running"), agent("waiting", "queued"), agent("finished", "completed")];
		const { view, manager, controls, render, emit } = setup(entries);
		try {
			const first = render();
			expect(first).not.toContain("Sub-agents");
			expect(first[1]).toContain(`├─ ⠋  ${iconPrefix("agentWorker")}worker`);
			expect(first[2]).toContain("├─ ⠋");
			expect(first[3]).toContain(`└─ ${icon("statusDot")}`);
			controls.invalidate.mockClear();
			vi.advanceTimersByTime(80);
			expect(controls.invalidate).toHaveBeenCalledOnce();
			const next = render();
			expect(next[1]).toContain("⠙");
			expect(next[2]).toContain("⠙");
			expect(next[3]).toBe(first[3]);
			expect(manager.list).toHaveBeenCalledOnce();
			expect(manager.inspect).not.toHaveBeenCalled();
			expect(manager.transcript).not.toHaveBeenCalled();
			view.handleInput("\r");
			expect(render()[1]).toContain("Read-only agent history");
			controls.invalidate.mockClear();
			vi.advanceTimersByTime(240);
			expect(controls.invalidate).not.toHaveBeenCalled();
			expect(manager.transcript).toHaveBeenCalledOnce();
			view.handleInput("\x1b");
			view.handleInput("\x0e");
			expect(render()[1]).toContain(`├─ ${iconPrefix("agentWorker")}worker [builtin]`);
			view.scrollBy(1);
			view.handleInput("\x1b[6~");
			expect(render().find((row) => row.startsWith(">"))).toContain(`└─ ${iconPrefix("agentPlanner")}`);
			controls.invalidate.mockClear();
			vi.advanceTimersByTime(240);
			expect(controls.invalidate).not.toHaveBeenCalled();
			view.handleInput("\x1b");
			render();
			for (const entry of entries) {
				entry.status = "completed";
				emit({ type: "status", id: entry.id });
			}
			render();
			controls.invalidate.mockClear();
			vi.advanceTimersByTime(240);
			expect(controls.invalidate).not.toHaveBeenCalled();
			entries[0].status = "running";
			emit({ type: "status", id: entries[0].id });
			expect(render()[1]).toContain("⠋");
		} finally {
			view.dispose();
		}
		render();
		controls.invalidate.mockClear();
		vi.advanceTimersByTime(240);
		expect(controls.invalidate).not.toHaveBeenCalled();
	});

	it("keeps the selected run across arrivals, completion and deletion, falling back to its neighbor", () => {
		const entries = Array.from({ length: 24 }, (_, i) => agent(`run-${i}`, "completed"));
		const { view, render, emit } = setup(entries);
		const selected = () => render().find((row) => row.startsWith(">"));
		try {
			render();
			view.handleInput("\x1b[6~");
			expect(selected()).not.toContain("日本語 run-0 ");
			view.handleInput("\x1b[5~");
			view.scrollBy(3);
			view.handleInput("\x1b[A");
			expect(selected()).toContain("日本語 run-2 ");
			entries.unshift(agent("new", "queued"));
			emit({ type: "status", id: "new" });
			entries[0].status = "completed";
			emit({ type: "status", id: "new" });
			expect(selected()).toContain("日本語 run-2 ");
			emit({ type: "deleted", id: "run-0" });
			expect(selected()).toContain("日本語 run-2 ");
			emit({ type: "deleted", id: "run-2" });
			expect(selected()).toContain("日本語 run-3 ");
		} finally {
			view.dispose();
		}
	});

	it("does not delete or stop a replacement selection before it has been drawn", async () => {
		const { view, manager, render } = setup([agent("first", "completed"), agent("second", "completed")]);
		try {
			expect(render()[1]).toContain("first");
			view.handleInput("\x04");
			await Promise.resolve();
			expect(manager.remove.mock.calls).toEqual([["first"]]);
			view.handleInput("\x04");
			await Promise.resolve();
			view.handleInput("\x13");
			await Promise.resolve();
			expect(manager.remove.mock.calls).toEqual([["first"]]);
			expect(manager.cancel).not.toHaveBeenCalled();
			expect(render()[1]).toContain("second");
			view.handleInput("\x04");
			expect(manager.remove.mock.calls).toEqual([["first"], ["second"]]);
		} finally {
			view.dispose();
		}
	});

	it("drops the ID before shortening the task label in a narrow split", () => {
		const entry = { ...agent("deadbeef", "completed"), label: "Fix tests" };
		const { view, render } = setup([entry]);
		try {
			const row = stripAnsi(view.render(40, 24)[1]);
			expect(row).toContain("Fix tests");
			expect(row).toContain("completed");
			expect(row).not.toContain(entry.id);
			expect(visibleWidth(row)).toBeLessThanOrEqual(40);
			expect(render()[1]).toContain(entry.id);
		} finally {
			view.dispose();
		}
	});

	it("measures live role/status prefixes instead of assuming fixed glyph widths", () => {
		const entry = agent("12345678", "completed");
		const { view, render } = setup([entry]);
		try {
			for (const preset of ["unicode", "nerd", "unicode"] as const) {
				setIconPreset(preset);
				const prefix = `${icon("statusDot")}  ${iconPrefix("agentWorker")}`;
				expect(render()[1]).toContain(`└─ ${prefix}worker`);
				view.handleInput("\r");
				expect(render()[0]).toBe(prefix + entry.label);
				for (const width of [0, 1, 2, 4, 10, 20, 100])
					expect(visibleWidth(view.render(width, 24)[0])).toBeLessThanOrEqual(width);
				view.handleInput("\x1b");
			}
		} finally {
			view.dispose();
		}
	});
});
