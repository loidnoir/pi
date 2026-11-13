// Display native job controls and completion notices without changing execution or model-visible output.
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { icon } from "../../modes/interactive/icons.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { MessageRenderer, ToolRenderContext, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	ActionBlock,
	actionBlock,
	compactPreview,
	expandedResultText,
	resultText,
	stateColor,
	stateLabel,
} from "./action-block.ts";
import { JobProgressSchema } from "./state.ts";

const argsSchema = Type.Object({
	action: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	command: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	all: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
});
const argsValidator = Compile(argsSchema);
const jobSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	command: Type.String(),
	runtime: Type.Object({
		state: Type.String(),
		error: Type.Optional(Type.String()),
		exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	}),
	progress: Type.Optional(JobProgressSchema),
	progressError: Type.Optional(Type.String()),
	logPath: Type.Optional(Type.String()),
});
const resultSchema = Type.Object({
	jobs: Type.Optional(Type.Array(jobSchema)),
	job: Type.Optional(jobSchema),
	log: Type.Optional(Type.Object({ text: Type.String(), path: Type.String(), truncated: Type.Boolean() })),
	deleted: Type.Optional(Type.String()),
});
const resultValidator = Compile(resultSchema);

/** The persisted job output fields used for display, allowing future state names to stay visible. */
export type JobsRenderResult = Static<typeof resultSchema>;

/** Render every native job action, tolerating arguments still streaming from a provider. */
export function renderJobsCall(args: unknown, theme: Theme, context: ToolRenderContext<unknown, unknown>): ActionBlock {
	// Renderer trust boundary: streamed arguments have not passed the tool's parameter schema yet.
	const input: Static<typeof argsSchema> = argsValidator.Check(args) ? args : {};
	const labels: Record<string, string> = {
		list: "List jobs",
		inspect: "Inspect job",
		logs: "Read job logs",
		stop: "Stop job",
		rename: "Rename job",
		restart: "Restart job",
		delete: "Delete job",
	};
	return actionBlock(context, () => ({
		heading:
			theme.fg("toolTitle", theme.bold(`${icon("job")} ${labels[input.action ?? ""] ?? "Jobs"}`)) +
			theme.fg("accent", input.id ? ` · ${input.id.slice(0, 8)}` : input.all ? " · all projects" : ""),
		preview:
			input.name || input.command ? theme.fg("muted", compactPreview(input.name ?? input.command ?? "")) : undefined,
		expandedText: context.expanded ? JSON.stringify(args, null, 2) : undefined,
	}));
}

/** Show real worker state and progress, not completion inferred from an action acknowledgment. */
export function renderJobsResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<unknown, unknown>,
): ActionBlock {
	const raw = resultText(result);
	const output = decodeResult(raw);
	return actionBlock(context, () => {
		const summary = summarize(output, raw, options.isPartial, context.isError || result.isError === true);
		return {
			heading: theme.fg(summary.color, summary.heading),
			preview: theme.fg(summary.color === "error" ? "error" : "toolOutput", compactPreview(summary.preview)),
			expandedText: options.expanded ? expandedResultText(result) : undefined,
			hint: !options.expanded && raw ? theme.fg("dim", context.keyHint("app.tools.expand", "to expand")) : undefined,
		};
	});
}

/** Present completion state and retained-output location while preserving the original notice on expansion. */
export const renderJobMessage: MessageRenderer = (message, options, theme) => {
	const raw = contentText(message.content);
	const notice = /^Background job (\S+) \((.*)\): ([^\n.]+)\. Full output: ([\s\S]*)$/u.exec(raw);
	const status = notice?.[3] ?? "unknown";
	let name = "";
	if (notice) {
		try {
			// Renderer trust boundary: the persisted notice stores its name as a JSON string.
			const value: unknown = JSON.parse(notice[2]);
			if (typeof value === "string") name = value;
		} catch {
			name = notice[2];
		}
	}
	return new ActionBlock(
		() => ({
			heading:
				theme.fg(
					"customMessageLabel",
					theme.bold(`${icon("job")} Job${notice ? ` ${notice[1].slice(0, 8)}` : ""}`),
				) +
				theme.fg(stateColor(status), ` · ${stateLabel(status)}`) +
				(name ? theme.fg("muted", ` · ${compactPreview(name)}`) : ""),
			preview: theme.fg("customMessageText", compactPreview(notice ? `Full output: ${notice[4]}` : raw)),
			expandedText: options.expanded
				? raw + (message.details === undefined ? "" : `\n\n${JSON.stringify(message.details, null, 2)}`)
				: undefined,
			hint: !options.expanded ? theme.fg("dim", options.keyHint("app.tools.expand", "to expand")) : undefined,
		}),
		options.outputPad,
		(text) => theme.bg("customMessageBg", text),
	);
};

function decodeResult(raw: string): JobsRenderResult | undefined {
	// Native deletion deliberately returns plain text rather than the JSON used by other actions.
	const deleted = /^Deleted job ([a-f0-9-]{36}) and its logs$/u.exec(raw);
	if (deleted) return { deleted: deleted[1] };
	try {
		// Renderer trust boundary: resumed tool content is JSON text, not a typed in-process result.
		const value: unknown = JSON.parse(raw);
		return resultValidator.Check(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function summarize(
	output: JobsRenderResult | undefined,
	raw: string,
	partial: boolean,
	isError: boolean,
): { heading: string; preview: string; color: ReturnType<typeof stateColor> } {
	if (isError) return { heading: "Job error", preview: raw || "No error details", color: "error" };
	if (output?.job) {
		const job = output.job;
		const error = job.runtime.error ?? job.progressError;
		const progress = job.progress
			? ` · ${job.progress.percent}%${job.progress.message ? ` ${job.progress.message}` : ""}`
			: "";
		const exit =
			job.runtime.exitCode === undefined || job.runtime.exitCode === null ? "" : ` · exit ${job.runtime.exitCode}`;
		return {
			heading: `${stateLabel(job.runtime.state)} · ${job.id.slice(0, 8)} · ${job.name}${progress}${exit}`,
			preview: error ? `Error: ${error}` : output.log ? output.log.text || "No log output" : job.command,
			color: error ? "error" : stateColor(job.runtime.state),
		};
	}
	if (output?.jobs) {
		const failed = output.jobs.find(
			(job) => job.runtime.error || job.progressError || stateColor(job.runtime.state) === "error",
		);
		return {
			heading: output.jobs.length
				? `${output.jobs.length} background jobs${failed ? " · errors" : ""}`
				: "No background jobs",
			preview: failed
				? `${failed.id.slice(0, 8)} · ${failed.runtime.state} · ${failed.name}${failed.runtime.error || failed.progressError ? ` · Error: ${failed.runtime.error ?? failed.progressError}` : ""}`
				: output.jobs
						.slice(0, 3)
						.map(
							(job) =>
								`${job.id.slice(0, 8)} · ${job.runtime.state} · ${job.name}${job.progress ? ` · ${job.progress.percent}%` : ""}`,
						)
						.join("\n"),
			color: failed ? "error" : "muted",
		};
	}
	if (output?.deleted) return { heading: `Deleted job ${output.deleted.slice(0, 8)}`, preview: "", color: "success" };
	return {
		heading: partial ? "Waiting for job status…" : raw ? "Unrecognized job result" : "No job output",
		preview: output ? "Expand to inspect original output" : raw,
		color: partial ? "accent" : "warning",
	};
}
