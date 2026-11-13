// Compact native task tool rows and shared themed task labels.
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { iconPrefix } from "../../modes/interactive/icons.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { ToolRenderContext, ToolRenderResultOptions } from "../extensions/types.ts";
import { actionBlock, compactPreview, expandedResultText, resultText } from "../jobs/action-block.ts";
import { type Task, type TaskSnapshot, TaskSnapshotSchema } from "./state.ts";

export const TasksResultSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("update")]),
	snapshot: TaskSnapshotSchema,
	error: Type.Optional(Type.String()),
});
export type TasksToolDetails = Static<typeof TasksResultSchema>;

const resultValidator = Compile(TasksResultSchema);
const callValidator = Compile(Type.Object({ action: Type.Optional(Type.String()) }));

/** Render a native tool header, tolerating unvalidated streaming arguments. */
export function renderTasksCall(args: unknown, theme: Theme, context: ToolRenderContext<unknown, unknown>) {
	// Trust boundary: provider arguments may be incomplete before schema validation.
	const action = callValidator.Check(args) ? args.action : undefined;
	const title =
		action === "add"
			? "Add tasks"
			: action === "update"
				? "Update tasks"
				: action === "list"
					? "List tasks"
					: "Tasks";
	return actionBlock(context, () => ({
		kind: "call",
		heading: theme.fg("toolTitle", theme.bold(`${iconPrefix("tasks")}${title}`)),
		expandedText: context.expanded ? JSON.stringify(args, null, 2) : undefined,
	}));
}

/** Keep task results compact while expansion preserves original text and full structured details. */
export function renderTasksResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<unknown, unknown>,
) {
	// Trust boundary: resumed results and results changed by other extensions contain unknown details.
	const details = resultValidator.Check(result.details) ? result.details : undefined;
	return actionBlock(context, () => ({
		kind: "result",
		heading: theme.fg(
			context.isError || result.isError ? "error" : "muted",
			details?.error ?? (details ? taskSummary(details.snapshot) : options.isPartial ? "Updating tasks…" : "Tasks"),
		),
		preview: details
			? details.snapshot.tasks
					.filter((task) => task.status === "in_progress")
					.slice(0, 2)
					.map((task) => taskRow(task, theme))
					.join("\n")
			: compactPreview(resultText(result)),
		expandedText: options.expanded ? expandedResultText(result) : undefined,
		hint: !options.expanded ? theme.fg("dim", context.keyHint("app.tools.expand", "to expand")) : undefined,
	}));
}

/** Summarize completion without counting cancelled work as done. */
export function taskSummary(snapshot: TaskSnapshot): string {
	const completed = snapshot.tasks.filter((task) => task.status === "completed").length;
	const cancelled = snapshot.tasks.filter((task) => task.status === "cancelled").length;
	const active = snapshot.tasks.filter((task) => task.status === "in_progress").length;
	return `${completed}/${snapshot.tasks.length - cancelled} completed${active ? ` · ${active} active` : ""}${cancelled ? ` · ${cancelled} cancelled` : ""}`;
}

/** Render task status using live icons and theme colors, with untrusted title controls removed. */
export function taskRow(task: Task, theme: Theme): string {
	const { prefix, label } = taskParts(task, theme);
	return prefix + label;
}

function taskParts(task: Task, theme: Theme): { prefix: string; label: string } {
	const prefix =
		task.status === "completed"
			? theme.fg("success", iconPrefix("checkboxChecked"))
			: task.status === "in_progress"
				? theme.fg("accent", iconPrefix("checkboxUnchecked"))
				: task.status === "cancelled"
					? theme.fg("muted", iconPrefix("checkboxCancelled"))
					: theme.fg("muted", iconPrefix("checkboxUnchecked"));
	const title = sanitizeBinaryOutput(stripAnsi(task.title)).replace(/[\r\n\t]/gu, " ");
	const label = `#${task.id} ${title}`;
	const styled =
		task.status === "completed"
			? theme.fg("success", theme.strikethrough(label))
			: task.status === "in_progress"
				? theme.fg("accent", theme.bold(label))
				: task.status === "cancelled"
					? theme.fg("muted", `${theme.strikethrough(label)} (cancelled)`)
					: theme.fg("muted", label);
	return { prefix, label: styled };
}

/** Render the shared TODO root and nested task progress header. */
export function taskTreeHeader(snapshot: TaskSnapshot, width: number, theme: Theme, hint = ""): string[] {
	if (width <= 0) return [];
	return [
		theme.fg("accent", theme.bold("TODO")),
		`${theme.fg("muted", "└─ ")}${theme.fg("accent", theme.bold("Tasks"))}${theme.fg("muted", ` · ${taskSummary(snapshot)}`)}${hint ? theme.fg("dim", ` · ${hint}`) : ""}`,
	].map((line) => truncateToWidth(line, width));
}

/** Lay out connected leaves with hanging labels measured in terminal columns. */
export function taskTreeLeaves(tasks: readonly Task[], width: number, theme: Theme): string[] {
	if (width <= 0) return [];
	return tasks.flatMap((task, index) => {
		const last = index === tasks.length - 1;
		const { prefix: markerPrefix, label } = taskParts(task, theme);
		const guide = theme.fg("muted", `   ${last ? "└" : "├"}─ `);
		const prefix = guide + markerPrefix;
		const available = width - visibleWidth(prefix);
		if (available < 1) return [truncateToWidth(prefix + label, width)];
		const continuation = theme.fg("muted", `   ${last ? " " : "│"}  ${" ".repeat(visibleWidth(markerPrefix))}`);
		return wrapTextWithAnsi(label, available).map((line, lineIndex) =>
			truncateToWidth((lineIndex ? continuation : prefix) + line, width),
		);
	});
}

/** Include every task and stable ID in model-facing evidence. */
export function taskStateText(snapshot: TaskSnapshot): string {
	return `Tasks revision ${snapshot.revision}: ${taskSummary(snapshot)}\n${snapshot.tasks.length ? snapshot.tasks.map((task) => `#${task.id} [${task.status}] ${JSON.stringify(task.title)}`).join("\n") : "No tasks."}`;
}
