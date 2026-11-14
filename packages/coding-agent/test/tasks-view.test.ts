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
import {
	renderTasksCall,
	renderTasksResult,
	taskStateText,
	taskSummary,
	taskTreeLeaves,
} from "../src/core/tasks/render.ts";
import { TASKS_ENTRY_TYPE, type Task, TaskStore } from "../src/core/tasks/state.ts";
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

function renderContext(): ToolRenderContext<unknown, unknown> {
	return {
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
			const { bar, store } = fixture();
			store.apply({ action: "update", updates: [{ id: 2, parentId: 1 }] }, () => {});
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

	it("orders later-added descendants into a connected forest with direct-child progress", () => {
		const { store, bar, view } = fixture();
		store.apply(
			{
				action: "add",
				tasks: [
					{ title: "First child", parentId: 1 },
					{ title: "Second child", parentId: 1, status: "completed" },
					{ title: "Cancelled child", parentId: 1, status: "cancelled" },
					{ title: "Other child", parentId: 2 },
				],
			},
			() => {},
		);
		store.apply(
			{
				action: "add",
				tasks: [
					{ title: "Grandchild", parentId: 5 },
					{ title: "Grandchild sibling", parentId: 5 },
				],
			},
			() => {},
		);
		const snapshot = store.getSnapshot();
		const before = JSON.stringify(snapshot);
		const rows = taskTreeLeaves(snapshot.tasks, 160, theme).map(stripVTControlCharacters);
		expect(rows.map((line) => Number(line.match(/#(\d+)/u)?.[1]))).toEqual([1, 5, 9, 10, 6, 7, 2, 8, 3, 4]);
		expect(rows[0]).toBe(`   ├─ ${iconPrefix("checkboxChecked")}#1 Finished · children 1/2 completed · 1 cancelled`);
		expect(rows[1]).toBe(`   │  ├─ ${iconPrefix("checkboxUnchecked")}#5 First child · children 0/2 completed`);
		expect(rows[2]).toBe(`   │  │  ├─ ${iconPrefix("checkboxUnchecked")}#9 Grandchild`);
		expect(rows[3]).toBe(`   │  │  └─ ${iconPrefix("checkboxUnchecked")}#10 Grandchild sibling`);
		expect(rows[5]).toContain(`   │  └─ ${iconPrefix("checkboxCancelled")}#7 Cancelled child (cancelled)`);
		expect(rows[7]).toBe(`   │  └─ ${iconPrefix("checkboxUnchecked")}#8 Other child`);
		expect(rows[9]).toBe(`   └─ ${iconPrefix("checkboxCancelled")}#4 Obsolete (cancelled)`);
		expect(taskSummary(snapshot)).toBe("2/8 completed · 1 active · 2 cancelled");
		bar.handleInput("\x1bOR");
		expect(plain(bar.render(160))).toContain("#9 Grandchild");
		expect(plain(view.render(160, 30))).toContain(rows.join("\n"));
		// A completed parent still exposes all unfinished children; rendering never changes statuses.
		expect(JSON.stringify(store.getSnapshot())).toBe(before);
	});

	it("keeps parent statuses independent when every child is done or cancelled", () => {
		const { store } = fixture();
		store.apply(
			{
				action: "add",
				tasks: [
					{ title: "Done child", parentId: 2, status: "completed" },
					{ title: "Skipped child", parentId: 2, status: "cancelled" },
					{ title: "Only cancelled", parentId: 3, status: "cancelled" },
					{ title: "Unfinished beneath cancellation", parentId: 4 },
				],
			},
			() => {},
		);
		const lines = taskTreeLeaves(store.getSnapshot().tasks, 160, theme);
		const active = lines.find((line) => stripVTControlCharacters(line).includes("#2 Working"))!;
		expect(active).toContain(theme.fg("accent", theme.bold("#2 Working")));
		expect(stripVTControlCharacters(active)).toContain("children 1/1 completed · 1 cancelled");
		expect(plain(lines)).toContain("#3 Next · children 0/0 completed · 1 cancelled");
		expect(plain(lines)).toContain("#4 Obsolete (cancelled) · children 0/1 completed");
		expect(plain(lines)).toContain("#8 Unfinished beneath cancellation");
	});

	it.each(["unicode", "nerd"] as const)(
		"hangs wrapped grandchildren under the correct ancestor guides (%s)",
		(preset) => {
			setIconPreset(preset);
			const tasks: Task[] = [
				{ id: 1, title: "Root", status: "pending" },
				{ id: 2, title: "Other root", status: "pending" },
				{ id: 3, title: "Child", status: "pending", parentId: 1 },
				{ id: 4, title: "Sibling", status: "pending", parentId: 1 },
				{ id: 5, title: "日本語 label wrapped across several terminal lines", status: "pending", parentId: 3 },
				{ id: 6, title: "Grandchild sibling", status: "pending", parentId: 3 },
			];
			const rows = taskTreeLeaves(tasks, 40, theme).map(stripVTControlCharacters);
			const start = rows.findIndex((line) => line.includes("#5"));
			const end = rows.findIndex((line) => line.includes("#6"));
			expect(rows[start]).toContain(`   │  │  ├─ ${iconPrefix("checkboxUnchecked")}#5`);
			expect(end - start).toBeGreaterThan(1);
			for (const row of rows.slice(start + 1, end))
				expect(row.startsWith(`   │  │  │  ${" ".repeat(visibleWidth(iconPrefix("checkboxUnchecked")))}`)).toBe(
					true,
				);
			for (const width of [0, 1, 2, 3, 5, 9, 12, 20, 40])
				for (const row of taskTreeLeaves(tasks, width, theme)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		},
	);

	it("keeps compact current and next parents as work, with child context on the selected row", () => {
		const { store, bar } = fixture();
		store.apply({ action: "add", tasks: [{ title: "Child work", parentId: 3, status: "in_progress" }] }, () => {});
		// The earlier active parent remains current; selection is not silently restricted to leaves.
		expect(plain(bar.render(120))).toContain(`now ${iconPrefix("checkboxUnchecked")}#2 Working`);
		expect(plain(bar.render(120))).toContain(`next ${iconPrefix("checkboxUnchecked")}#3 Next`);
		store.apply({ action: "update", updates: [{ id: 2, status: "completed" }] }, () => {});
		expect(plain(bar.render(120))).toContain(`now ${iconPrefix("checkboxUnchecked")}#5 (parent #3) Child work`);
		expect(plain(bar.render(120))).toContain(`next ${iconPrefix("checkboxUnchecked")}#3 Next`);
	});

	it("bounds very deep guides without recursion and keeps deepest selections in tiny widgets", () => {
		const { store, controls } = fixture();
		const tasks: Task[] = Array.from({ length: 12000 }, (_, index) => ({
			id: index + 1,
			title: index === 11999 ? "Deep current" : "Ancestor",
			status: index === 11999 ? "in_progress" : "completed",
			...(index ? { parentId: index } : {}),
		}));
		tasks.push({ id: 12001, title: "Deep next", status: "pending", parentId: 11999 });
		store.restore([
			{
				type: "custom",
				customType: TASKS_ENTRY_TYPE,
				id: "deep-tasks",
				parentId: null,
				timestamp: new Date().toISOString(),
				data: { version: 1, revision: 1, nextId: 12002, tasks },
			},
		]);
		const before = JSON.stringify(store.getSnapshot());
		const lines = taskTreeLeaves(tasks, 40, theme);
		expect(plain(lines)).toContain("#12000");
		expect(plain(lines)).toContain(" … ");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		for (const rows of [3, 6, 9, 12]) {
			const bar = new TasksBar(
				store,
				{ expanded: false, scroll: 0 },
				() => rows,
				() => {},
				() => theme,
			);
			disposers.push(() => bar.dispose());
			const rendered = bar.render(100);
			expect(rendered.length).toBeLessThanOrEqual(Math.floor(rows / 3));
			expect(plain(rendered)).toContain("#12000 (parent #11999) Deep current");
			if (rows >= 6) expect(plain(rendered)).toContain("#12001 (parent #11999) Deep next");
		}
		expect(controls.invalidate).toHaveBeenCalled();
		expect(JSON.stringify(store.getSnapshot())).toBe(before);
	});

	it("pages descendants inserted before later roots in both expanded views", () => {
		const { store, bar, view } = fixture();
		store.apply(
			{
				action: "add",
				tasks: Array.from({ length: 30 }, (_, index) => ({ title: `Descendant ${index}`, parentId: 1 })),
			},
			() => {},
		);
		bar.handleInput("\x1bOR");
		view.render(120, 10);
		const widgetPages: string[] = [];
		const panePages: string[] = [];
		for (let index = 0; index < 10; index++) {
			widgetPages.push(plain(bar.render(120)));
			panePages.push(plain(view.render(120, 10)));
			bar.handleInput("\x1b[6;3~");
			view.handleInput("\x1b[6~");
		}
		for (let index = 0; index < 30; index++) {
			expect(widgetPages.join("\n")).toContain(`Descendant ${index}`);
			expect(panePages.join("\n")).toContain(`Descendant ${index}`);
		}
		expect(widgetPages.at(-1)).toContain("#2 Working");
		expect(panePages.at(-1)).toContain("#4 Obsolete");
	});

	it("sanitizes nested titles without retaining ANSI, OSC8 links, or control characters", () => {
		const { store, bar, view } = fixture();
		store.apply(
			{
				action: "update",
				updates: [
					{
						id: 2,
						parentId: 1,
						title: "\x1b[2J\x1b]8;;https://hostile.test\x07Nested\x1b]8;;\x07\x00\x07\n\t日本語",
					},
				],
			},
			() => {},
		);
		bar.handleInput("\x1bOR");
		for (const rendered of [bar.render(160), view.render(160, 20)]) {
			expect(plain(rendered)).toContain("#2 Nested  日本語");
			expect(rendered.join("\n")).not.toContain("hostile.test");
			expect(rendered.join("\n")).not.toContain("\x1b]8;");
			expect(rendered.join("\n")).not.toContain("\x00");
			expect(rendered.join("\n")).not.toContain("\x07");
		}
	});

	it("includes explicit stable parent IDs in model-facing evidence without changing root rows", () => {
		const { store } = fixture();
		store.apply(
			{
				action: "update",
				updates: [
					{ id: 2, parentId: 1 },
					{ id: 3, parentId: 2 },
				],
			},
			() => {},
		);
		const text = taskStateText(store.getSnapshot());
		expect(text).toContain('#1 [completed] "Finished"\n');
		expect(text).toContain('#2 [in_progress] "Working" (parent #1)');
		expect(text).toContain('#3 [pending] "Next" (parent #2)');
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
		store.apply({ action: "update", updates: [{ id: 2, parentId: 1 }] }, () => {});
		const tool = createTasksToolDefinition(
			store,
			() => {},
			() => {},
		);
		const context = renderContext();
		const result = {
			content: [{ type: "text" as const, text: "Original model evidence" }],
			details: { action: "list", snapshot: store.getSnapshot() },
			structuredContent: { snapshot: store.getSnapshot() },
		};
		const before = JSON.stringify(result);
		expect(tool.renderShell).toBeUndefined();
		expect(plain(renderTasksCall({}, theme, context).render(100))).toContain(`${icon("tasks")} Tasks`);
		expect(plain(renderTasksCall({ action: "list" }, theme, context).render(100))).toContain(
			`${icon("tasks")} List tasks`,
		);
		const compact = renderTasksResult(result, { expanded: false, isPartial: false }, theme, context).render(100);
		expect(plain(compact)).not.toContain('"snapshot"');
		expect(plain(compact)).toContain("#2 (parent #1) Working");
		const expanded = renderTasksResult(result, { expanded: true, isPartial: false }, theme, {
			...context,
			expanded: true,
		}).render(100);
		expect(plain(expanded)).toContain("Original model evidence");
		expect(plain(expanded)).toContain('"snapshot"');
		expect(plain(expanded)).toContain('"parentId": 1');
		expect(plain(expanded)).toContain("Structured content:");
		expect(JSON.stringify(result)).toBe(before);
	});

	it.each([
		{ name: "cycle", parents: [2, 1] },
		{ name: "missing parent", parents: [3, undefined] },
		{ name: "self parent", parents: [1, undefined] },
	])("falls back to original text for structurally valid unknown details with $name", ({ parents }) => {
		const result = {
			content: [{ type: "text" as const, text: "Raw historical evidence" }],
			details: {
				action: "list",
				snapshot: {
					version: 1,
					revision: 1,
					nextId: 3,
					tasks: parents.map((parentId, index) => ({
						id: index + 1,
						title: "Unknown graph",
						status: "in_progress",
						...(parentId === undefined ? {} : { parentId }),
					})),
				},
			},
		};
		const compact = renderTasksResult(result, { expanded: false, isPartial: false }, theme, renderContext());
		expect(plain(compact.render(100))).toContain("Raw historical evidence");
		expect(plain(compact.render(100))).not.toContain("completed");
		expect(plain(compact.render(100))).not.toContain("Unknown graph");
		const expanded = renderTasksResult(result, { expanded: true, isPartial: false }, theme, renderContext());
		expect(plain(expanded.render(100))).toContain("Raw historical evidence");
		expect(plain(expanded.render(100))).toContain('"parentId"');
	});
});
