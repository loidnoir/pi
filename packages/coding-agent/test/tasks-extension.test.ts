import { type Component, setKeybindings, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	ExtensionUIContext,
	TerminalInputHandler,
} from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { openPane, type PaneHandle } from "../src/core/panes/host.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { restoreTasks, TASKS_ENTRY_TYPE } from "../src/core/tasks/state.ts";
import { createTasksExtension } from "../src/extensions/tasks/index.ts";
import { getThemeByName, initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createTestUiContext } from "./suite/harness.ts";

vi.mock("../src/core/panes/host.ts", () => ({ openPane: vi.fn() }));

function fakePane() {
	const closed = Promise.withResolvers<void>();
	const handle: PaneHandle = {
		backend: "rex",
		placement: "floating",
		closed: closed.promise,
		close: vi.fn(async () => closed.resolve()),
		show: vi.fn(async () => {}),
		minimize: vi.fn(async () => {}),
	};
	return { handle, closed };
}

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	vi.mocked(openPane).mockReset();
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const session = SessionManager.inMemory();
	session.appendCustomEntry(TASKS_ENTRY_TYPE, {
		version: 1,
		revision: 1,
		nextId: 2,
		tasks: [{ id: 1, title: "Initial", status: "in_progress" }],
	});
	const runtime = createExtensionRuntime();
	runtime.appendEntry = (type, data) => {
		session.appendCustomEntry(type, data);
	};
	const extension = await loadExtensionFromFactory(createTasksExtension(), "/tmp", createEventBus(), runtime);
	const tui = new TuiMainScreen(new VirtualTerminal(100, 30));
	const widgets: Array<Component | undefined> = [];
	let input: TerminalInputHandler | undefined;
	const unsubscribe = vi.fn();
	const widget = vi.fn((key: string, content: unknown) => {
		expect(key).toBe("tasks");
		// This fixture exercises the task extension's known component-factory overload.
		widgets.push(
			content ? (content as (tui: TUI, theme: Theme) => Component)(tui, getThemeByName("dark")!) : undefined,
		);
	});
	const ui: ExtensionUIContext = createTestUiContext({
		setWidget: widget,
		onTerminalInput: (handler) => {
			input = handler;
			return () => {
				input = undefined;
				unsubscribe();
			};
		},
	});
	const context = { mode: "tui", cwd: "/tmp", sessionManager: session, ui } as unknown as ExtensionContext;
	const emit = async (type: string, event: unknown = { type }) => {
		for (const handler of extension.handlers.get(type) ?? []) await handler(event, context);
	};
	const command = extension.commands.get("tasks")!;
	const present = (args = "") => command.handler(args, context as ExtensionCommandContext);
	const execute = (args: object) =>
		extension.tools
			.get("tasks")!
			.definition.execute("task", args, undefined, undefined, context as ExtensionToolContext);
	await emit("session_start");
	cleanups.push(() => emit("session_shutdown"));
	return {
		session,
		extension,
		context,
		emit,
		present,
		execute,
		widgets,
		widget,
		unsubscribe,
		input: (data: string) => input?.(data),
	};
}

describe("tasks widget and pane lifetime", () => {
	it("refreshes an existing widget from the live UI theme after a real theme switch", async () => {
		const test = await fixture();
		const widget = test.widgets.at(-1)!;
		const dark = widget.render(160);
		initTheme("light");
		widget.invalidate();
		expect(test.widgets.at(-1)).toBe(widget);
		expect(widget.render(160)).not.toEqual(dark);
		const [header] = widget.render(160);
		expect(header).toContain(theme.fg("accent", theme.bold("Tasks")));
		expect(stripAnsi(header)).toBe("Tasks · 0/1 completed · 1 active");
	});

	it("hides while opening and minimized, reuses the view, and restores latest state only on close", async () => {
		const deferred = Promise.withResolvers<PaneHandle>();
		const { handle, closed } = fakePane();
		vi.mocked(openPane).mockReturnValue(deferred.promise);
		const test = await fixture();
		expect(test.input("draft")).toBeUndefined();
		expect(test.input("\x1bOR")).toEqual({ consume: true });
		const opening = test.present("--rex --floating --minimized");
		expect(test.widgets.at(-1)).toBeUndefined();
		expect(test.input("\x1bOR")).toBeUndefined();
		const repeated = test.present();
		deferred.resolve(handle);
		await Promise.all([opening, repeated]);
		expect(openPane).toHaveBeenCalledOnce();
		expect(vi.mocked(openPane).mock.calls[0][1]).toMatchObject({
			backend: "rex",
			placement: "floating",
			minimized: true,
		});
		await test.execute({
			action: "update",
			updates: [{ id: 1, title: "Current while hidden", status: "completed" }],
		});
		await test.present("--minimized");
		expect(handle.minimize).toHaveBeenCalledOnce();
		expect(test.widgets.at(-1)).toBeUndefined();
		closed.resolve();
		await Promise.resolve();
		expect(test.widgets.at(-1)?.render(160).join("\n")).toContain("Current while hidden");
		expect(test.input("\x1bOR")).toEqual({ consume: true });
	});

	it("restores on open failure without losing the editor or changing task state", async () => {
		vi.mocked(openPane).mockRejectedValue(new Error("Pane unavailable"));
		const test = await fixture();
		await expect(test.present("--tui")).rejects.toThrow("Pane unavailable");
		expect(test.widgets.at(-1)?.render(160).join("\n")).toContain("Initial");
		expect(
			test.session.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TASKS_ENTRY_TYPE),
		).toHaveLength(1);
	});

	it("never restores an old session widget after shutdown while its pane opens", async () => {
		const deferred = Promise.withResolvers<PaneHandle>();
		const { handle } = fakePane();
		vi.mocked(openPane).mockReturnValue(deferred.promise);
		const test = await fixture();
		const opening = test.present();
		const stopping = test.emit("session_shutdown");
		deferred.resolve(handle);
		await Promise.all([opening, stopping]);
		expect(handle.close).toHaveBeenCalledOnce();
		expect(test.widgets.at(-1)).toBeUndefined();
		expect(test.unsubscribe).toHaveBeenCalledOnce();
		expect(test.input("\x1bOR")).toBeUndefined();
	});

	it("closes the old branch pane and restores only the selected branch's widget", async () => {
		const { handle, closed } = fakePane();
		vi.mocked(openPane).mockResolvedValue(handle);
		const test = await fixture();
		const root = test.session.getLeafId()!;
		await test.execute({ action: "update", updates: [{ id: 1, title: "Abandoned" }] });
		await test.present();
		test.session.branch(root);
		await test.emit("session_tree");
		closed.resolve();
		await Promise.resolve();
		expect(handle.close).toHaveBeenCalledOnce();
		expect(test.widgets.at(-1)?.render(160).join("\n")).toContain("Initial");
		expect(test.widgets.at(-1)?.render(160).join("\n")).not.toContain("Abandoned");
	});

	it("restores nested relationships and rendering from only the selected branch", async () => {
		const test = await fixture();
		await test.execute({ action: "add", tasks: [{ title: "Child", parentId: 1 }, { title: "Other parent" }] });
		await test.execute({ action: "add", tasks: [{ title: "Grandchild", parentId: 2, status: "in_progress" }] });
		const root = test.session.getLeafId()!;
		const expected = restoreTasks(test.session.getBranch());
		expect(expected.tasks).toEqual([
			{ id: 1, title: "Initial", status: "in_progress" },
			{ id: 2, title: "Child", status: "pending", parentId: 1 },
			{ id: 3, title: "Other parent", status: "pending" },
			{ id: 4, title: "Grandchild", status: "in_progress", parentId: 2 },
		]);
		expect(test.input("\x1bOR")).toEqual({ consume: true });
		const originalRows = stripAnsi(test.widgets.at(-1)!.render(160).join("\n"));
		for (const label of ["#1 Initial", "#2 Child", "#3 Other parent", "#4 Grandchild"])
			expect(originalRows).toContain(label);
		expect(originalRows.indexOf("#2 Child")).toBeLessThan(originalRows.indexOf("#4 Grandchild"));
		expect(originalRows.indexOf("#4 Grandchild")).toBeLessThan(originalRows.indexOf("#3 Other parent"));

		await test.execute({ action: "update", updates: [{ id: 2, parentId: 3 }] });
		const movedRows = stripAnsi(test.widgets.at(-1)!.render(160).join("\n"));
		for (const label of ["#3 Other parent", "#2 Child", "#4 Grandchild"]) expect(movedRows).toContain(label);
		expect(movedRows.indexOf("#3 Other parent")).toBeLessThan(movedRows.indexOf("#2 Child"));
		expect(restoreTasks(test.session.getBranch()).tasks[3].parentId).toBe(2);

		test.session.branch(root);
		await test.emit("session_tree");
		expect(restoreTasks(test.session.getBranch())).toEqual(expected);
		expect(stripAnsi(test.widgets.at(-1)!.render(160).join("\n"))).toBe(originalRows);
	});

	it("disables tasks and UI for native child sessions without altering parent state", async () => {
		const test = await fixture();
		await test.emit("session_shutdown");
		test.session.appendCustomEntry("pi.subagent", { parentSessionId: "parent" });
		await test.emit("session_start");
		expect(test.extension.tools.get("tasks")!.definition.exposure).toBe("hidden");
		expect(test.widgets.at(-1)).toBeUndefined();
		await expect(test.execute({ action: "add", tasks: [{ title: "Invisible child plan" }] })).rejects.toThrow(
			"main conversation",
		);
		expect(openPane).not.toHaveBeenCalled();
	});
});
