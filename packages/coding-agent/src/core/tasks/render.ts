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
import { parseTaskSnapshot, type Task, type TaskSnapshot, TaskSnapshotSchema } from "./state.ts";

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
	// Trust boundary: historical and extension-edited details need both structural and graph validation.
	let details: TasksToolDetails | undefined;
	if (resultValidator.Check(result.details)) {
		try {
			parseTaskSnapshot(result.details.snapshot);
			details = result.details;
		} catch {
			// Invalid historical details fall back to the original result text.
		}
	}
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

/** Render a standalone task with its parent ID, live styling, and sanitized title. */
export function taskRow(task: Task, theme: Theme): string {
	const { prefix, label } = taskParts(task, theme, task.parentId === undefined ? "" : ` (parent #${task.parentId})`);
	return prefix + label;
}

function taskParts(task: Task, theme: Theme, context = ""): { prefix: string; label: string } {
	const prefix =
		task.status === "completed"
			? theme.fg("success", iconPrefix("checkboxChecked"))
			: task.status === "in_progress"
				? theme.fg("accent", iconPrefix("checkboxUnchecked"))
				: task.status === "cancelled"
					? theme.fg("muted", iconPrefix("checkboxCancelled"))
					: theme.fg("muted", iconPrefix("checkboxUnchecked"));
	const title = sanitizeBinaryOutput(stripAnsi(task.title)).replace(/[\r\n\t]/gu, " ");
	const label = `#${task.id}${context} ${title}`;
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

/** Lay out a valid forest in stable sibling order, with bounded guides and hanging labels. */
export function taskTreeLeaves(tasks: readonly Task[], width: number, theme: Theme): string[] {
	const children = taskChildren(tasks);
	return renderTaskTree(children, children, width, theme, "wrapped");
}

/** Render selected tasks in tree order, retaining full progress and explicit omitted-parent context. */
export function taskTreePreview(
	tasks: readonly Task[],
	selected: readonly Task[],
	width: number,
	theme: Theme,
): string[] {
	const fullChildren = taskChildren(tasks);
	const selectedIds = new Set(selected.map((task) => task.id));
	const children = new Map<number | undefined, Task[]>();
	const pending = [...(fullChildren.get(undefined) ?? [])].reverse();
	while (pending.length) {
		const task = pending.pop()!;
		if (selectedIds.has(task.id)) {
			const parent = task.parentId !== undefined && selectedIds.has(task.parentId) ? task.parentId : undefined;
			const siblings = children.get(parent);
			if (siblings) siblings.push(task);
			else children.set(parent, [task]);
		}
		const descendants = fullChildren.get(task.id) ?? [];
		for (let index = descendants.length - 1; index >= 0; index--) pending.push(descendants[index]);
	}
	return renderTaskTree(children, fullChildren, width, theme, "compact");
}

function taskChildren(tasks: readonly Task[]): Map<number | undefined, Task[]> {
	const children = new Map<number | undefined, Task[]>();
	for (const task of tasks) {
		const siblings = children.get(task.parentId);
		if (siblings) siblings.push(task);
		else children.set(task.parentId, [task]);
	}
	return children;
}

function renderTaskTree(
	children: Map<number | undefined, Task[]>,
	fullChildren: Map<number | undefined, Task[]>,
	width: number,
	theme: Theme,
	layout: "compact" | "wrapped",
): string[] {
	if (width <= 0) return [];
	const frames = [{ tasks: children.get(undefined) ?? [], index: 0 }];
	const lines: string[] = [];
	// Iterative traversal avoids recursion and never builds an offscreen, depth-sized indent.
	while (frames.length) {
		const frame = frames[frames.length - 1];
		if (frame.index === frame.tasks.length) {
			frames.pop();
			continue;
		}
		const task = frame.tasks[frame.index++];
		const last = frame.index === frame.tasks.length;
		const depth = frames.length - 1;
		const markerWidth = visibleWidth(iconPrefix("checkboxUnchecked"));
		// Reserve useful label space before spending terminal columns on ancestor guides.
		const guideBudget = Math.max(0, width - markerWidth - 12);
		const keptAncestors = Math.min(depth, Math.max(0, Math.floor((guideBudget - 6) / 3)));
		const abbreviated = keptAncestors < depth;
		let ancestors = guideBudget >= 6 ? (abbreviated ? " … " : "   ") : "";
		for (let index = depth - keptAncestors; index < depth; index++)
			ancestors += frames[index].index < frames[index].tasks.length ? "│  " : "   ";
		const branch = guideBudget >= 3 ? `${last ? "└" : "├"}─ ` : "";
		const guide = theme.fg("muted", ancestors + branch);
		const { prefix: markerPrefix, label: taskLabel } = taskParts(
			task,
			theme,
			abbreviated || (depth === 0 && task.parentId !== undefined) ? ` (parent #${task.parentId})` : "",
		);
		const descendants = children.get(task.id);
		const allDescendants = fullChildren.get(task.id);
		const label = taskLabel + (allDescendants ? childProgress(allDescendants, theme) : "");
		const prefix = guide + markerPrefix;
		const available = width - visibleWidth(prefix);
		if (layout === "compact" || available < 1) lines.push(truncateToWidth(prefix + label, width));
		else {
			const continuation = theme.fg(
				"muted",
				ancestors + (branch ? `${last ? " " : "│"}  ` : "") + " ".repeat(visibleWidth(markerPrefix)),
			);
			for (const [index, line] of wrapTextWithAnsi(label, available).entries())
				lines.push(truncateToWidth((index ? continuation : prefix) + line, width));
		}
		if (descendants) frames.push({ tasks: descendants, index: 0 });
	}
	return lines;
}

function childProgress(children: readonly Task[], theme: Theme): string {
	let completed = 0;
	let cancelled = 0;
	for (const child of children) {
		if (child.status === "completed") completed++;
		else if (child.status === "cancelled") cancelled++;
	}
	return theme.fg(
		"muted",
		` · children ${completed}/${children.length - cancelled} completed${cancelled ? ` · ${cancelled} cancelled` : ""}`,
	);
}

/** Include every task and stable ID in model-facing evidence. */
export function taskStateText(snapshot: TaskSnapshot): string {
	return `Tasks revision ${snapshot.revision}: ${taskSummary(snapshot)}\n${snapshot.tasks.length ? snapshot.tasks.map((task) => `#${task.id} [${task.status}] ${JSON.stringify(task.title)}${task.parentId === undefined ? "" : ` (parent #${task.parentId})`}`).join("\n") : "No tasks."}`;
}
