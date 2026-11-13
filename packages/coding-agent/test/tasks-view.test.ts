import { stripVTControlCharacters } from "node:util";
import {
	Editor,
	getKeybindings,
	setKeybindings,
	TuiAltScreen,
	TuiMainScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PaneControls } from "../src/core/panes/host.ts";
import { renderTasksCall, renderTasksResult, taskSummary, taskTreeLeaves } from "../src/core/tasks/render.ts";
import { TaskStore } from "../src/core/tasks/state.ts";
import { createTasksToolDefinition } from "../src/core/tasks/tool.ts";
import { TasksBar, type TasksBarState, TasksView } from "../src/core/tasks/view.ts";
import { icon, iconPrefix, setIconPreset } from "../src/modes/interactive/icons.ts";
import { getEditorTheme, initTheme, setTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const disposers: Array<() => void> = [];
let previousKeys: ReturnType<typeof getKeybindings>;
let previousStyleLevel = chalk.level;
beforeEach(() => {
	previousStyleLevel = chalk.level;
	chalk.level = 3;
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
	setIconPreset("unicode");
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	setKeybindings(previousKeys);
	chalk.level = previousStyleLevel;
	setIconPreset("unicode");
	setTheme("dark");
});

function plain(lines: string[]): string {
	return lines.map(stripVTControlCharacters).join("\n");
}

function fixture() {
	const store = new TaskStore();
	store.apply(
		{
			action: "add",
			tasks: [
				{ title: "Finished", status: "completed" },
				{ title: "Working", status: "in_progress" },
				{ title: "Next", status: "pending" },
				{ title: "Obsolete", status: "cancelled" },
			],
		},
		() => {},
	);
	const controls: PaneControls = {
		invalidate: vi.fn(),
		close: vi.fn(),
		minimize: vi.fn(async () => {}),
		setTitle: vi.fn(async () => {}),
	};
	const view = new TasksView(store, controls);
	const state: TasksBarState = { expanded: false, scroll: 0 };
	const render = vi.fn();
	const bar = new TasksBar(
		store,
		state,
		() => 30,
		render,
		() => theme,
	);
	disposers.push(() => {
		bar.dispose();
		view.dispose();
	});
	return { store, controls, view, bar, state, render };
}

describe("task tree monitors", () => {
	it.each(["regular", "fullscreen"])("keeps the editor draft mounted during %s task expansion and paging", (mode) => {
		const { bar } = fixture();
		const terminal = new VirtualTerminal(80, 24);
		const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
		const editor = new Editor(tui, getEditorTheme());
		editor.setText("Unsubmitted 日本語 draft");
		tui.addChild(bar);
		tui.addChild(editor);
		tui.setFocus(editor);
		bar.handleInput("\x1bOR");
		bar.handleInput("\x1b[6;3~");
		expect(plain(tui.render(80))).toContain("TODO");
		expect(plain(tui.render(80))).toContain("Unsubmitted 日本語 draft");
		expect(editor.getText()).toBe("Unsubmitted 日本語 draft");
		const extra = " preserved";
		if (!bar.handleInput(extra)) editor.handleInput(extra);
		expect(editor.getText()).toBe("Unsubmitted 日本語 draft preserved");
	});

	it("shows compact current/next work and retains finished history on expansion", () => {
		const { bar, store, render } = fixture();
		expect(plain(bar.render(160))).toContain("TODO\n└─ Tasks · 1/3 completed · 1 active · 1 cancelled");
		expect(plain(bar.render(160))).toContain("Working");
		expect(plain(bar.render(160))).not.toContain("Finished");
		expect(bar.handleInput("\x1bOR")).toBe(true);
		expect(plain(bar.render(160))).toContain("Finished");
		expect(plain(bar.render(160))).toContain("Obsolete (cancelled)");
		store.apply(
			{
				action: "update",
				updates: [
					{ id: 2, status: "completed" },
					{ id: 3, status: "completed" },
				],
			},
			() => {},
		);
		expect(render).toHaveBeenCalled();
		bar.handleInput("\x1bOR");
		expect(plain(bar.render(160))).toContain("3/3 completed · 1 cancelled");
		expect(bar.handleInput("\x1bOR")).toBe(true);
		expect(plain(bar.render(160))).toContain("Finished");
		expect(taskSummary(store.getSnapshot())).not.toContain("4/4");
	});

	it("bounds the expanded widget and pages every retained task without taking editor keys", () => {
		const { bar, store, state } = fixture();
		store.apply(
			{ action: "add", tasks: Array.from({ length: 40 }, (_, index) => ({ title: `Retained ${index}` })) },
			() => {},
		);
		bar.handleInput("\x1bOR");
		expect(bar.render(100).length).toBeLessThanOrEqual(10);
		expect(bar.handleInput("draft text")).toBe(false);
		expect(bar.handleInput("\x1b[B")).toBe(false);
		for (let index = 0; index < 20; index++) {
			bar.handleInput("\x1b[6;3~");
			bar.render(100);
		}
		expect(plain(bar.render(100))).toContain("Retained 39");
		expect(state.scroll).toBeGreaterThan(0);
		for (let index = 0; index < 20; index++) {
			bar.handleInput("\x1b[5;3~");
			bar.render(100);
		}
		expect(plain(bar.render(100))).toContain("Finished");
	});

	it("uses configurable pinned and pane actions rather than fixed terminal keys", async () => {
		setKeybindings(
			new KeybindingsManager({
				"app.tasks.expand": "ctrl+y",
				"app.tasks.pageDown": "ctrl+n",
				"tui.select.down": "ctrl+j",
				"tui.select.cancel": "ctrl+q",
				"app.pane.minimize": "ctrl+m",
			}),
		);
		const { bar, view, controls } = fixture();
		expect(bar.handleInput("\x1bOR")).toBe(false);
		expect(bar.handleInput("\x19")).toBe(true);
		expect(plain(bar.render(160))).toContain("ctrl+y collapse");
		view.render(80, 5);
		view.handleInput("\n");
		expect(plain(view.render(80, 5))).not.toContain("Finished");
		view.handleInput("\r");
		await Promise.resolve();
		expect(controls.minimize).toHaveBeenCalledOnce();
		view.handleInput("\x11");
		expect(controls.close).toHaveBeenCalledOnce();
	});

	it.each(["unicode", "nerd"] as const)(
		"uses live %s icons, checked/struck completion and bright unchecked activity",
		(preset) => {
			const { bar } = fixture();
			setIconPreset(preset);
			bar.handleInput("\x1bOR");
			const lines = bar.render(160);
			const done = lines.find((line) => stripVTControlCharacters(line).includes("Finished"))!;
			const active = lines.find((line) => stripVTControlCharacters(line).includes("Working"))!;
			expect(done).toContain(theme.fg("success", iconPrefix("checkboxChecked")));
			expect(done).toContain("\x1b[9m");
			expect(active).toContain(theme.fg("accent", iconPrefix("checkboxUnchecked")));
			expect(active).toContain("\x1b[1m");
			expect(active).not.toContain("\x1b[9m");
			expect(done).toContain(theme.fg("success", theme.strikethrough("#1 Finished")));
			const cancelled = lines.find((line) => stripVTControlCharacters(line).includes("Obsolete"))!;
			expect(cancelled).toContain(theme.fg("muted", iconPrefix("checkboxCancelled")));
			expect(cancelled).toContain("(cancelled)");
			const dark = lines.join("\n");
			setTheme("light");
			bar.invalidate();
			expect(bar.render(160).join("\n")).not.toBe(dark);
		},
	);

	it.each(["unicode", "nerd"] as const)("fits zero/narrow/CJK widths with hanging label wraps (%s)", (preset) => {
		const { bar, view, store } = fixture();
		setIconPreset(preset);
		store.apply(
			{ action: "update", updates: [{ id: 2, title: "日本語の長い作業内容 and combining e\u0301" }] },
			() => {},
		);
		bar.handleInput("\x1bOR");
		for (const width of [0, 1, 2, 3, 5, 9, 10, 12, 20, 40, 100]) {
			for (const lines of [bar.render(width), view.render(width, 10)]) {
				expect(lines.length).toBeLessThanOrEqual(10);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		const wrapped = plain(taskTreeLeaves(store.getSnapshot().tasks, 28, theme));
		expect(wrapped).toContain("   │  ");
		expect(plain(view.render(160, 10))).toContain("Obsolete (cancelled)");
	});

	it.each(["unicode", "nerd"] as const)("aligns wrapped task labels to the one-space %s checkbox prefix", (preset) => {
		setIconPreset(preset);
		const lines = taskTreeLeaves(
			[{ id: 1, title: "日本語 task title wrapped across several lines", status: "pending" }],
			24,
			theme,
		).map(stripVTControlCharacters);
		const prefix = `   └─ ${iconPrefix("checkboxUnchecked")}`;
		expect(lines[0].startsWith(`${prefix}#1`)).toBe(true);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines.slice(1)) expect(line.startsWith(" ".repeat(visibleWidth(prefix)))).toBe(true);
	});

	it("scrolls the full pane live and unsubscribes on disposal", () => {
		const { store, view, controls, bar, render } = fixture();
		store.apply(
			{ action: "add", tasks: Array.from({ length: 25 }, (_, index) => ({ title: `Pane ${index}` })) },
			() => {},
		);
		view.render(100, 8);
		for (let index = 0; index < 10; index++) {
			view.handleInput("\x1b[6~");
			view.render(100, 8);
		}
		expect(plain(view.render(100, 8))).toContain("Pane 24");
		view.dispose();
		bar.dispose();
		vi.mocked(controls.invalidate).mockClear();
		render.mockClear();
		store.apply({ action: "update", updates: [{ id: 1, title: "No observer" }] }, () => {});
		expect(controls.invalidate).not.toHaveBeenCalled();
		expect(render).not.toHaveBeenCalled();
	});

	it("renders compact native task calls and expands original details with the default shell", async () => {
		const { store } = fixture();
		const tool = createTasksToolDefinition(
			store,
			() => {},
			() => {},
		);
		const context: ToolRenderContext<unknown, unknown> = {
			args: { action: "list" },
			toolCallId: "tasks-call",
			state: {},
			lastComponent: undefined,
			invalidate: () => {},
			cwd: "/tmp",
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
			durationMs: 1,
			outputPad: 2,
			keyText: () => "ctrl+o",
			keyHint: (_key, description) => `ctrl+o ${description}`,
		};
		const result = {
			content: [{ type: "text" as const, text: "Original model evidence" }],
			details: { action: "list", snapshot: store.getSnapshot() },
		};
		expect(tool.renderShell).toBeUndefined();
		expect(plain(renderTasksCall({}, theme, context).render(100))).toContain(`${icon("tasks")} Tasks`);
		expect(plain(renderTasksCall({ action: "list" }, theme, context).render(100))).toContain(
			`${icon("tasks")} List tasks`,
		);
		const compact = renderTasksResult(result, { expanded: false, isPartial: false }, theme, context).render(100);
		expect(plain(compact)).not.toContain('"snapshot"');
		const expanded = renderTasksResult(result, { expanded: true, isPartial: false }, theme, {
			...context,
			expanded: true,
		}).render(100);
		expect(plain(expanded)).toContain("Original model evidence");
		expect(plain(expanded)).toContain('"snapshot"');
	});
});
