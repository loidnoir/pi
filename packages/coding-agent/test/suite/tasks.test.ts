import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type JsonObject,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { restoreTasks } from "../../src/core/tasks/state.ts";
import { createTasksExtension } from "../../src/extensions/tasks/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
});

async function fixture(sessionManager?: SessionManager) {
	const harness = await createHarness({
		tools: [],
		initialActiveToolNames: [],
		sessionManager,
		settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false }, cacheWarming: "off" },
		extensionFactories: [
			createTasksExtension(),
			(pi) => {
				pi.on("session_before_compact", (event) => ({
					compaction: {
						summary: "Earlier work was summarized; task details intentionally omitted.",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "print" });
	return harness;
}

function call(input: JsonObject) {
	return fauxAssistantMessage(fauxToolCall("tasks", input), { stopReason: "toolUse" });
}

describe("native tasks through real faux-provider calls", () => {
	it("supports a headless main SDK session without binding interactive extensions", async () => {
		const harness = await createHarness({
			tools: [],
			initialActiveToolNames: [],
			settings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" },
			extensionFactories: [createTasksExtension()],
		});
		harnesses.push(harness);
		harness.setResponses([
			call({ action: "add", tasks: [{ title: "Headless plan" }] }),
			fauxAssistantMessage("Recorded."),
		]);
		await harness.session.prompt("Track the headless plan.");
		expect(getToolResult(harness, "tasks").details).toMatchObject({
			snapshot: { tasks: [{ id: 1, title: "Headless plan", status: "pending" }] },
		});
	});

	it("adapts retained tasks to mid-work steering, supports parallel updates, and avoids moving context snapshots", async () => {
		const harness = await fixture();
		const requests: TranscriptContext[] = [];
		harness.setResponses([
			async (context) => {
				requests.push(structuredClone(context));
				await harness.session.steer("Skip packaging; inspect the UI instead.");
				return call({
					action: "add",
					tasks: [{ title: "Inspect core", status: "in_progress" }, { title: "Package release" }],
				});
			},
			(context) => {
				requests.push(structuredClone(context));
				expect(context.messages.some((message) => getMessageText(message).includes("Skip packaging"))).toBe(true);
				return fauxAssistantMessage(
					[
						fauxToolCall("tasks", {
							action: "update",
							updates: [
								{ id: 1, status: "completed" },
								{ id: 2, status: "cancelled" },
							],
						}),
						fauxToolCall("tasks", {
							action: "add",
							tasks: [
								{ title: "Inspect UI", status: "in_progress" },
								{ title: "Check themes", status: "in_progress" },
							],
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push(structuredClone(context));
				return call({ action: "list" });
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("The revised task list is current.");
			},
		]);
		await harness.session.prompt("Inspect core and prepare packaging.");
		expect(restoreTasks(harness.sessionManager.getBranch()).tasks).toEqual([
			{ id: 1, title: "Inspect core", status: "completed" },
			{ id: 2, title: "Package release", status: "cancelled" },
			{ id: 3, title: "Inspect UI", status: "in_progress" },
			{ id: 4, title: "Check themes", status: "in_progress" },
		]);
		expect(getToolResult(harness, "tasks").isError).toBe(false);
		expect(getToolResult(harness, "tasks").details).toMatchObject({
			action: "list",
			snapshot: { revision: 3, tasks: expect.any(Array) },
		});
		expect(requests).toHaveLength(4);
		const systems = requests.map((context) => context.messages.filter((message) => message.role === "system"));
		for (const messages of systems) expect(messages).toEqual(systems[0]);
		expect(getCurrentTools(requests[0].messages).some((tool) => tool.name === "tasks")).toBe(true);
	});

	it("reconstructs authoritative list state after compaction, reload, and a simulated restart", async () => {
		const harness = await fixture();
		harness.setResponses([
			call({
				action: "add",
				tasks: [
					{ title: "Keep through compaction", status: "in_progress" },
					{ title: "Retained obsolete work", status: "cancelled" },
				],
			}),
			fauxAssistantMessage("Plan recorded."),
		]);
		await harness.session.prompt("Plan the investigation.");
		const expected = restoreTasks(harness.sessionManager.getBranch());
		await harness.session.compact();
		let runStartPrompt = "";
		harness.setResponses([
			(context) => {
				runStartPrompt = getCurrentSystemPrompt(context.messages);
				return call({ action: "list" });
			},
			fauxAssistantMessage("Tasks restored after compaction."),
		]);
		await harness.session.prompt("Resume after compaction and list tasks.");
		expect(getToolResult(harness, "tasks").details).toMatchObject({ snapshot: expected });
		expect(runStartPrompt).toContain("Task state at the start of this run");
		expect(runStartPrompt).toContain("Keep through compaction");
		await harness.session.reload();
		harness.setResponses([call({ action: "list" }), fauxAssistantMessage("Reload preserved tasks.")]);
		await harness.session.prompt("List after reload.");
		expect(getToolResult(harness, "tasks").details).toMatchObject({ snapshot: expected });

		const restarted = await fixture(harness.sessionManager);
		restarted.setResponses([call({ action: "list" }), fauxAssistantMessage("Restart preserved tasks.")]);
		await restarted.session.prompt("List restored tasks.");
		expect(getToolResult(restarted, "tasks").details).toMatchObject({ snapshot: expected });
	});

	it("returns unchanged full state for an atomic batch error through normal tool validation", async () => {
		const harness = await fixture();
		harness.setResponses([
			call({ action: "add", tasks: [{ title: "Existing" }] }),
			call({
				action: "update",
				updates: [
					{ id: 1, status: "completed" },
					{ id: 999, status: "cancelled" },
				],
			}),
			fauxAssistantMessage("The invalid batch did not change task state."),
		]);
		await harness.session.prompt("Exercise error handling.");
		const result = getToolResult(harness, "tasks");
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			error: "Task #999 not found",
			snapshot: { revision: 1, tasks: [{ id: 1, title: "Existing", status: "pending" }] },
		});
		const execution = harness.eventsOfType("tool_execution_end").findLast((event) => event.toolName === "tasks");
		expect(execution?.result.structuredContent).toEqual(result.details);
	});

	it("keeps tasks hidden and unreachable in native child sessions", async () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry("pi.subagent", { parentSessionId: "main" });
		const harness = await fixture(session);
		expect(harness.session.getActiveToolNames()).not.toContain("tasks");
		expect(harness.session.getCallableToolNames()).not.toContain("tasks");
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).some((tool) => tool.name === "tasks")).toBe(false);
				return fauxAssistantMessage("Child work has no independent main task list.");
			},
		]);
		await harness.session.prompt("Inspect delegated work.");
		expect(restoreTasks(session.getBranch()).tasks).toEqual([]);
	});
});
