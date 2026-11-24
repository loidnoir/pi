// Interactive role selection, child status, and paged history without adding view traffic to main chat.
import { getKeybindings, Input, indexedColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderFooterLine } from "../../modes/interactive/components/footer.ts";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { WorkingStatusIndicator } from "../../modes/interactive/components/status-indicator.ts";
import { type IconName, icon, iconPrefix } from "../../modes/interactive/icons.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { ChatTranscript } from "../panes/chat-transcript.ts";
import type { PaneControls, PaneView } from "../panes/host.ts";
import { createUsageTotals } from "../usage-totals.ts";
import type { AgentDefinitions } from "./definitions.ts";
import type { SubagentManager } from "./manager.ts";
import { type SubagentInfo, type SubagentStatus, type SubagentTranscriptPage, TRANSCRIPT_PAGE_SIZE } from "./state.ts";

export interface SubagentsViewActions {
	definitions(): AgentDefinitions;
	start(role: string, task: string): Promise<SubagentInfo>;
	resume(id: string, task: string): Promise<SubagentInfo>;
}
type Editing = { kind: "start"; role: string; input: Input } | { kind: "message" | "resume"; id: string; input: Input };

/** Present configured roles and independently stored child conversations with lifecycle controls. */
export class SubagentsView implements PaneView {
	private readonly manager: SubagentManager;
	private readonly controls: PaneControls;
	private readonly actions: SubagentsViewActions;
	private readonly unsubscribe: () => void;
	private agents: SubagentInfo[] = [];
	private catalog: AgentDefinitions = { agents: [], errors: [] };
	private selected = 0;
	private renderedSelection: string | undefined;
	private roleSelection = 0;
	private choosingRole = false;
	private detail: string | undefined;
	private editing: Editing | undefined;
	private page: SubagentTranscriptPage = {
		cwd: "",
		messages: [],
		offset: 0,
		totalMessages: 0,
		usage: createUsageTotals(),
	};
	private transcript: ChatTranscript | undefined;
	private expanded = false;
	private follow = true;
	private scroll = 0;
	private error: string | undefined;
	private busy = false;
	private disposed = false;
	private rendered: string[] = [];
	private viewportLines = 1;
	private working: WorkingStatusIndicator | undefined;

	constructor(manager: SubagentManager, controls: PaneControls, actions: SubagentsViewActions, id?: string) {
		this.manager = manager;
		this.controls = controls;
		this.actions = actions;
		this.detail = id;
		try {
			this.agents = manager.list();
			this.catalog = actions.definitions();
			if (id) {
				this.selected = Math.max(
					0,
					this.agents.findIndex((agent) => agent.id === id),
				);
				this.readPage("end");
			}
		} catch (error) {
			this.error = String(error);
		}
		this.unsubscribe = manager.subscribe((event) => {
			if (this.disposed || event.type === "progress") return;
			const index = this.agents.findIndex((agent) => agent.id === event.id);
			if (event.type === "deleted") {
				if (index < 0) return;
				this.agents.splice(index, 1);
				if (index < this.selected) this.selected--;
				else this.selected = Math.max(0, Math.min(this.selected, this.agents.length - 1));
				if (this.detail === event.id) this.detail = undefined;
				controls.invalidate();
				return;
			}
			try {
				const info = manager.inspect(event.id);
				if (index < 0) {
					if (this.agents.length) this.selected++;
					this.agents.unshift(info);
				} else this.agents[index] = info;
				if (event.id === this.detail) {
					if (this.follow) this.readPage("end");
					else
						this.readPage(
							this.page.offset,
							this.page.nextOffset === undefined ? TRANSCRIPT_PAGE_SIZE : this.page.messages.length,
						);
				}
			} catch (error) {
				this.error = String(error);
			}
			controls.invalidate();
		});
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.pane.minimize")) {
			this.stopWorking();
			void this.run(() => this.controls.minimize());
			return;
		}
		if (this.editing) {
			this.editing.input.handleInput(data);
			this.controls.invalidate();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.choosingRole) this.choosingRole = false;
			else if (this.detail) this.detail = undefined;
			else this.controls.close();
		} else if (kb.matches(data, "app.agents.start")) {
			try {
				this.catalog = this.actions.definitions();
				this.choosingRole = true;
				this.roleSelection = 0;
				this.error = undefined;
			} catch (error) {
				this.error = String(error);
			}
		} else if (kb.matches(data, "tui.select.up")) this.move(-1);
		else if (kb.matches(data, "tui.select.down")) this.move(1);
		else if (kb.matches(data, "tui.select.pageUp")) this.move(-this.viewportLines);
		else if (kb.matches(data, "tui.select.pageDown")) this.move(this.viewportLines);
		else if (this.choosingRole) {
			if (kb.matches(data, "tui.select.confirm")) {
				const role = this.catalog.agents[this.roleSelection];
				if (role) this.edit({ kind: "start", role: role.name });
			}
		} else if (this.detail && kb.matches(data, "app.tools.expand")) {
			this.expanded = !this.expanded;
			this.transcript?.setExpanded(this.expanded);
		} else {
			const agent = this.selectedAgent();
			if (!agent || this.busy) return;
			if (kb.matches(data, "tui.select.confirm")) {
				this.detail = agent.id;
				this.follow = true;
				this.readPage("end");
			} else if (kb.matches(data, "app.agents.stop")) {
				if (agent.id === this.renderedSelection) void this.run(() => this.manager.cancel(agent.id));
			} else if (kb.matches(data, "app.agents.delete")) {
				if (agent.id === this.renderedSelection) void this.run(async () => this.manager.remove(agent.id));
			} else if (kb.matches(data, "app.agents.message")) this.edit({ kind: "message", id: agent.id });
			else if (kb.matches(data, "app.agents.resume")) this.edit({ kind: "resume", id: agent.id });
		}
		this.controls.invalidate();
	}

	scrollBy(lines: number): void {
		if (!lines || this.editing) return;
		this.move(lines);
		this.controls.invalidate();
	}

	private move(lines: number): void {
		if (this.choosingRole) {
			this.roleSelection = Math.max(0, Math.min(this.catalog.agents.length - 1, this.roleSelection + lines));
		} else if (this.detail) {
			const end = Math.max(0, this.rendered.length - this.viewportLines);
			const top = this.follow ? end : Math.min(this.scroll, end);
			this.follow = false;
			if (lines < 0 && top === 0 && this.page.offset > 0) {
				const start = Math.max(0, this.page.offset - TRANSCRIPT_PAGE_SIZE);
				this.readPage(start, this.page.offset - start);
				this.scroll = Infinity;
			} else if (lines > 0 && top === end && this.page.nextOffset !== undefined) {
				this.readPage(this.page.nextOffset);
				this.scroll = 0;
			} else {
				this.scroll = Math.max(0, Math.min(end, top + lines));
				this.follow = this.scroll === end && this.page.nextOffset === undefined;
			}
		} else this.selected = Math.max(0, Math.min(this.agents.length - 1, this.selected + lines));
	}

	render(width: number, height: number): string[] {
		this.renderedSelection = undefined;
		if (this.disposed) return [];
		const lines: string[] = [];
		const chat = this.choosingRole || !this.detail ? undefined : this.selectedAgent();
		const bottom = this.renderBottom(width, chat);
		this.viewportLines = Math.max(1, height - 5);
		if (this.choosingRole || this.detail) this.stopWorking();
		if (this.choosingRole) {
			lines.push(theme.bold("Configured agent roles"));
			const start = Math.max(0, this.roleSelection - this.viewportLines + 1);
			for (let index = start; index < Math.min(this.catalog.agents.length, start + this.viewportLines); index++) {
				const role = this.catalog.agents[index];
				const prefix = rowGuide(index, this.roleSelection, this.catalog.agents.length);
				const row = line(
					`${agentIconPrefix(role.name)}${role.name} [${role.source}] — ${role.description}`,
					Math.max(0, width - visibleWidth(prefix)),
				);
				lines.push(truncateToWidth(prefix + (index === this.roleSelection ? theme.fg("accent", row) : row), width));
			}
			for (const error of this.catalog.errors.slice(0, 2))
				lines.push(theme.fg("warning", line(`${error.path}: ${error.error}`, width)));
		} else if (chat) {
			if (width > 0 && height > 0) this.renderedSelection = chat.id;
			const prefix = `${statusColor(chat.status, icon("statusDot"))}  ${agentIconPrefix(chat.role)}`;
			lines.push(
				truncateToWidth(
					`${prefix}${theme.bold(line(chat.label, Math.max(0, width - visibleWidth(prefix))))}`,
					width,
				),
				line(`Read-only agent history · ${chat.id}`, width),
				truncateToWidth(
					`${statusColor(chat.status, chat.status)} · ${line(`${chat.role} · run ${chat.run}`, width)}`,
					width,
				),
			);
			if (chat.error) lines.push(theme.fg("error", line(chat.error, width)));
			if (chat.labelError) lines.push(theme.fg("warning", line(`Task label: ${chat.labelError}`, width)));
			this.rendered = this.transcript?.render(width) ?? [];
			this.viewportLines = Math.max(0, height - lines.length - bottom.length);
			const end = Math.max(0, this.rendered.length - this.viewportLines);
			if (this.scroll >= end && this.page.nextOffset === undefined) this.follow = true;
			this.scroll = this.follow ? end : Math.min(this.scroll, end);
			const visible = this.rendered.slice(this.scroll, this.scroll + this.viewportLines);
			lines.push(...visible, ...Array<string>(this.viewportLines - visible.length).fill(""));
		} else {
			lines.push(
				theme.fg(
					"muted",
					`${this.agents.filter((agent) => agent.status === "running").length} running · ${this.agents.filter((agent) => agent.status === "queued").length} queued · ${this.catalog.agents.length} configured roles`,
				),
			);
			if (!this.agents.length)
				lines.push(`└─ No child runs. ${keyText("app.agents.start")} chooses a role and starts a task.`);
			const start = Math.max(0, this.selected - this.viewportLines + 1);
			const visible = this.agents.slice(start, start + this.viewportLines);
			if (width > 0 && height > 1 && visible.some(isActive)) {
				this.working ??= new WorkingStatusIndicator({ requestRender: () => this.controls.invalidate() }, "");
			} else this.stopWorking();
			const spinner = this.working?.renderSpinnerInBorder(width);
			for (const [offset, child] of visible.entries()) {
				const index = start + offset;
				const marker = spinner && isActive(child) ? spinner : statusColor(child.status, icon("statusDot"));
				const prefix = `${rowGuide(index, this.selected, this.agents.length)}${marker}  ${agentIconPrefix(child.role)}`;
				const label = clean(`${child.role} · ${child.label}`).replace(/\n/g, "\\n");
				const id = ` ${child.id.slice(0, 8)}`;
				const available = Math.max(0, width - visibleWidth(prefix) - visibleWidth(child.status) - 1);
				const showId = visibleWidth(label) + visibleWidth(id) <= available;
				const suffix = ` ${statusColor(child.status, child.status)}${showId ? theme.fg("muted", id) : ""}`;
				const text = truncateToWidth(label, available);
				if (index === this.selected && width > 0 && lines.length < height) this.renderedSelection = child.id;
				lines.push(
					truncateToWidth(`${prefix}${index === this.selected ? theme.fg("accent", text) : text}${suffix}`, width),
				);
			}
		}
		return [...lines, ...bottom].slice(0, height);
	}

	private renderBottom(width: number, chat: SubagentInfo | undefined): string[] {
		const lines: string[] = [];
		if (this.error) lines.push(theme.fg("error", line(this.error, width)));
		if (this.editing) {
			lines.push(
				this.editing.kind === "start"
					? `Task for ${this.editing.role}:`
					: this.editing.kind === "message"
						? "Message to child:"
						: "Continuation instruction:",
			);
			lines.push(...this.editing.input.render(width));
		} else if (!chat) {
			lines.push(
				theme.fg(
					"muted",
					line(
						`${keyText("app.agents.start")} new · ${keyText("tui.select.confirm")} view/select · ${keyText("app.agents.message")} message · ${keyText("app.agents.resume")} resume`,
						width,
					),
				),
			);
			lines.push(
				theme.fg(
					"muted",
					line(
						`${keyText("app.agents.stop")} stop · ${keyText("app.agents.delete")} delete · ${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} history · ${keyText("tui.select.cancel")} back/close${this.busy ? " · working" : ""}`,
						width,
					),
				),
			);
		}
		if (chat) {
			const slash = chat.model.indexOf("/");
			lines.push(
				renderFooterLine(
					{
						cwd: clean(this.page.cwd),
						usage: this.page.usage,
						context: this.page.contextUsage ?? { percent: null, contextWindow: 0 },
						model: `${line(chat.model.slice(slash + 1), width)} • ${chat.thinkingLevel === "off" ? "thinking off" : chat.thinkingLevel}`,
						provider: clean(chat.model.slice(0, slash)),
						statuses: this.busy ? "working" : undefined,
					},
					width,
				),
			);
		}
		return lines;
	}

	dispose(): void {
		this.disposed = true;
		this.renderedSelection = undefined;
		this.unsubscribe();
		this.stopWorking();
		this.transcript?.dispose();
	}

	private stopWorking(): void {
		this.working?.dispose();
		this.working = undefined;
	}

	private edit(action: { kind: "start"; role: string } | { kind: "message" | "resume"; id: string }): void {
		const input = new Input();
		input.focused = true;
		input.onEscape = () => {
			this.editing = undefined;
			this.controls.invalidate();
		};
		input.onSubmit = (text) => {
			if (!text.trim()) return;
			this.editing = undefined;
			void this.run(async () => {
				const agent =
					action.kind === "start"
						? await this.actions.start(action.role, text)
						: action.kind === "resume"
							? await this.actions.resume(action.id, text)
							: await this.manager.message(action.id, text);
				if (this.disposed) return;
				this.detail = agent.id;
				this.choosingRole = false;
				this.follow = true;
				this.agents = this.manager.list();
				this.selected = Math.max(
					0,
					this.agents.findIndex((entry) => entry.id === agent.id),
				);
				this.readPage("end");
			});
		};
		this.editing = { ...action, input };
	}
	private readPage(offset: number | "end", limit = TRANSCRIPT_PAGE_SIZE): void {
		if (!this.detail) return;
		const page = this.manager.transcript(this.detail, offset, limit);
		if (!this.transcript || this.page.cwd !== page.cwd) {
			this.transcript?.dispose();
			this.transcript = new ChatTranscript({ cwd: page.cwd, invalidate: () => this.controls.invalidate() });
			this.transcript.setExpanded(this.expanded);
		}
		this.page = page;
		this.transcript.setMessages(page.messages);
	}
	private selectedAgent(): SubagentInfo | undefined {
		return this.detail ? this.agents.find((agent) => agent.id === this.detail) : this.agents[this.selected];
	}
	private async run(action: () => Promise<unknown>): Promise<void> {
		this.busy = true;
		this.error = undefined;
		this.controls.invalidate();
		try {
			await action();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.busy = false;
			if (!this.disposed) this.controls.invalidate();
		}
	}
}
function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
}
function line(text: string, width: number): string {
	return truncateToWidth(clean(text).replace(/\n/g, "\\n"), width);
}

function agentIconPrefix(role: string): string {
	let name: IconName;
	switch (role) {
		case "worker":
			name = "agentWorker";
			break;
		case "scout":
			name = "agentScout";
			break;
		case "reviewer":
			name = "agentReviewer";
			break;
		case "planner":
			name = "agentPlanner";
			break;
		default:
			name = "agent";
	}
	return iconPrefix(name);
}

function rowGuide(index: number, selected: number, count: number): string {
	return `${index === selected ? theme.fg("accent", ">") : " "} ${theme.fg("muted", index === count - 1 ? "└─ " : "├─ ")}`;
}

function isActive(agent: SubagentInfo): boolean {
	return agent.status === "running" || agent.status === "queued";
}

function statusColor(status: SubagentStatus, text: string): string {
	switch (status) {
		case "running":
			return theme.style(text, { fg: indexedColor(4) });
		case "completed":
			return theme.fg("success", text);
		case "failed":
		case "interrupted":
			return theme.fg("error", text);
		case "queued":
		case "paused":
			return theme.fg("warning", text);
		case "stopped":
			return theme.fg("muted", text);
	}
}
