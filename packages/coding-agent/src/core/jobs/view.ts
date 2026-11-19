// Live job list/detail view shared by pi overlays and Rex terminals.
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { getKeybindings, Input, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { WorkingStatusIndicator } from "../../modes/interactive/components/status-indicator.ts";
import { iconPrefix } from "../../modes/interactive/icons.ts";
import { CodeHighlighter, theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { PaneControls, PaneView } from "../panes/host.ts";
import { stateColor } from "./action-block.ts";
import type { JobManager } from "./manager.ts";
import type { JobInfo } from "./state.ts";

type Editing = { type: "rename" | "command"; id: string; input: Input };

/** Display persistent jobs and their live output with configurable management controls. */
export class JobsView implements PaneView {
	private readonly manager: JobManager;
	private readonly cwd: string;
	private readonly controls: PaneControls;
	private readonly onSubmitted: (job: JobInfo) => void;
	private jobs: JobInfo[] = [];
	private selected = 0;
	private displayedId: string | undefined;
	private detail: string | undefined;
	private detailJob: JobInfo | undefined;
	private editing: Editing | undefined;
	private error: string | undefined;
	private log = "";
	private readonly output = new Text("", 0, 0);
	private readonly commandHighlighter = new CodeHighlighter();
	private logTruncated = false;
	private outputStart: number | undefined;
	private outputMax = 0;
	private pageSize = 1;
	private busy = false;
	private disposed = false;
	private refreshing = false;
	private refreshAgain = false;
	private refreshTimer: NodeJS.Timeout | undefined;
	private spinner: WorkingStatusIndicator | undefined;
	private poll: NodeJS.Timeout | undefined;
	private nextPoll = Date.now() + 2000;
	private readonly rootWatcher: FSWatcher;
	private readonly watches = new Map<string, () => void>();

	constructor(
		manager: JobManager,
		cwd: string,
		controls: PaneControls,
		onSubmitted: (job: JobInfo) => void,
		id?: string,
	) {
		this.manager = manager;
		this.cwd = cwd;
		this.controls = controls;
		this.onSubmitted = onSubmitted;
		this.detail = id;
		mkdirSync(manager.directory, { recursive: true, mode: 0o700 });
		this.rootWatcher = watch(manager.directory, { persistent: false }, (_event, name) => {
			if (!this.detail || name === this.detail) this.scheduleRefresh();
		});
		this.rootWatcher.on("error", (error) => {
			this.error = error.message;
			controls.invalidate();
		});
		void this.refresh();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.pane.minimize")) {
			void this.controls.minimize().catch((error: unknown) => {
				this.error = String(error);
				this.controls.invalidate();
			});
			return;
		}
		if (this.editing) {
			this.editing.input.handleInput(data);
			this.controls.invalidate();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.detail) {
				this.detail = undefined;
				this.outputStart = undefined;
				this.scheduleRefresh();
			} else this.controls.close();
			this.controls.invalidate();
		} else if (kb.matches(data, "tui.select.up")) this.scrollBy(-1);
		else if (kb.matches(data, "tui.select.down")) this.scrollBy(1);
		else if (kb.matches(data, "tui.select.pageUp")) this.scrollBy(-this.pageSize);
		else if (kb.matches(data, "tui.select.pageDown")) this.scrollBy(this.pageSize);
		else {
			const job = this.selectedJob();
			if (!job || this.busy) return;
			if (!this.detail && kb.matches(data, "tui.select.confirm")) {
				this.detail = job.id;
				this.outputStart = undefined;
				this.scheduleRefresh();
			} else if (job.id !== this.displayedId) return;
			else if (kb.matches(data, "app.jobs.stop")) void this.run(() => this.manager.stop(job.id));
			else if (kb.matches(data, "app.jobs.restart")) void this.run(() => this.restart(job.id));
			else if (kb.matches(data, "app.jobs.delete")) void this.run(() => this.manager.remove(job.id));
			else if (kb.matches(data, "app.jobs.rename")) this.edit(job, "rename");
			else if (kb.matches(data, "app.jobs.editCommand")) this.edit(job, "command");
			else return;
			this.controls.invalidate();
		}
	}

	scrollBy(lines: number): void {
		if (this.editing || !lines) return;
		if (this.detail) {
			const start = Math.max(0, (this.outputStart ?? this.outputMax) + lines);
			this.outputStart = start >= this.outputMax ? undefined : start;
		} else this.selected = Math.max(0, Math.min(this.jobs.length - 1, this.selected + lines));
		this.controls.invalidate();
	}

	render(width: number, height: number): string[] {
		this.displayedId = width > 0 && height > 0 ? this.selectedJob()?.id : undefined;
		if (width <= 0 || height <= 0) return [];
		const controls = this.renderControls(width);
		const footer = controls.slice(Math.max(0, controls.length - height + 1));
		const room = height - footer.length;
		const content = this.detail ? this.renderDetail(width, room) : this.renderList(width, room);
		return [...content, ...footer].map((line) => truncateToWidth(line, width));
	}

	private renderList(width: number, height: number): string[] {
		const lines =
			height > 1
				? [
						theme.fg("accent", theme.bold(`${iconPrefix("job")}Jobs`)) +
							theme.fg("muted", ` · ${singleLine(this.cwd, width)}`),
					]
				: [];
		this.pageSize = height - lines.length;
		const start = Math.max(0, this.selected - this.pageSize + 1);
		const frame = this.spinner?.renderSpinnerInBorder(width);
		for (let i = start; i < Math.min(this.jobs.length, start + this.pageSize); i++) {
			const entry = this.jobs[i];
			const selected = i === this.selected;
			const running = isRunningJob(entry);
			const prefix =
				theme.fg("accent", selected ? "> " : "  ") +
				theme.fg("muted", i === this.jobs.length - 1 ? "└─ " : "├─ ") +
				(running && frame ? `${frame} ` : "");
			const state = theme.fg(running ? "success" : stateColor(entry.runtime.state), entry.runtime.state);
			const metrics =
				width >= 50
					? theme.fg(
							"muted",
							` · ${entry.id.slice(0, 8)} · ${duration(entry)}${entry.progress ? ` · ${entry.progress.percent}%` : ""}`,
						)
					: "";
			const name = singleLine(entry.name, Math.max(5, width - visibleWidth(prefix + state + metrics) - 3));
			lines.push(
				prefix +
					(selected ? theme.fg("accent", theme.bold(name)) : running ? theme.fg("success", name) : name) +
					theme.fg("dim", " · ") +
					state +
					metrics,
			);
		}
		if (!this.jobs.length)
			lines.push(theme.fg("muted", "└─ No background jobs in this project. Start one with bash async:true."));
		return lines;
	}

	private renderDetail(width: number, height: number): string[] {
		const job = this.selectedJob();
		if (!job) return [theme.fg("muted", "Loading job…")];
		const frame = isRunningJob(job) ? this.spinner?.renderSpinnerInBorder(width) : undefined;
		const prefix = (frame ? `${frame} ` : "") + theme.fg("accent", iconPrefix("job"));
		const status = theme.fg(stateColor(job.runtime.state), job.runtime.state);
		const metrics = width >= 36 ? ` · ${duration(job)}` : "";
		const name = singleLine(job.name, Math.max(4, width - visibleWidth(prefix + status + metrics) - 3));
		const header =
			prefix + theme.fg("accent", theme.bold(name)) + theme.fg("dim", " · ") + status + theme.fg("muted", metrics);
		const lines = height > 1 ? [header] : [];
		const command = clean(job.command).replace(/\n/g, "\\n").replace(/\t/g, "   ");
		const specs = [
			theme.fg("accent", `${iconPrefix("terminal")}Command: `) +
				(this.commandHighlighter.highlight(command, "bash")[0] ?? ""),
			theme.fg("accent", `${iconPrefix("folder")}Directory: `) + singleLine(job.cwd, width),
			theme.fg("muted", `${iconPrefix("info")}ID: ${job.id}`),
		];
		if (job.progress) {
			const barWidth = Math.min(30, Math.max(0, width - 40));
			const filled = Math.floor((job.progress.percent * barWidth) / 100);
			const bar = barWidth ? `[${"=".repeat(filled)}${" ".repeat(barWidth - filled)}] ` : "";
			specs.push(
				`${theme.fg("accent", `${iconPrefix("tasks")}Progress: `)}${bar}${job.progress.percent}% ${singleLine(job.progress.message ?? "", width)}`,
			);
		}
		if (job.progressError) specs.push(theme.fg("warning", singleLine(job.progressError, width)));
		if (job.naming?.status === "failed")
			specs.push(theme.fg("warning", singleLine(`Name generation failed: ${job.naming.error}`, width)));
		if ("error" in job.runtime && job.runtime.error)
			specs.push(theme.fg("error", singleLine(job.runtime.error, width)));
		specs.push(
			theme.fg("accent", `${iconPrefix("read")}${this.logTruncated ? "Log tail; full output" : "Full output"}: `) +
				singleLine(job.logPath, width),
		);
		const intro = specs.map((line, index) => theme.fg("muted", index === specs.length - 1 ? "└─ " : "├─ ") + line);
		intro.push("");
		if (!lines.length) intro.unshift(header);
		lines.push(...intro.splice(0, Math.max(0, height - lines.length - 2)));
		this.pageSize = height - lines.length;
		const output = this.detailJob?.id === job.id ? this.output.render(width) : [];
		this.outputMax = Math.max(0, intro.length + output.length - this.pageSize);
		if (this.outputStart !== undefined && this.outputStart >= this.outputMax) this.outputStart = undefined;
		const start = this.outputStart ?? this.outputMax;
		const end = start + this.pageSize;
		return [
			...lines,
			...intro.slice(start, end),
			...output
				.slice(Math.max(0, start - intro.length), Math.max(0, end - intro.length))
				.map((line) => `${line}\x1b[0m`),
		];
	}

	private renderControls(width: number): string[] {
		const lines: string[] = [];
		if (this.editing) {
			lines.push(
				this.editing.type === "rename"
					? "Rename job:"
					: "Replace command and restart (one-line input; use jobs restart for multiline commands):",
			);
			lines.push(...this.editing.input.render(width));
		} else {
			lines.push(
				theme.fg(
					"muted",
					`${this.detail ? `${keyText("tui.select.up")}/${keyText("tui.select.down")} scroll` : `${keyText("tui.select.confirm")} view`} · ${keyText("app.jobs.stop")} stop · ${keyText("app.jobs.restart")} restart · ${keyText("app.jobs.rename")} rename`,
				),
			);
			lines.push(
				theme.fg(
					"muted",
					`${keyText("app.jobs.editCommand")} command · ${keyText("app.jobs.delete")} delete · ${keyText("app.pane.minimize")} minimize · ${keyText("tui.select.cancel")} ${this.detail ? "back" : "close"}${this.busy ? " · working" : ""}`,
				),
			);
		}
		if (this.error) lines.push(theme.fg("error", singleLine(this.error, width)));
		return lines;
	}

	dispose(): void {
		this.disposed = true;
		this.spinner?.dispose();
		clearInterval(this.poll);
		clearTimeout(this.refreshTimer);
		this.rootWatcher.close();
		for (const stop of this.watches.values()) stop();
		this.watches.clear();
	}

	private edit(job: JobInfo, type: Editing["type"]) {
		const input = new Input();
		input.focused = true;
		input.setValue(
			type === "rename" ? clean(job.name).replace(/\n/g, " ") : job.command.includes("\n") ? "" : job.command,
		);
		input.onEscape = () => {
			this.editing = undefined;
			this.controls.invalidate();
		};
		input.onSubmit = (value) => {
			this.editing = undefined;
			if (!value.trim()) {
				this.controls.invalidate();
				return;
			}
			void this.run(async () => {
				if (type === "rename") await this.manager.rename(job.id, value);
				else await this.restart(job.id, value);
			});
		};
		this.editing = { type, id: job.id, input };
	}

	private async restart(id: string, command?: string): Promise<void> {
		const next = await this.manager.restart(id, command);
		this.onSubmitted(next);
		if (!this.disposed) {
			this.detail = next.id;
			this.outputStart = undefined;
		}
	}

	private async run(action: () => Promise<unknown>) {
		this.busy = true;
		this.error = undefined;
		this.controls.invalidate();
		try {
			await action();
			await this.refresh();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.busy = false;
			if (!this.disposed) this.controls.invalidate();
		}
	}

	private selectedJob(): JobInfo | undefined {
		if (!this.detail) return this.jobs[this.selected];
		return this.detailJob?.id === this.detail ? this.detailJob : this.jobs.find((job) => job.id === this.detail);
	}

	private updateClock(jobs: JobInfo[]) {
		if (jobs.some(isRunningJob)) {
			this.spinner ??= new WorkingStatusIndicator(
				{
					requestRender: () => {
						this.controls.invalidate();
						if (Date.now() >= this.nextPoll) {
							this.nextPoll = Date.now() + 2000;
							this.scheduleRefresh();
						}
					},
				},
				"",
			);
		} else {
			this.spinner?.dispose();
			this.spinner = undefined;
		}
		if (!this.spinner && jobs.some(isActiveJob)) {
			this.poll ??= setInterval(() => this.scheduleRefresh(), 2000).unref();
		} else {
			clearInterval(this.poll);
			this.poll = undefined;
		}
	}

	private scheduleRefresh() {
		if (this.disposed || this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh();
		}, 75);
	}

	private async refresh() {
		if (this.disposed) return;
		if (this.refreshing) {
			this.refreshAgain = true;
			return;
		}
		this.refreshing = true;
		try {
			const id = this.detail;
			let detailJob: JobInfo | undefined;
			if (id) {
				try {
					detailJob = await this.manager.inspect(id);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					if (this.detail === id) this.detail = undefined;
					this.refreshAgain = true;
					return;
				}
			}
			// Automatic panes inspect only their own job, rather than rescanning every other job per pane.
			const jobs = detailJob ? [detailJob] : await this.manager.list(this.cwd);
			if (this.disposed) return;
			if (id !== this.detail) {
				this.refreshAgain = true;
				return;
			}
			if (detailJob && detailJob.id !== this.detailJob?.id) {
				this.log = "";
				this.output.setText("");
				this.logTruncated = false;
			}
			this.detailJob = detailJob;
			void this.controls
				.setTitle(detailJob ? `Job ${detailJob.id.slice(0, 8)} — ${detailJob.name}` : "Background jobs")
				.catch((error: unknown) => {
					if (!this.disposed) {
						this.error = String(error);
						this.controls.invalidate();
					}
				});
			if (!id) {
				const selectedId = this.jobs[this.selected]?.id;
				this.jobs = jobs.toSorted((a, b) => Number(isRunningJob(b)) - Number(isRunningJob(a)));
				const selected = this.jobs.findIndex((job) => job.id === selectedId);
				this.selected = selected < 0 ? Math.max(0, Math.min(this.selected, jobs.length - 1)) : selected;
			}
			this.updateClock(jobs);
			const wanted = new Set(
				jobs
					.filter(
						(job) =>
							isActiveJob(job) ||
							job.id === this.detail ||
							job.naming?.status === "pending" ||
							job.naming?.status === "running",
					)
					.map((job) => job.id),
			);
			for (const [id, stop] of this.watches)
				if (!wanted.has(id)) {
					stop();
					this.watches.delete(id);
				}
			for (const id of wanted)
				if (!this.watches.has(id))
					this.watches.set(
						id,
						this.manager.watch(id, () => this.scheduleRefresh()),
					);
			if (this.detail) {
				const log = this.manager.logs(this.detail, 2000);
				if (log.text !== this.log) {
					this.log = log.text;
					this.output.setText(cleanLog(this.log));
				}
				this.logTruncated = log.truncated;
			}
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.refreshing = false;
			if (!this.disposed) this.controls.invalidate();
			if (this.refreshAgain) {
				this.refreshAgain = false;
				this.scheduleRefresh();
			}
		}
	}
}

function isActiveJob(job: JobInfo): boolean {
	return job.runtime.state === "starting" || job.runtime.state === "running" || job.runtime.state === "unreachable";
}

function isRunningJob(job: JobInfo): boolean {
	return job.runtime.state === "starting" || job.runtime.state === "running";
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
}

function singleLine(text: string, width: number): string {
	return truncateToWidth(clean(text).replace(/\n/g, "\\n"), width);
}

/** Keep SGR styling only at the untrusted process-output display boundary. */
function cleanLog(text: string): string {
	// Consume complete control strings and unfinished tails, not just their introducers.
	const escapes =
		/(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?|\x1b[ -/]*[0-~]?/g;
	const parts: string[] = [];
	let start = 0;
	for (const match of text.matchAll(escapes)) {
		parts.push(cleanLogText(text.slice(start, match.index)));
		// Numeric SGR cannot move the cursor or change terminal modes. Normalize C1 CSI
		// so TUI's ANSI-aware wrapping can restore styles on each continuation line.
		const sgr = /^(?:\x1b\[|\x9b)([\d;]*)m$/.exec(match[0]);
		if (sgr) parts.push(`\x1b[${sgr[1]}m`);
		start = match.index + match[0].length;
	}
	parts.push(cleanLogText(text.slice(start)));
	return parts.join("");
}

function cleanLogText(text: string): string {
	return sanitizeBinaryOutput(text)
		.replace(/[\x7f-\x9f]/g, "")
		.replace(/\r\n?/g, "\n");
}

function duration(job: JobInfo): string {
	const runtime = job.runtime;
	const end =
		runtime.state === "completed" ||
		runtime.state === "failed" ||
		runtime.state === "stopped" ||
		runtime.state === "timed_out"
			? runtime.endedAt
			: Date.now();
	return `${Math.max(0, (end - job.runtime.startedAt) / 1000).toFixed(1)}s`;
}
