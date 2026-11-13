// Branch-local task snapshots and synchronous, persist-before-publish mutations.
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { SessionEntry } from "../session-manager.ts";

export const TASKS_ENTRY_TYPE = "pi.tasks";

export const TaskStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
]);

export const TaskSchema = Type.Object({
	id: Type.Integer({ minimum: 1 }),
	title: Type.String({ minLength: 1, maxLength: 500 }),
	status: TaskStatusSchema,
});

export const TaskSnapshotSchema = Type.Object({
	version: Type.Literal(1),
	revision: Type.Integer({ minimum: 0 }),
	nextId: Type.Integer({ minimum: 1 }),
	tasks: Type.Array(TaskSchema),
});

export type Task = Static<typeof TaskSchema>;
export type TaskStatus = Task["status"];
export type TaskSnapshot = Static<typeof TaskSnapshotSchema>;
export type TaskAddition = { title: string; status?: TaskStatus };
export type TaskUpdate = { id: number; title?: string; status?: TaskStatus };
export type TaskMutation = { action: "add"; tasks: TaskAddition[] } | { action: "update"; updates: TaskUpdate[] };

const snapshotValidator = Compile(TaskSnapshotSchema);

/** Decode persisted snapshots, including invariants JSON Schema cannot express. */
export function parseTaskSnapshot(value: unknown): TaskSnapshot {
	// Trust boundary: custom session entries are unknown, potentially edited disk data.
	if (!snapshotValidator.Check(value)) throw new Error("Invalid persisted tasks snapshot");
	const ids = new Set<number>();
	for (const task of value.tasks) {
		if (ids.has(task.id) || task.id >= value.nextId || !task.title.trim())
			throw new Error("Invalid persisted tasks IDs or title");
		ids.add(task.id);
	}
	return value;
}

/** Recover only authoritative custom entries on the supplied active branch. */
export function restoreTasks(branch: readonly SessionEntry[]): TaskSnapshot {
	let snapshot: TaskSnapshot = { version: 1, revision: 0, nextId: 1, tasks: [] };
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === TASKS_ENTRY_TYPE) snapshot = parseTaskSnapshot(entry.data);
	}
	return snapshot;
}

/** Own immutable-by-convention state; each targeted batch persists before subscribers see it. */
export class TaskStore {
	private snapshot: TaskSnapshot = { version: 1, revision: 0, nextId: 1, tasks: [] };
	private readonly listeners = new Set<() => void>();

	getSnapshot(): TaskSnapshot {
		return this.snapshot;
	}

	restore(branch: readonly SessionEntry[]): void {
		this.snapshot = restoreTasks(branch);
		for (const listener of this.listeners) listener();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	apply(mutation: TaskMutation, persist: (snapshot: TaskSnapshot) => void, signal?: AbortSignal): TaskSnapshot {
		signal?.throwIfAborted();
		const current = this.snapshot;
		let nextId = current.nextId;
		let tasks: Task[];
		// Trust boundary: schema-checked tool arguments still need batch and cross-field validation.
		if (mutation.action === "add") {
			if (!mutation.tasks.length) throw new Error("tasks add requires at least one task");
			const added = mutation.tasks.map((task) => ({
				id: nextId++,
				title: taskTitle(task.title),
				status: task.status ?? "pending",
			}));
			tasks = [...current.tasks, ...added];
		} else {
			if (!mutation.updates.length) throw new Error("tasks update requires at least one update");
			const patches = new Map<number, TaskUpdate>();
			for (const update of mutation.updates) {
				if (patches.has(update.id)) throw new Error(`Duplicate task #${update.id} in update batch`);
				if (!current.tasks.some((task) => task.id === update.id)) throw new Error(`Task #${update.id} not found`);
				if (update.title === undefined && update.status === undefined)
					throw new Error(`Task #${update.id} update requires title or status`);
				patches.set(update.id, {
					...update,
					...(update.title === undefined ? {} : { title: taskTitle(update.title) }),
				});
			}
			tasks = current.tasks.map((task) => {
				const patch = patches.get(task.id);
				return patch ? { ...task, ...patch } : task;
			});
		}
		const next: TaskSnapshot = { version: 1, revision: current.revision + 1, nextId, tasks };
		// No await inside this read/patch/append/publish window: parallel calls cannot overwrite a stale list.
		persist(next);
		this.snapshot = next;
		for (const listener of this.listeners) listener();
		return next;
	}
}

function taskTitle(title: string): string {
	const trimmed = title.trim();
	if (!trimmed) throw new Error("Task title must not be blank");
	return trimmed;
}
