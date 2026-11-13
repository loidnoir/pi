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

	it("restores persisted state after restart and ignores stale parallel result details", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tasks-state-"));
		directories.push(directory);
		const session = SessionManager.create(directory, directory);
		session.appendMessage({ role: "user", content: "Plan work", timestamp: 1 });
		const store = new TaskStore();
		const persist = (snapshot: TaskSnapshot) => session.appendCustomEntry(TASKS_ENTRY_TYPE, snapshot);
		const older = store.apply({ action: "add", tasks: [{ title: "Inspect" }] }, persist);
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
			tasks: [
				{ id: 1, title: "One", status: "pending" },
				{ id: 1, title: "Duplicate", status: "pending" },
			],
		},
	])("rejects invalid disk snapshots (%j)", (value) => {
		expect(() => parseTaskSnapshot(value)).toThrow("Invalid persisted tasks");
	});
});
