import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	parseTaskSnapshot,
	restoreTasks,
	TASKS_ENTRY_TYPE,
	type TaskMutation,
	type TaskSnapshot,
	TaskStore,
} from "../src/core/tasks/state.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const session = SessionManager.inMemory();
	const store = new TaskStore();
	const persist = (snapshot: TaskSnapshot) => session.appendCustomEntry(TASKS_ENTRY_TYPE, snapshot);
	return { session, store, persist };
}

describe("branch-local task snapshots", () => {
	it("keeps IDs stable, retains finished/cancelled tasks, and allows parallel active work", () => {
		const { store, persist } = fixture();
		store.apply(
			{ action: "add", tasks: [{ title: "Inspect" }, { title: "Implement" }, { title: "Old plan" }] },
			persist,
		);
		store.apply(
			{
				action: "update",
				updates: [
					{ id: 1, status: "in_progress" },
					{ id: 2, status: "in_progress" },
					{ id: 3, status: "cancelled" },
				],
			},
			persist,
		);
		store.apply(
			{
				action: "update",
				updates: [
					{ id: 1, status: "completed" },
					{ id: 2, title: "New direction" },
				],
			},
			persist,
		);
		expect(store.getSnapshot()).toEqual({
			version: 1,
			revision: 3,
			nextId: 4,
			tasks: [
				{ id: 1, title: "Inspect", status: "completed" },
				{ id: 2, title: "New direction", status: "in_progress" },
				{ id: 3, title: "Old plan", status: "cancelled" },
			],
		});
	});

	it("creates roots, siblings, and multiple levels using returned parent IDs", () => {
		const { store, persist } = fixture();
		const roots = store.apply({ action: "add", tasks: [{ title: "Plan" }, { title: "Other" }] }, persist);
		const parent = roots.tasks[0];
		const children = store.apply(
			{
				action: "add",
				tasks: [
					{ title: " Inspect ", parentId: parent.id },
					{ title: "Verify", parentId: parent.id, status: "in_progress" },
				],
			},
			persist,
		);
		const nested = store.apply(
			{ action: "add", tasks: [{ title: "Read source", parentId: children.tasks[2].id }] },
			persist,
		);
		expect(nested).toEqual({
			version: 1,
			revision: 3,
			nextId: 6,
			tasks: [
				{ id: 1, title: "Plan", status: "pending" },
				{ id: 2, title: "Other", status: "pending" },
				{ id: 3, title: "Inspect", status: "pending", parentId: 1 },
				{ id: 4, title: "Verify", status: "in_progress", parentId: 1 },
				{ id: 5, title: "Read source", status: "pending", parentId: 3 },
			],
		});
		expect(parseTaskSnapshot(nested)).toBe(nested);
		expect(roots.tasks).toHaveLength(2);
		expect(children.tasks).toHaveLength(4);
	});

	it("moves and detaches a subtree with parent-only patches without changing descendants or insertion order", () => {
		const { store, persist } = fixture();
		const roots = store.apply({ action: "add", tasks: [{ title: "Original" }, { title: "Destination" }] }, persist);
		const child = store.apply({ action: "add", tasks: [{ title: "Child", parentId: roots.tasks[0].id }] }, persist)
			.tasks[2];
		const before = store.apply(
			{ action: "add", tasks: [{ title: "Grandchild", parentId: child.id, status: "completed" }] },
			persist,
		);
		const moved = store.apply(
			{ action: "update", updates: [{ id: child.id, parentId: roots.tasks[1].id }] },
			persist,
		);
		expect(moved.tasks).toEqual(before.tasks.map((task) => (task.id === child.id ? { ...task, parentId: 2 } : task)));
		expect(before.tasks[2].parentId).toBe(1);
		expect(moved.tasks[3]).toBe(before.tasks[3]);
		const renamed = store.apply(
			{ action: "update", updates: [{ id: child.id, title: " Renamed ", status: "in_progress" }] },
			persist,
		);
		expect(renamed.tasks[2]).toEqual({ ...moved.tasks[2], title: "Renamed", status: "in_progress" });
		const detached = store.apply({ action: "update", updates: [{ id: child.id, parentId: null }] }, persist);
		expect(detached.tasks[2]).toEqual({ id: child.id, title: "Renamed", status: "in_progress" });
		expect(detached.tasks[2]).not.toHaveProperty("parentId");
		expect(detached.tasks[3]).toBe(before.tasks[3]);
		expect(detached.tasks.map((task) => task.id)).toEqual(before.tasks.map((task) => task.id));
		expect(detached.nextId).toBe(before.nextId);
		expect(detached.revision).toBe(before.revision + 3);
	});

	it("keeps every status independent without rollup, cascades, or completion guards", () => {
		const { store, persist } = fixture();
		const parent = store.apply({ action: "add", tasks: [{ title: "Parent" }] }, persist).tasks[0];
		const children = store.apply(
			{
				action: "add",
				tasks: [
					{ title: "Active", parentId: parent.id, status: "in_progress" },
					{ title: "Pending", parentId: parent.id },
				],
			},
			persist,
		);
		const grandchild = store.apply(
			{ action: "add", tasks: [{ title: "Nested", parentId: children.tasks[1].id }] },
			persist,
		).tasks[3];
		const completed = store.apply({ action: "update", updates: [{ id: parent.id, status: "completed" }] }, persist);
		expect(completed.tasks.map((task) => task.status)).toEqual(["completed", "in_progress", "pending", "pending"]);
		store.apply({ action: "update", updates: [{ id: grandchild.id, status: "completed" }] }, persist);
		expect(store.getSnapshot().tasks.map((task) => task.status)).toEqual([
			"completed",
			"in_progress",
			"pending",
			"completed",
		]);
		store.apply({ action: "update", updates: [{ id: parent.id, status: "cancelled" }] }, persist);
		expect(store.getSnapshot().tasks.map((task) => task.status)).toEqual([
			"cancelled",
			"in_progress",
			"pending",
			"completed",
		]);
		store.apply(
			{
				action: "update",
				updates: children.tasks.slice(1).map((task) => ({ id: task.id, status: "completed" })),
			},
			persist,
		);
		expect(store.getSnapshot().tasks[0].status).toBe("cancelled");
		store.apply({ action: "update", updates: [{ id: parent.id, status: "pending" }] }, persist);
		expect(store.getSnapshot().tasks.map((task) => task.status)).toEqual([
			"pending",
			"completed",
			"completed",
			"completed",
		]);
	});

	it.each([false, true])("validates multi-update moves against the final graph (reverse order: %s)", (reverse) => {
		const { store, persist } = fixture();
		const parent = store.apply({ action: "add", tasks: [{ title: "Parent" }] }, persist).tasks[0];
		const child = store.apply({ action: "add", tasks: [{ title: "Child", parentId: parent.id }] }, persist).tasks[1];
		const grandchild = store.apply({ action: "add", tasks: [{ title: "Grandchild", parentId: child.id }] }, persist)
			.tasks[2];
		const updates = [
			{ id: parent.id, parentId: grandchild.id },
			{ id: child.id, parentId: null },
		];
		const result = store.apply({ action: "update", updates: reverse ? updates.reverse() : updates }, persist);
		expect(result.tasks).toEqual([
			{ ...parent, parentId: grandchild.id },
			{ id: child.id, title: child.title, status: child.status },
			grandchild,
		]);
		expect(result).toMatchObject({ revision: 4, nextId: 4 });
		expect(parseTaskSnapshot(result)).toBe(result);
	});

	it("applies concurrent targeted calls against the latest durable state before publishing", async () => {
		const { store, persist, session } = fixture();
		store.apply({ action: "add", tasks: [{ title: "One" }, { title: "Two" }] }, persist);
		const published: TaskSnapshot[] = [];
		store.subscribe(() => {
			expect(restoreTasks(session.getBranch())).toEqual(store.getSnapshot());
			published.push(store.getSnapshot());
		});
		await Promise.all([
			Promise.resolve().then(() =>
				store.apply({ action: "update", updates: [{ id: 1, status: "in_progress" }] }, persist),
			),
			Promise.resolve().then(() =>
				store.apply({ action: "update", updates: [{ id: 2, title: "Parallel edit" }] }, persist),
			),
			Promise.resolve().then(() =>
				store.apply({ action: "update", updates: [{ id: 1, title: "Renamed" }] }, persist),
			),
		]);
		expect(published.map((snapshot) => snapshot.revision)).toEqual([2, 3, 4]);
		expect(store.getSnapshot().tasks).toEqual([
			{ id: 1, title: "Renamed", status: "in_progress" },
			{ id: 2, title: "Parallel edit", status: "pending" },
		]);
	});

	it("does not partially apply invalid, aborted, or failed-persistence batches", () => {
		const { store, persist } = fixture();
		store.apply({ action: "add", tasks: [{ title: "One" }] }, persist);
		const before = store.getSnapshot();
		const published = vi.fn();
		store.subscribe(published);
		const invalid: TaskMutation[] = [
			{
				action: "update",
				updates: [
					{ id: 1, status: "completed" },
					{ id: 99, status: "cancelled" },
				],
			},
			{
				action: "update",
				updates: [
					{ id: 1, status: "completed" },
					{ id: 1, status: "cancelled" },
				],
			},
			{ action: "update", updates: [{ id: 1 }] },
			{ action: "add", tasks: [{ title: "Valid" }, { title: "  " }] },
		];
		for (const batch of invalid) expect(() => store.apply(batch, persist)).toThrow();
		expect(() =>
			store.apply({ action: "add", tasks: [{ title: "Aborted" }] }, persist, AbortSignal.abort()),
		).toThrow();
		expect(() =>
			store.apply({ action: "update", updates: [{ id: 1, status: "completed" }] }, () => {
				throw new Error("Disk full");
			}),
		).toThrow("Disk full");
		expect(store.getSnapshot()).toBe(before);
		expect(published).not.toHaveBeenCalled();
	});

	it("rejects invalid hierarchy batches without persisting, publishing, or consuming IDs", () => {
		const { store, persist, session } = fixture();
		const roots = store.apply({ action: "add", tasks: [{ title: "Parent" }, { title: "Other" }] }, persist);
		const parent = roots.tasks[0];
		const other = roots.tasks[1];
		const child = store.apply({ action: "add", tasks: [{ title: "Child", parentId: parent.id }] }, persist).tasks[2];
		const before = store.apply({ action: "add", tasks: [{ title: "Grandchild", parentId: child.id }] }, persist);
		const grandchild = before.tasks[3];
		const durableLeaf = session.getLeafId();
		const storage = vi.fn(persist);
		const published = vi.fn();
		store.subscribe(published);
		const invalid: TaskMutation[] = [
			{
				action: "add",
				tasks: [
					{ title: "Valid", parentId: parent.id },
					{ title: "Missing", parentId: 99 },
				],
			},
			{ action: "add", tasks: [{ title: "New parent" }, { title: "New child", parentId: before.nextId }] },
			{ action: "add", tasks: [{ title: "Forward child", parentId: before.nextId + 1 }, { title: "New parent" }] },
			{ action: "add", tasks: [{ title: "Self", parentId: before.nextId }] },
			{ action: "update", updates: [{ id: child.id, parentId: 99 }] },
			{ action: "update", updates: [{ id: child.id, parentId: child.id }] },
			{ action: "update", updates: [{ id: parent.id, parentId: grandchild.id }] },
			{
				action: "update",
				updates: [
					{ id: parent.id, parentId: other.id, status: "completed" },
					{ id: other.id, parentId: parent.id },
				],
			},
			{
				action: "update",
				updates: [
					{ id: child.id, parentId: null, title: "Valid edit" },
					{ id: other.id, parentId: 99 },
				],
			},
			{ action: "update", updates: [{ id: 99, parentId: null }] },
			{
				action: "update",
				updates: [
					{ id: child.id, parentId: null },
					{ id: child.id, parentId: other.id },
				],
			},
		];
		for (const mutation of invalid) {
			expect(() => store.apply(mutation, storage)).toThrow();
			expect(store.getSnapshot()).toBe(before);
			expect(session.getLeafId()).toBe(durableLeaf);
		}
		expect(storage).not.toHaveBeenCalled();
		expect(published).not.toHaveBeenCalled();
		expect(() =>
			store.apply({ action: "update", updates: [{ id: child.id, parentId: other.id }] }, () => {
				throw new Error("Disk full");
			}),
		).toThrow("Disk full");
		expect(store.getSnapshot()).toBe(before);
		expect(published).not.toHaveBeenCalled();
		const after = store.apply({ action: "add", tasks: [{ title: "Next", parentId: child.id }] }, storage);
		expect(after.tasks.at(-1)?.id).toBe(before.nextId);
		expect(after).toMatchObject({ revision: before.revision + 1, nextId: before.nextId + 1 });
		expect(storage).toHaveBeenCalledOnce();
		expect(published).toHaveBeenCalledOnce();
	});

	it("reconstructs only the selected branch, including fork and compaction history", () => {
		const { store, session, persist } = fixture();
		store.apply({ action: "add", tasks: [{ title: "Shared" }] }, persist);
		const root = session.getLeafId()!;
		store.apply({ action: "add", tasks: [{ title: "Abandoned" }] }, persist);
		const abandoned = session.getLeafId()!;
		session.branch(root);
		store.restore(session.getBranch());
		store.apply({ action: "add", tasks: [{ title: "Current" }] }, persist);
		const beforeCompact = session.getLeafId()!;
		session.appendCompaction("Summary omits tasks", beforeCompact, 1000);
		expect(restoreTasks(session.getBranch()).tasks.map((task) => task.title)).toEqual(["Shared", "Current"]);
		session.createBranchedSession(root);
		expect(restoreTasks(session.getBranch()).tasks.map((task) => task.title)).toEqual(["Shared"]);
		expect(abandoned).not.toBe(root);
	});

	it("restores nested edges through branch changes, compaction, and forks", () => {
		const { store, session, persist } = fixture();
		const parent = store.apply({ action: "add", tasks: [{ title: "Shared" }] }, persist).tasks[0];
		const shared = store.apply({ action: "add", tasks: [{ title: "Child", parentId: parent.id }] }, persist);
		const sharedLeaf = session.getLeafId()!;
		const child = shared.tasks[1];
		store.apply({ action: "update", updates: [{ id: child.id, parentId: null, status: "cancelled" }] }, persist);
		store.apply({ action: "add", tasks: [{ title: "Abandoned", parentId: child.id }] }, persist);
		session.branch(sharedLeaf);
		store.restore(session.getBranch());
		expect(store.getSnapshot()).toEqual(shared);
		const current = store.apply(
			{ action: "add", tasks: [{ title: "Current grandchild", parentId: child.id }] },
			persist,
		);
		const currentLeaf = session.getLeafId()!;
		session.appendCompaction("No task state in summary", currentLeaf, 1000);
		expect(restoreTasks(session.getBranch())).toEqual(current);
		session.createBranchedSession(currentLeaf);
		store.restore(session.getBranch());
		expect(store.getSnapshot()).toEqual(current);
		session.createBranchedSession(sharedLeaf);
		store.restore(session.getBranch());
		expect(store.getSnapshot()).toEqual(shared);
		const forked = store.apply({ action: "add", tasks: [{ title: "Fork child", parentId: child.id }] }, persist);
		expect(forked.tasks.at(-1)).toEqual({
			id: shared.nextId,
			title: "Fork child",
			status: "pending",
			parentId: child.id,
		});
	});

	it("accepts old flat v1 snapshots as roots without rewriting records or dropping history", () => {
		const { store, session, persist } = fixture();
		const flat: TaskSnapshot = {
			version: 1,
			revision: 7,
			nextId: 3,
			tasks: [
				{ id: 1, title: "Finished", status: "completed" },
				{ id: 2, title: "Obsolete", status: "cancelled" },
			],
		};
		session.appendCustomEntry(TASKS_ENTRY_TYPE, flat);
		expect(parseTaskSnapshot(flat)).toBe(flat);
		store.restore(session.getBranch());
		expect(store.getSnapshot()).toBe(flat);
		const nested = store.apply({ action: "add", tasks: [{ title: "Child", parentId: flat.tasks[0].id }] }, persist);
		expect(nested).toMatchObject({ version: 1, revision: 8, nextId: 4 });
		expect(nested.tasks.slice(0, 2)).toEqual(flat.tasks);
		expect(nested.tasks.slice(0, 2).every((task) => !("parentId" in task))).toBe(true);
		expect(session.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(2);
	});

	it("validates deep hierarchies iteratively during parsing and before persistence", () => {
		const { store, session, persist } = fixture();
		const depth = 20_000;
		const deep: TaskSnapshot = {
			version: 1,
			revision: 1,
			nextId: depth + 1,
			tasks: Array.from({ length: depth }, (_, index) => ({
				id: index + 1,
				title: `Task ${index + 1}`,
				status: "pending",
				...(index === depth - 1 ? {} : { parentId: index + 2 }),
			})),
		};
		expect(parseTaskSnapshot(deep)).toBe(deep);
		session.appendCustomEntry(TASKS_ENTRY_TYPE, deep);
		store.restore(session.getBranch());
		const storage = vi.fn(persist);
		expect(() => store.apply({ action: "update", updates: [{ id: depth, parentId: 1 }] }, storage)).toThrow("cycle");
		expect(storage).not.toHaveBeenCalled();
		expect(store.getSnapshot()).toBe(deep);
		const detached = store.apply({ action: "update", updates: [{ id: 1, parentId: null }] }, storage);
		expect(detached.tasks[0]).not.toHaveProperty("parentId");
		expect(detached.tasks[1]).toBe(deep.tasks[1]);
		expect(parseTaskSnapshot(detached)).toBe(detached);
	});

	it("does not replace state or notify subscribers when restore encounters a malformed graph", () => {
		const { store, session, persist } = fixture();
		const before = store.apply({ action: "add", tasks: [{ title: "Valid" }] }, persist);
		const published = vi.fn();
		store.subscribe(published);
		session.appendCustomEntry(TASKS_ENTRY_TYPE, { ...before, tasks: [{ ...before.tasks[0], parentId: 99 }] });
		expect(() => store.restore(session.getBranch())).toThrow("Invalid persisted tasks hierarchy");
		expect(store.getSnapshot()).toBe(before);
		expect(published).not.toHaveBeenCalled();
	});

	it("restores persisted state after restart and ignores stale parallel result details", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tasks-state-"));
		directories.push(directory);
		const session = SessionManager.create(directory, directory);
		session.appendMessage({ role: "user", content: "Plan work", timestamp: 1 });
		const store = new TaskStore();
		const persist = (snapshot: TaskSnapshot) => session.appendCustomEntry(TASKS_ENTRY_TYPE, snapshot);
		const older = store.apply({ action: "add", tasks: [{ title: "Inspect" }] }, persist);
		const child = store.apply({ action: "add", tasks: [{ title: "Child", parentId: older.tasks[0].id }] }, persist)
			.tasks[1];
		store.apply({ action: "add", tasks: [{ title: "Grandchild", parentId: child.id }] }, persist);
		store.apply({ action: "update", updates: [{ id: 1, status: "completed" }] }, persist);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "old",
			toolName: "tasks",
			content: [{ type: "text", text: "Old result" }],
			details: { snapshot: older },
			isError: false,
			timestamp: 2,
		});
		const reopened = SessionManager.open(session.getSessionFile()!);
		expect(restoreTasks(reopened.getBranch())).toEqual(store.getSnapshot());
	});

	it.each([
		{},
		{ version: 1, revision: -1, nextId: 1, tasks: [] },
		{ version: 1, revision: 0, nextId: 2, tasks: [{ id: 1, title: "One", status: "unknown" }] },
		{ version: 1, revision: 0, nextId: 1, tasks: [{ id: 1, title: "One", status: "pending" }] },
		{ version: 1, revision: 0, nextId: 2, tasks: [{ id: 1, title: " ", status: "pending" }] },
		{
			version: 1,
			revision: 0,
			nextId: 2,
			tasks: [{ id: 1, title: "Null parent", status: "pending", parentId: null }],
		},
		{ version: 1, revision: 0, nextId: 2, tasks: [{ id: 1, title: "Zero parent", status: "pending", parentId: 0 }] },
		{ version: 1, revision: 0, nextId: 2, tasks: [{ id: 1, title: "Missing", status: "pending", parentId: 99 }] },
		{ version: 1, revision: 0, nextId: 2, tasks: [{ id: 1, title: "Self", status: "pending", parentId: 1 }] },
		{
			version: 1,
			revision: 0,
			nextId: 3,
			tasks: [
				{ id: 1, title: "Cycle one", status: "pending", parentId: 2 },
				{ id: 2, title: "Cycle two", status: "pending", parentId: 1 },
			],
		},
		{
			version: 1,
			revision: 0,
			nextId: 5,
			tasks: [
				{ id: 1, title: "Valid root", status: "completed" },
				{ id: 2, title: "Cycle one", status: "pending", parentId: 3 },
				{ id: 3, title: "Cycle two", status: "cancelled", parentId: 4 },
				{ id: 4, title: "Cycle three", status: "in_progress", parentId: 2 },
			],
		},
		{
			version: 1,
			revision: 0,
			nextId: 2,
			tasks: [
				{ id: 1, title: "One", status: "pending" },
				{ id: 1, title: "Duplicate", status: "pending" },
			],
		},
	])("rejects invalid disk snapshots (%j)", (value) => {
		expect(() => parseTaskSnapshot(value)).toThrow("Invalid persisted tasks");
	});
});
