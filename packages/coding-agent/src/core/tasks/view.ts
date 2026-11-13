// View-only task trees for the pinned editor widget and shared Rex/TUI pane.
import { type Component, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { type Theme, theme } from "../../modes/interactive/theme/theme.ts";
import type { PaneControls, PaneView } from "../panes/host.ts";
import { taskTreeHeader, taskTreeLeaves } from "./render.ts";
import type { TaskStore } from "./state.ts";

export interface TasksBarState {
	expanded: boolean;
	scroll: number;
}

/** Monitor current/next work without taking focus or replacing the editor draft. */
export class TasksBar implements Component {
	private readonly store: TaskStore;
	private readonly state: TasksBarState;
	private readonly rows: () => number;
	private readonly requestRender: () => void;
	private readonly getTheme: () => Theme;
	private readonly unsubscribe: () => void;
	private pageSize = 1;

	constructor(
		store: TaskStore,
		state: TasksBarState,
		rows: () => number,
		requestRender: () => void,
		getTheme: () => Theme,
	) {
		this.store = store;
		this.state = state;
		this.rows = rows;
		this.requestRender = requestRender;
		this.getTheme = getTheme;
		this.unsubscribe = store.subscribe(requestRender);
	}

	handleInput(data: string): boolean {
		if (!this.store.getSnapshot().tasks.length) return false;
		const kb = getKeybindings();
		if (kb.matches(data, "app.tasks.expand")) this.state.expanded = !this.state.expanded;
		else if (this.state.expanded && kb.matches(data, "app.tasks.pageUp"))
			this.state.scroll = Math.max(0, this.state.scroll - this.pageSize);
		else if (this.state.expanded && kb.matches(data, "app.tasks.pageDown")) this.state.scroll += this.pageSize;
		else return false;
		this.requestRender();
		return true;
	}

	render(width: number): string[] {
		const snapshot = this.store.getSnapshot();
		const theme = this.getTheme();
		const height = Math.min(this.state.expanded ? 10 : 4, Math.floor(this.rows() / 3));
		if (width <= 0 || height <= 0 || snapshot.tasks.length === 0) return [];
		const current = snapshot.tasks.find((task) => task.status === "in_progress");
		const next = snapshot.tasks.find((task) => task.status === "pending");
		const tasks = this.state.expanded ? snapshot.tasks : [current, next].filter((task) => task !== undefined);
		const header = taskTreeHeader(
			snapshot,
			width,
			theme,
			`${keyText("app.tasks.expand")} ${this.state.expanded ? "collapse" : "expand"}`,
		);
		const leaves = taskTreeLeaves(tasks, width, theme);
		const showFooter = this.state.expanded && height >= 4;
		this.pageSize = Math.max(1, height - header.length - (showFooter ? 1 : 0));
		this.state.scroll = Math.min(this.state.scroll, Math.max(0, leaves.length - this.pageSize));
		const start = this.state.expanded ? this.state.scroll : 0;
		const result = [...header, ...leaves.slice(start, start + this.pageSize)];
		if (showFooter)
			result.push(
				truncateToWidth(
					theme.fg(
						"dim",
						`   ${leaves.length ? `${start + 1}–${Math.min(leaves.length, start + this.pageSize)}/${leaves.length} lines · ` : ""}${keyText("app.tasks.pageUp")}/${keyText("app.tasks.pageDown")} scroll · /tasks view`,
					),
					width,
				),
			);
		return result.slice(0, height);
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}
}

/** Display every retained task in a scrollable, view-only pane. */
export class TasksView implements PaneView {
	private readonly store: TaskStore;
	private readonly controls: PaneControls;
	private readonly unsubscribe: () => void;
	private scroll = 0;
	private pageSize = 1;
	private error: string | undefined;
	private disposed = false;

	constructor(store: TaskStore, controls: PaneControls) {
		this.store = store;
		this.controls = controls;
		this.unsubscribe = store.subscribe(() => controls.invalidate());
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.controls.close();
			return;
		}
		if (kb.matches(data, "app.pane.minimize")) {
			void this.controls.minimize().catch((error: unknown) => {
				if (this.disposed) return;
				this.error = String(error);
				this.controls.invalidate();
			});
			return;
		}
		if (kb.matches(data, "tui.select.up")) this.scroll = Math.max(0, this.scroll - 1);
		else if (kb.matches(data, "tui.select.down")) this.scroll++;
		else if (kb.matches(data, "tui.select.pageUp")) this.scroll = Math.max(0, this.scroll - this.pageSize);
		else if (kb.matches(data, "tui.select.pageDown")) this.scroll += this.pageSize;
		else return;
		this.controls.invalidate();
	}

	render(width: number, height: number): string[] {
		if (width <= 0 || height <= 0) return [];
		const snapshot = this.store.getSnapshot();
		const header = taskTreeHeader(snapshot, width, theme);
		const leaves = snapshot.tasks.length
			? taskTreeLeaves(snapshot.tasks, width, theme)
			: [truncateToWidth(theme.fg("muted", "   └─ No tasks. The agent can add tasks for multi-step work."), width)];
		this.pageSize = Math.max(1, height - header.length - 1);
		this.scroll = Math.min(this.scroll, Math.max(0, leaves.length - this.pageSize));
		const footer = this.error
			? theme.fg("error", this.error)
			: theme.fg(
					"dim",
					`${keyText("tui.select.up")}/${keyText("tui.select.down")} scroll · ${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} page · ${keyText("app.pane.minimize")} minimize · ${keyText("tui.select.cancel")} close · view only`,
				);
		return [
			...header,
			...leaves.slice(this.scroll, this.scroll + this.pageSize),
			truncateToWidth(footer, width),
		].slice(0, height);
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
	}
}
