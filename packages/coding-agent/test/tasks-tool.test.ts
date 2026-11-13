import { Compile } from "typebox/compile";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { TaskStore } from "../src/core/tasks/state.ts";
import { createTasksToolDefinition, tasksParameters } from "../src/core/tasks/tool.ts";

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
		const tool = createTasksToolDefinition(
			new TaskStore(),
			() => {},
			() => {},
		);
		expect(
			tool.promptGuidelines?.every((guideline) => guideline.includes("tasks") || guideline.includes("Tasks")),
		).toBe(true);
	});
});
