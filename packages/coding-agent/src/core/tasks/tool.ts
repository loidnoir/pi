// Model-facing task metadata edits; this tool never starts or executes work.
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	renderTasksCall,
	renderTasksResult,
	TasksResultSchema,
	type TasksToolDetails,
	taskStateText,
} from "./render.ts";
import { type TaskSnapshot, TaskStatusSchema, type TaskStore } from "./state.ts";

export const tasksParameters = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("update")]),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String({ minLength: 1, maxLength: 500 }),
				status: Type.Optional(TaskStatusSchema),
			}),
			{ minItems: 1, description: "New tasks for add; status defaults to pending" },
		),
	),
	updates: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Integer({ minimum: 1 }),
				title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
				status: Type.Optional(TaskStatusSchema),
			}),
			{ minItems: 1, description: "Targeted patches for update; unchanged fields and other tasks are preserved" },
		),
	),
});
export type TasksToolInput = Static<typeof tasksParameters>;

/** Create branch-local list/add/update controls with full structured state on success and failure. */
export function createTasksToolDefinition(
	store: TaskStore,
	persist: (snapshot: TaskSnapshot) => void,
	assertAvailable: () => void,
): ToolDefinition<typeof tasksParameters, TasksToolDetails, unknown> {
	return {
		name: "tasks",
		label: "Tasks",
		description:
			"Manage the current conversation branch's task list. list returns all tasks; add appends tasks with stable IDs; update applies targeted title/status patches atomically. Statuses: pending, in_progress, completed, cancelled. Multiple tasks may be in_progress for parallel work. Retain obsolete work as cancelled, never delete it. Tasks are planning metadata only: adding or updating a task does not execute work, start jobs, or delegate agents.",
		promptSnippet: "Maintain the current session branch's task list and progress",
		promptGuidelines: [
			"Use tasks for moderate multi-step work; do not create ceremonial tasks for trivial requests. Keep task titles concrete and mark current work in_progress.",
			"Update tasks as work progresses and when the user steers: adapt titles, add new work, and cancel obsolete work rather than removing it. Multiple in_progress tasks are allowed for parallel work.",
			"Parallel tasks results on the current branch can be ordered differently from state commits; use the highest snapshot revision or tasks list rather than assuming the last result is newest.",
			"Mark tasks completed only after verifying actual outcomes. A launch acknowledgment is not completion; cancelled tasks are not completed. Task metadata never executes or auto-starts work.",
			"After compaction or recovery, call tasks list before relying on task state; also use tasks list whenever current state is uncertain. /tasks is a view-only monitor; edit task state through tasks.",
		],
		parameters: tasksParameters,
		outputSchema: TasksResultSchema,
		renderCall: renderTasksCall,
		renderResult: renderTasksResult,
		async execute(_id, params, signal) {
			assertAvailable();
			let error: string | undefined;
			try {
				signal?.throwIfAborted();
				// Trust boundary: schema-checked parameters require action-specific fields and disallow mixed actions.
				if (params.action === "list") {
					if (params.tasks || params.updates) throw new Error("tasks list does not accept tasks or updates");
				} else if (params.action === "add") {
					if (!params.tasks || params.updates)
						throw new Error("tasks add requires tasks and does not accept updates");
					store.apply({ action: "add", tasks: params.tasks }, persist, signal);
				} else {
					if (!params.updates || params.tasks)
						throw new Error("tasks update requires updates and does not accept tasks");
					store.apply({ action: "update", updates: params.updates }, persist, signal);
				}
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
			}
			const details: TasksToolDetails = {
				action: params.action,
				snapshot: store.getSnapshot(),
				...(error ? { error } : {}),
			};
			return {
				content: [{ type: "text", text: (error ? `Error: ${error}\n\n` : "") + taskStateText(details.snapshot) }],
				details,
				structuredContent: details,
				...(error ? { isError: true } : {}),
			};
		},
	};
}
