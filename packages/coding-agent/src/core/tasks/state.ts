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
	parentId: Type.Optional(Type.Integer({ minimum: 1 })),
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
export type TaskAddition = { title: string; status?: TaskStatus; parentId?: number };
export type TaskUpdate = { id: number; title?: string; status?: TaskStatus; parentId?: number | null };
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
	const hierarchyError = taskHierarchyError(value.tasks);
	if (hierarchyError) throw new Error(`Invalid persisted tasks hierarchy: ${hierarchyError}`);
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
		const currentIds = new Set(current.tasks.map((task) => task.id));
		if (mutation.action === "add") {
			if (!mutation.tasks.length) throw new Error("tasks add requires at least one task");
			const added: Task[] = mutation.tasks.map((task) => {
				if (task.parentId !== undefined && !currentIds.has(task.parentId))
					throw new Error(`Parent task #${task.parentId} must already exist before this add batch`);
				return {
					id: nextId++,
					title: taskTitle(task.title),
					status: task.status ?? "pending",
					...(task.parentId === undefined ? {} : { parentId: task.parentId }),
				};
			});
			tasks = [...current.tasks, ...added];
		} else {
			if (!mutation.updates.length) throw new Error("tasks update requires at least one update");
			const patches = new Map<number, TaskUpdate>();
			for (const update of mutation.updates) {
				if (patches.has(update.id)) throw new Error(`Duplicate task #${update.id} in update batch`);
				if (!currentIds.has(update.id)) throw new Error(`Task #${update.id} not found`);
				if (update.title === undefined && update.status === undefined && update.parentId === undefined)
					throw new Error(`Task #${update.id} update requires title, status, or parentId`);
				patches.set(update.id, {
					...update,
					...(update.title === undefined ? {} : { title: taskTitle(update.title) }),
				});
			}
			tasks = current.tasks.map((task) => {
				const patch = patches.get(task.id);
				if (!patch) return task;
				const updated = { ...task };
				if (patch.title !== undefined) updated.title = patch.title;
				if (patch.status !== undefined) updated.status = patch.status;
				if (patch.parentId === null) delete updated.parentId;
				else if (patch.parentId !== undefined) updated.parentId = patch.parentId;
				return updated;
			});
		}
		const hierarchyError = taskHierarchyError(tasks);
		if (hierarchyError) throw new Error(hierarchyError);
		const next: TaskSnapshot = { version: 1, revision: current.revision + 1, nextId, tasks };
		// No await inside this read/patch/append/publish window: parallel calls cannot overwrite a stale list.
		persist(next);
		this.snapshot = next;
		for (const listener of this.listeners) listener();
		return next;
	}
}

function taskHierarchyError(tasks: readonly Task[]): string | undefined {
	// Cross-field trust boundary: schemas cannot guarantee existing parents or an acyclic final graph.
	const parents = new Map(tasks.map((task) => [task.id, task.parentId]));
	for (const task of tasks) {
		if (task.parentId === task.id) return `Task #${task.id} cannot be its own parent`;
		if (task.parentId !== undefined && !parents.has(task.parentId))
			return `Parent task #${task.parentId} for task #${task.id} not found`;
	}
	const visited = new Set<number>();
	for (const task of tasks) {
		if (visited.has(task.id)) continue;
		const path = new Set<number>();
		let id: number | undefined = task.id;
		while (id !== undefined && !visited.has(id)) {
			if (path.has(id)) return `Task hierarchy contains a cycle at #${id}`;
			path.add(id);
			id = parents.get(id);
		}
		for (const id of path) visited.add(id);
	}
	return undefined;
}

function taskTitle(title: string): string {
	const trimmed = title.trim();
	if (!trimmed) throw new Error("Task title must not be blank");
	return trimmed;
}
