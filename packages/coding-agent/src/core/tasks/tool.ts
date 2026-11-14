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
				parentId: Type.Optional(
					Type.Integer({
						minimum: 1,
						description:
							"Parent task ID from an earlier result; must exist before this add batch. Omit for a root task.",
					}),
				),
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
				parentId: Type.Optional(
					Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
						description:
							"Move under an existing task ID, or null to detach to root. Omit to preserve the parent.",
					}),
				),
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
			"Manage the current conversation branch's nested task list. list returns all tasks; add appends tasks with stable IDs and optional parentId for subtasks; update applies targeted title/status/parentId patches atomically. Parents for add must exist before the batch: create parents first, then use their returned IDs for children. Update parentId moves a task and its subtree; null detaches it to root, omission preserves its parent. The final hierarchy must have existing parents and no cycles. Statuses: pending, in_progress, completed, cancelled. Statuses are manual and independent: no automatic rollup, cascade, or completion guard; a completed or cancelled parent may have children in any status. Multiple tasks may be in_progress for parallel work. Retain obsolete work as cancelled, never delete it. Tasks are planning metadata only: adding or updating a task does not execute work, start jobs, delegate agents, or make helper model calls.",
		promptSnippet: "Maintain the current session branch's nested task list and explicit progress",
		promptGuidelines: [
			"Use tasks for moderate multi-step work; do not create ceremonial tasks for trivial requests. Keep task titles concrete and mark current work in_progress.",
			"Update tasks as work progresses and when the user steers: adapt titles, add new work, and cancel obsolete work rather than removing it. Multiple in_progress tasks are allowed for parallel work.",
			"Nest subtasks with tasks add parentId. Create parents in an earlier call, then use actual returned task IDs, never guessed IDs or parents from the same add batch. Nesting supports multiple levels.",
			"Move tasks and their descendants with tasks update parentId; use null to detach to root, or omit parentId to preserve the relationship. Parent-only updates are valid; batches are checked against the final hierarchy and cannot create cycles.",
			"Set tasks statuses explicitly and independently: no automatic rollup, cascade, or completion guard. A parent may be completed or cancelled while its children have other statuses; updating a child never changes its parent.",
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
