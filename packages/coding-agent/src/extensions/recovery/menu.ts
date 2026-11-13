// Pause and recovery choices use the native TUI without adding menu traffic to the conversation.
import { type Component, type KeybindingsManager, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { JobInfo } from "../../core/jobs/state.ts";
import type { SessionRecovery } from "../../core/session-recovery.ts";
import type { SubagentActivity } from "../../core/subagents/activity.ts";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { iconPrefix } from "../../modes/interactive/icons.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

export type RecoveryChoice = "continue" | "keep" | "discard";

export interface RecoveryActivity {
	subagents(): SubagentActivity | undefined;
	jobs(): Promise<readonly JobInfo[]>;
}

interface ChecklistRow {
	idle: boolean;
	text: string;
}

/** Show live pause progress and require an explicit choice before recovering interrupted work. */
export class RecoveryMenu implements Component {
	private readonly recovery: SessionRecovery;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: (choice: RecoveryChoice) => void;
	private readonly unsubscribe: () => void;
	private readonly recovering: boolean;
	private readonly activity: RecoveryActivity;
	private readonly clock: NodeJS.Timeout;
	private subagents: SubagentActivity | undefined;
	private unsubscribeSubagents: (() => void) | undefined;
	private children: ChecklistRow = { idle: false, text: "Sub-agent activity unknown" };
	private jobs: ChecklistRow = { idle: false, text: "Job activity unknown" };
	private refreshingJobs = false;
	private disposed = false;
	private selected: number;

	constructor(
		recovery: SessionRecovery,
		activity: RecoveryActivity,
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		done: (choice: RecoveryChoice) => void,
	) {
		this.recovery = recovery;
		this.activity = activity;
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = done;
		this.recovering = recovery.needsRecovery;
		this.selected = this.recovering ? 1 : 0;
		this.unsubscribe = recovery.subscribe(() => tui.requestRender());
		this.refreshSubagents();
		void this.refreshJobs();
		// Polling also detects lost workers and externally changed child catalogs without file watchers.
		this.clock = setInterval(() => {
			this.refreshSubagents();
			this.tui.requestRender();
			void this.refreshJobs();
		}, 2000);
		this.clock.unref();
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) this.done("keep");
		else if (this.keys.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (this.keys.matches(data, "tui.select.down"))
			this.selected = Math.min(this.recovering ? 2 : 1, this.selected + 1);
		else if (this.keys.matches(data, "tui.select.confirm")) {
			if (this.selected === 0 && !this.recovery.info().branchMatches) return;
			this.done(this.selected === 0 ? "continue" : this.selected === 1 ? "keep" : "discard");
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const info = this.recovery.info();
		const lines = [
			"",
			theme.bold(
				`${iconPrefix("pause")}${this.recovering ? "Interrupted session" : info.status === "paused" ? "Session paused" : "Pausing session…"}`,
			),
		];
		if (this.recovering) {
			lines.push("No work resumes until you choose Continue.");
			lines.push(
				`${info.main ? "Main task pending" : "Main task settled"} · ${info.children.length} unfinished sub-agents · ${info.queuedInputs} pending inputs`,
			);
			for (const tool of info.tools.slice(0, 3))
				lines.push(
					theme.fg(
						tool.outcome === "unknown" ? "warning" : "muted",
						clean(
							`${tool.name} (${tool.id}): ${tool.outcome === "unknown" ? "outcome unknown — inspect before repeating" : tool.outcome === "completed" ? "completed result saved" : "not started"}`,
						),
					),
				);
			if (info.tools.length > 3) lines.push(`… ${info.tools.length - 3} more tool calls`);
			for (const child of info.children.slice(0, 2))
				lines.push(theme.fg("muted", clean(`Child ${child.id.slice(0, 8)}: ${child.label}`)));
			if (info.children.length > 2) lines.push(`… ${info.children.length - 2} more sub-agents`);
			if (info.children.length)
				lines.push(
					theme.fg(
						"warning",
						"Interrupted child tools may have unknown outcomes; inspect their separate histories before repeating work.",
					),
				);
			if (!info.branchMatches)
				lines.push(
					theme.fg("warning", "Pending work belongs to another branch. Return to that branch or discard it."),
				);
		} else {
			const rows: ChecklistRow[] = [
				{ idle: !info.modelActive, text: counted(info.modelActive ? 1 : 0, "active model response") },
				{ idle: info.activeTools === 0, text: counted(info.activeTools, "running tool call") },
				this.children,
				this.jobs,
			];
			lines.push("");
			for (const row of rows)
				lines.push(
					theme.fg(
						row.idle ? "success" : "warning",
						`${iconPrefix(row.idle ? "checkboxChecked" : "checkboxUnchecked")}${row.text}`,
					),
				);
			lines.push(
				"",
				theme.fg(
					"muted",
					rows.every((row) => row.idle)
						? info.status === "paused"
							? "Safe to leave paused."
							: "Safe to pause."
						: "Advisory only; background jobs keep running.",
				),
			);
		}
		lines.push("");
		const choices = [
			this.recovering ? "Continue saved work" : "Continue",
			`${iconPrefix("pause")}Keep paused`,
			...(this.recovering ? ["Discard pending work (keep history)"] : []),
		];
		for (const [index, choice] of choices.entries())
			lines.push(index === this.selected ? theme.fg("accent", `> ${choice}`) : `  ${choice}`);
		lines.push(
			"",
			theme.fg(
				"muted",
				`${keyText("tui.select.up")}/${keyText("tui.select.down")} choose · ${keyText("tui.select.confirm")} select · ${keyText("tui.select.cancel")} keep paused`,
			),
		);
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.clock);
		this.unsubscribe();
		this.unsubscribeSubagents?.();
	}

	private refreshSubagents(): void {
		try {
			const source = this.activity.subagents();
			if (source !== this.subagents) {
				this.unsubscribeSubagents?.();
				this.subagents = source;
				this.unsubscribeSubagents = source?.subscribe(() => {
					this.refreshSubagents();
					this.tui.requestRender();
				});
			}
			if (!source) {
				this.children = { idle: false, text: "Sub-agent activity unknown" };
				return;
			}
			const statuses = source.list();
			const running = statuses.filter((status) => status === "running").length;
			const queued = statuses.filter((status) => status === "queued").length;
			const uncertain = statuses.filter((status) => status === "interrupted").length;
			const parts = running || !uncertain ? [counted(running, "running sub-agent")] : [];
			if (queued) parts.push(`${queued} queued`);
			if (uncertain) parts.push(`${uncertain} interrupted; activity unknown`);
			this.children = { idle: running + queued + uncertain === 0, text: parts.join(" · ") };
		} catch {
			this.children = { idle: false, text: "Sub-agent activity unknown" };
		}
	}

	private async refreshJobs(): Promise<void> {
		if (this.disposed || this.refreshingJobs) return;
		this.refreshingJobs = true;
		try {
			const jobs = await this.activity.jobs();
			if (this.disposed) return;
			const running = jobs.filter(
				(job) => job.runtime.state === "starting" || job.runtime.state === "running",
			).length;
			const uncertain = jobs.filter(
				(job) => job.runtime.state === "unreachable" || job.runtime.state === "lost",
			).length;
			this.jobs = {
				idle: running + uncertain === 0,
				text: uncertain
					? `${running ? `${counted(running, "running job")} · ` : ""}${counted(uncertain, "job")} with unknown activity`
					: counted(running, "running job"),
			};
		} catch {
			if (!this.disposed) this.jobs = { idle: false, text: "Job activity unknown" };
		} finally {
			this.refreshingJobs = false;
			if (!this.disposed) this.tui.requestRender();
		}
	}
}

function counted(count: number, label: string): string {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/[\r\n]/g, " ");
}
