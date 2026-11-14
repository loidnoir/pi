// Parent-scoped saved side chats, shown newest first in pages of twenty.
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { iconPrefix } from "../../modes/interactive/icons.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { PaneControls, PaneView } from "./host.ts";

export interface SideChatListItem {
	id: string;
	title: string;
	updatedAt: number;
}

export interface SideChatListPage {
	items: SideChatListItem[];
	total: number;
	errors?: string[];
}

export interface SideChatListActions {
	list(offset: number): SideChatListPage;
	open(id: string): Promise<void>;
}

const PAGE_SIZE = 20;

/** Browse this main thread's saved chats without starting a model request. */
export class SideChatListView implements PaneView {
	private readonly controls: PaneControls;
	private readonly actions: SideChatListActions;
	private page: SideChatListPage = { items: [], total: 0 };
	private offset = 0;
	private selected = 0;
	private busy = false;
	private disposed = false;
	private error: string | undefined;

	constructor(controls: PaneControls, actions: SideChatListActions) {
		this.controls = controls;
		this.actions = actions;
		this.refresh();
	}

	/** Reload titles and ordering when the history pane is restored. */
	refresh(): void {
		try {
			this.page = this.actions.list(this.offset);
			if (this.offset >= this.page.total && this.offset > 0) {
				this.offset = Math.max(0, Math.ceil(this.page.total / PAGE_SIZE) - 1) * PAGE_SIZE;
				this.page = this.actions.list(this.offset);
			}
			this.selected = Math.min(this.selected, Math.max(0, this.page.items.length - 1));
			this.error = undefined;
		} catch (error) {
			this.error = String(error);
		}
		this.controls.invalidate();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) this.controls.close();
		else if (kb.matches(data, "app.pane.minimize")) {
			void this.controls.minimize().catch((error: unknown) => this.fail(error));
		} else if (this.busy) return;
		else if (kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (kb.matches(data, "tui.select.down"))
			this.selected = Math.min(this.page.items.length - 1, this.selected + 1);
		else if (kb.matches(data, "tui.select.pageUp") && this.offset > 0) {
			this.offset = Math.max(0, this.offset - PAGE_SIZE);
			this.selected = 0;
			this.refresh();
		} else if (kb.matches(data, "tui.select.pageDown") && this.offset + PAGE_SIZE < this.page.total) {
			this.offset += PAGE_SIZE;
			this.selected = 0;
			this.refresh();
		} else if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.page.items[this.selected];
			if (!selected) return;
			this.busy = true;
			void this.actions
				.open(selected.id)
				.catch((error: unknown) => this.fail(error))
				.finally(() => {
					this.busy = false;
					if (!this.disposed) this.controls.invalidate();
				});
		}
		this.controls.invalidate();
	}

	render(width: number, height: number): string[] {
		const lines = ["", theme.fg("muted", `${this.page.total} saved in this main thread · newest activity first`)];
		if (this.page.errors?.length)
			lines.push(
				theme.fg(
					"warning",
					`Skipped ${this.page.errors.length} unreadable chat${this.page.errors.length === 1 ? "" : "s"}: ${clean(this.page.errors[0])}`,
				),
			);
		lines.push("");
		if (!this.page.items.length)
			lines.push(
				this.page.errors?.length
					? "No readable side chats. Start one with /btw <question>."
					: "No side chats yet. Start one with /btw <question>.",
			);
		const available = Math.max(0, height - lines.length - 4 - (this.error ? 1 : 0));
		const start = Math.max(0, this.selected - available + 1);
		for (let index = start; index < Math.min(this.page.items.length, start + available); index++) {
			const item = this.page.items[index];
			const text = truncateToWidth(`${iconPrefix("text")}${clean(item.title)}  ${item.id.slice(0, 8)}`, width);
			lines.push(index === this.selected ? theme.fg("accent", text) : text);
		}
		lines.push("");
		if (this.error) lines.push(theme.fg("error", clean(this.error)));
		lines.push(
			theme.fg(
				"muted",
				`Page ${Math.floor(this.offset / PAGE_SIZE) + 1}/${Math.max(1, Math.ceil(this.page.total / PAGE_SIZE))} · ${PAGE_SIZE} chats per page`,
			),
			theme.fg(
				"muted",
				`${keyText("tui.select.confirm")} reopen · ${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} pages · ${keyText("tui.select.cancel")} close${this.busy ? " · opening" : ""}`,
			),
			theme.fg("muted", "Start a separate chat with /btw <question> in the main thread."),
		);
		return lines.slice(0, Math.max(0, height)).map((line) => truncateToWidth(line, width));
	}

	dispose(): void {
		this.disposed = true;
	}

	private fail(error: unknown): void {
		if (this.disposed) return;
		this.error = String(error);
		this.controls.invalidate();
	}
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/[\r\n]/g, " ");
}
