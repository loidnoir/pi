// Native main-session task planning, branch restoration, and view-only progress monitors.
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { parsePaneCommand } from "../../core/panes/command.ts";
import { openPane, type PaneHandle, type PaneOptions } from "../../core/panes/host.ts";
import { taskStateText } from "../../core/tasks/render.ts";
import { TASKS_ENTRY_TYPE, TaskStore } from "../../core/tasks/state.ts";
import { createTasksToolDefinition } from "../../core/tasks/tool.ts";
import { TasksBar, type TasksBarState, TasksView } from "../../core/tasks/view.ts";

/** Register branch-persisted tasks and /tasks, with no execution or automatic delegation. */
export function createTasksExtension(): ExtensionFactory {
	return (pi) => {
		const store = new TaskStore();
		const barState: TasksBarState = { expanded: false, scroll: 0 };
		let lifetime = new AbortController();
		let pane: PaneHandle | undefined;
		let opening: Promise<PaneHandle> | undefined;
		let bar: TasksBar | undefined;
		let widgetVisible = false;
		let paneVisible = false;
		let unsubscribeInput: (() => void) | undefined;
		let initialized = false;
		let child = false;
		let restoreError: string | undefined;

		const tool = createTasksToolDefinition(
			store,
			(snapshot) => pi.appendEntry(TASKS_ENTRY_TYPE, snapshot),
			() => {
				if (child) throw new Error("tasks belongs to the main conversation, not native sub-agent sessions");
				if (restoreError) throw new Error(restoreError);
				if (lifetime.signal.aborted) throw new Error("Tasks session is closed");
			},
		);
		pi.registerTool(tool);

		function clearWidget(ctx: ExtensionContext): void {
			bar?.dispose();
			bar = undefined;
			if (widgetVisible) ctx.ui.setWidget("tasks", undefined);
			widgetVisible = false;
		}

		function showWidget(ctx: ExtensionContext): void {
			if (ctx.mode !== "tui" || child || restoreError || lifetime.signal.aborted || paneVisible || widgetVisible)
				return;
			widgetVisible = true;
			ctx.ui.setWidget(
				"tasks",
				(tui) => {
					bar = new TasksBar(
						store,
						barState,
						() => tui.terminal.rows,
						() => tui.requestRender(),
						() => ctx.ui.theme,
					);
					return bar;
				},
				{ placement: "aboveEditor" },
			);
		}

		function restore(ctx: ExtensionContext): void {
			const wasChild = child;
			initialized = true;
			child = ctx.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "pi.subagent");
			if (child !== wasChild) pi.registerTool({ ...tool, exposure: child ? "hidden" : "direct" });
			restoreError = undefined;
			try {
				store.restore(ctx.sessionManager.getBranch());
			} catch (error) {
				restoreError = `Cannot restore tasks: ${error instanceof Error ? error.message : String(error)}`;
				clearWidget(ctx);
				ctx.ui.notify(restoreError, "error");
			}
			showWidget(ctx);
		}

		async function present(
			ctx: ExtensionContext,
			options: Pick<PaneOptions, "backend" | "placement" | "minimized">,
		): Promise<void> {
			if (!initialized) restore(ctx);
			if (child) throw new Error("/tasks is available only in the main conversation");
			if (restoreError) throw new Error(restoreError);
			const owner = lifetime;
			const existing = pane ?? (opening ? await opening : undefined);
			if (owner.signal.aborted) return;
			if (existing) {
				if (options.minimized) await existing.minimize();
				else await existing.show();
				return;
			}
			paneVisible = true;
			clearWidget(ctx);
			const pending = openPane(ctx, {
				...options,
				title: "Session tasks",
				signal: owner.signal,
				create: (controls) => new TasksView(store, controls),
			});
			opening = pending;
			try {
				const opened = await pending;
				if (owner.signal.aborted) return;
				pane = opened;
				void opened.closed.then(() => {
					if (owner !== lifetime || owner.signal.aborted || pane !== opened) return;
					pane = undefined;
					paneVisible = false;
					showWidget(ctx);
				});
			} finally {
				if (opening === pending) opening = undefined;
				if (owner === lifetime && !owner.signal.aborted && !pane) {
					paneVisible = false;
					showWidget(ctx);
				}
			}
		}

		async function stopUI(ctx: ExtensionContext): Promise<void> {
			lifetime.abort();
			unsubscribeInput?.();
			unsubscribeInput = undefined;
			clearWidget(ctx);
			const target = pane ?? opening;
			pane = undefined;
			opening = undefined;
			paneVisible = false;
			if (target) {
				try {
					await (await target).close();
				} catch (error) {
					ctx.ui.notify(`Cannot close tasks view: ${String(error)}`, "warning");
				}
			}
		}

		function watchInput(ctx: ExtensionContext): void {
			if (ctx.mode !== "tui" || child || restoreError) return;
			unsubscribeInput = ctx.ui.onTerminalInput((data) =>
				!lifetime.signal.aborted && !paneVisible && bar?.handleInput(data) ? { consume: true } : undefined,
			);
		}

		pi.registerCommand("tasks", {
			description: "View this session branch's tasks: /tasks [--tui|--rex] [--split|--floating] [--minimized]",
			handler: async (args, ctx) => {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("/tasks requires interactive mode; use the tasks tool to list task state", "error");
					return;
				}
				if (args.trim() === "--help") {
					ctx.ui.notify(
						"/tasks [--tui|--rex] [--split|--floating] [--minimized]. View only; the model edits tasks with the tasks tool. Reuses an existing view. New views use your Rex settings unless flags override them.",
						"info",
					);
					return;
				}
				const { options, text } = parsePaneCommand(args);
				if (text) throw new Error("/tasks accepts only pane presentation flags");
				await present(ctx, options);
			},
		});

		pi.on("session_start", (_event, ctx) => {
			if (lifetime.signal.aborted) lifetime = new AbortController();
			restore(ctx);
			watchInput(ctx);
		});
		pi.on("session_tree", async (_event, ctx) => {
			await stopUI(ctx);
			lifetime = new AbortController();
			barState.scroll = 0;
			restore(ctx);
			watchInput(ctx);
		});
		pi.on("session_compact", (_event, ctx) => restore(ctx));
		pi.on("before_agent_start", (event, ctx) => {
			if (!initialized) restore(ctx);
			if (child || restoreError || !event.systemPromptOptions.selectedTools.includes("tasks")) {
				delete event.systemPromptOptions.sections.tasks;
				return;
			}
			// A run-start section is a durable prompt patch, not a moving per-request snapshot.
			if (store.getSnapshot().tasks.length)
				event.systemPromptOptions.sections.tasks =
					"Task state at the start of this run. Later tasks tool results supersede this snapshot. After compaction/recovery, call tasks list before relying on task state.\n" +
					taskStateText(store.getSnapshot());
			else delete event.systemPromptOptions.sections.tasks;
		});
		pi.on("session_shutdown", (_event, ctx) => stopUI(ctx));
	};
}

export default createTasksExtension();
