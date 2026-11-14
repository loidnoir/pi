import { validateToolArguments } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { TasksResultSchema } from "../src/core/tasks/render.ts";
import { TaskStore } from "../src/core/tasks/state.ts";
import { createTasksToolDefinition, type TasksToolInput, tasksParameters } from "../src/core/tasks/tool.ts";

const context = {} as ExtensionToolContext;

describe("tasks metadata tool", () => {
	it("returns full truthful structured state for list/add/update and retains original snapshots", async () => {
		const store = new TaskStore();
		const persist = vi.fn();
		const tool = createTasksToolDefinition(store, persist, () => {});
		const added = await tool.execute(
			"a",
			{ action: "add", tasks: [{ title: "Inspect" }, { title: "Verify", status: "in_progress" }] },
			undefined,
			undefined,
			context,
		);
		const updated = await tool.execute(
			"b",
			{
				action: "update",
				updates: [
					{ id: 1, status: "cancelled" },
					{ id: 2, title: "Verify revised scope" },
				],
			},
			undefined,
			undefined,
			context,
		);
		const listed = await tool.execute("c", { action: "list" }, undefined, undefined, context);
		expect(persist).toHaveBeenCalledTimes(2);
		expect(added.details.snapshot.tasks[0].status).toBe("pending");
		expect(updated.structuredContent).toEqual(updated.details);
		expect(listed.details.snapshot).toEqual(updated.details.snapshot);
		expect(listed.content).toEqual([{ type: "text", text: expect.stringContaining('#1 [cancelled] "Inspect"') }]);
		expect(listed.details.snapshot.tasks[1]).toEqual({ id: 2, title: "Verify revised scope", status: "in_progress" });
	});

	it("creates actual nested subtasks using returned IDs and supports independent statuses, moves, and detaches", async () => {
		const store = new TaskStore();
		const persist = vi.fn();
		const tool = createTasksToolDefinition(store, persist, () => {});
		const roots = await tool.execute(
			"parents",
			{ action: "add", tasks: [{ title: "Plan" }, { title: "Other" }] },
			undefined,
			undefined,
			context,
		);
		const parent = roots.details.snapshot.tasks[0];
		const other = roots.details.snapshot.tasks[1];
		const children = await tool.execute(
			"children",
			{
				action: "add",
				tasks: [
					{ title: "Child", parentId: parent.id },
					{ title: "Sibling", parentId: parent.id, status: "in_progress" },
				],
			},
			undefined,
			undefined,
			context,
		);
		const child = children.details.snapshot.tasks[2];
		const nested = await tool.execute(
			"grandchild",
			{ action: "add", tasks: [{ title: "Grandchild", parentId: child.id }] },
			undefined,
			undefined,
			context,
		);
		const grandchild = nested.details.snapshot.tasks[4];
		const completed = await tool.execute(
			"complete-parent",
			{ action: "update", updates: [{ id: parent.id, status: "completed" }] },
			undefined,
			undefined,
			context,
		);
		expect(completed.details.snapshot.tasks.map((task) => task.status)).toEqual([
			"completed",
			"pending",
			"pending",
			"in_progress",
			"pending",
		]);
		const moved = await tool.execute(
			"move",
			{ action: "update", updates: [{ id: child.id, parentId: other.id }] },
			undefined,
			undefined,
			context,
		);
		expect(moved.details.snapshot.tasks[2]).toEqual({ ...child, parentId: other.id });
		expect(moved.details.snapshot.tasks[4]).toBe(grandchild);
		const detached = await tool.execute(
			"detach",
			{ action: "update", updates: [{ id: child.id, parentId: null }] },
			undefined,
			undefined,
			context,
		);
		expect(detached.details.snapshot.tasks[2]).toEqual({ id: child.id, title: "Child", status: "pending" });
		expect(detached.details.snapshot.tasks[2]).not.toHaveProperty("parentId");
		expect(detached.details.snapshot.tasks[4]).toBe(grandchild);
		const listed = await tool.execute("list", { action: "list" }, undefined, undefined, context);
		expect(listed.details.snapshot).toBe(detached.details.snapshot);
		const outputValidator = Compile(TasksResultSchema);
		for (const result of [roots, children, nested, completed, moved, detached, listed]) {
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toBe(result.details);
			expect(outputValidator.Check(result.structuredContent)).toBe(true);
		}
		expect(persist).toHaveBeenCalledTimes(6);
		expect(nested.details.snapshot.tasks[2].parentId).toBe(parent.id);
	});

	it("returns the same authoritative snapshot for rejected hierarchy edits without committing partial work", async () => {
		const store = new TaskStore();
		const parent = store.apply({ action: "add", tasks: [{ title: "Parent" }, { title: "Other" }] }, () => {})
			.tasks[0];
		const before = store.apply({ action: "add", tasks: [{ title: "Child", parentId: parent.id }] }, () => {});
		const child = before.tasks[2];
		const other = before.tasks[1];
		const persist = vi.fn();
		const notified = vi.fn();
		store.subscribe(notified);
		const tool = createTasksToolDefinition(store, persist, () => {});
		const invalid: TasksToolInput[] = [
			{
				action: "add",
				tasks: [
					{ title: "Valid", parentId: parent.id },
					{ title: "Missing", parentId: 99 },
				],
			},
			{ action: "add", tasks: [{ title: "New parent" }, { title: "New child", parentId: before.nextId }] },
			{ action: "update", updates: [{ id: child.id, parentId: 99 }] },
			{ action: "update", updates: [{ id: child.id, parentId: child.id }] },
			{ action: "update", updates: [{ id: parent.id, parentId: child.id }] },
			{
				action: "update",
				updates: [
					{ id: child.id, title: "Valid edit", status: "completed" },
					{ id: parent.id, parentId: other.id },
					{ id: other.id, parentId: parent.id },
				],
			},
		];
		const outputValidator = Compile(TasksResultSchema);
		for (const input of invalid) {
			const result = await tool.execute("invalid", input, undefined, undefined, context);
			expect(result.isError).toBe(true);
			expect(result.details.error).toBeTruthy();
			expect(result.details.snapshot).toBe(before);
			expect(result.structuredContent).toBe(result.details);
			expect(outputValidator.Check(result.structuredContent)).toBe(true);
			expect(store.getSnapshot()).toBe(before);
		}
		expect(persist).not.toHaveBeenCalled();
		expect(notified).not.toHaveBeenCalled();
		const valid = await tool.execute(
			"next",
			{ action: "add", tasks: [{ title: "Next", parentId: child.id }] },
			undefined,
			undefined,
			context,
		);
		expect(valid.details.snapshot.tasks.at(-1)?.id).toBe(before.nextId);
		expect(valid.details.snapshot.revision).toBe(before.revision + 1);
	});

	it("preserves explicit null detaches through tool argument validation", async () => {
		const store = new TaskStore();
		const parent = store.apply({ action: "add", tasks: [{ title: "Parent" }] }, () => {}).tasks[0];
		const child = store.apply({ action: "add", tasks: [{ title: "Child", parentId: parent.id }] }, () => {}).tasks[1];
		const tool = createTasksToolDefinition(
			store,
			() => {},
			() => {},
		);
		const input: TasksToolInput = validateToolArguments(tool, {
			type: "toolCall",
			id: "detach",
			name: "tasks",
			arguments: { action: "update", updates: [{ id: child.id, parentId: null }] },
		});
		expect(input.updates?.[0]).toEqual({ id: child.id, parentId: null });
		const detached = await tool.execute("detach", input, undefined, undefined, context);
		expect(detached.isError).not.toBe(true);
		expect(detached.details.snapshot.tasks[1]).not.toHaveProperty("parentId");
	});

	it("reports validation and storage errors with the unchanged authoritative state", async () => {
		const store = new TaskStore();
		store.apply({ action: "add", tasks: [{ title: "Existing" }] }, () => {});
		const persist = vi.fn(() => {
			throw new Error("Disk full");
		});
		const tool = createTasksToolDefinition(store, persist, () => {});
		for (const input of [
			{ action: "add" as const },
			{
				action: "update" as const,
				updates: [
					{ id: 1, status: "completed" as const },
					{ id: 2, title: "Missing" },
				],
			},
			{ action: "list" as const, tasks: [{ title: "Wrong action" }] },
			{ action: "update" as const, updates: [{ id: 1, status: "completed" as const }] },
		]) {
			const result = await tool.execute("e", input, undefined, undefined, context);
			expect(result.isError).toBe(true);
			expect(result.details.error).toBeTruthy();
			expect(result.details.snapshot).toBe(store.getSnapshot());
			expect(result.details.snapshot.tasks[0].status).toBe("pending");
			expect(result.structuredContent).toEqual(result.details);
		}
		const aborted = await tool.execute(
			"abort",
			{ action: "add", tasks: [{ title: "No" }] },
			AbortSignal.abort(),
			undefined,
			context,
		);
		expect(aborted.isError).toBe(true);
		expect(store.getSnapshot().tasks).toHaveLength(1);
		expect(persist).toHaveBeenCalledOnce();
	});

	it("exposes no destructive or execution actions and names tasks in every prompt guideline", () => {
		const validator = Compile(tasksParameters);
		for (const action of ["clear", "delete", "start", "run"]) expect(validator.Check({ action })).toBe(false);
		expect(validator.Check({ action: "add", tasks: [{ title: "bad", status: "done" }] })).toBe(false);
		for (const parentId of [0, -1, 1.5, "1", null])
			expect(validator.Check({ action: "add", tasks: [{ title: "Bad parent", parentId }] })).toBe(false);
		for (const parentId of [0, -1, 1.5, "1"])
			expect(validator.Check({ action: "update", updates: [{ id: 1, parentId }] })).toBe(false);
		expect(validator.Check({ action: "add", tasks: [{ title: "Child", parentId: 1 }] })).toBe(true);
		expect(validator.Check({ action: "update", updates: [{ id: 1, parentId: 2 }] })).toBe(true);
		expect(validator.Check({ action: "update", updates: [{ id: 1, parentId: null }] })).toBe(true);
		const tool = createTasksToolDefinition(
			new TaskStore(),
			() => {},
			() => {},
		);
		expect(
			tool.promptGuidelines?.every((guideline) => guideline.includes("tasks") || guideline.includes("Tasks")),
		).toBe(true);
		expect(tool.description).toContain("no automatic rollup, cascade, or completion guard");
		expect(tool.promptGuidelines?.join("\n")).toContain("actual returned task IDs, never guessed IDs");
		expect(tool.promptGuidelines?.join("\n")).toContain("null to detach to root");
		expect(tool.promptGuidelines?.join("\n")).toContain(
			"completed or cancelled while its children have other statuses",
		);
	});
});
