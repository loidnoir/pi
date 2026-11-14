import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxModelDefinition, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { getOutputArtifacts } from "../../src/core/output-artifacts.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { openSideSession, type SideSessionRuntime } from "../../src/core/side-session.ts";
import { SideSessionStore } from "../../src/core/side-session-store.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const runtimes: SideSessionRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => {});
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function setup(models?: FauxModelDefinition[]) {
	const directory = mkdtempSync(join(tmpdir(), "pi-btw-runtime-"));
	directories.push(directory);
	const parent = SessionManager.create(directory, join(directory, "sessions"));
	const capture: { context?: ExtensionContext } = {};
	const harness = await createHarness({
		models,
		sessionManager: parent,
		agentDir: directory,
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					capture.context = ctx;
				});
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	if (!capture.context) throw new Error("Missing extension context");
	return {
		harness,
		context: capture.context,
		directory,
		parent,
		store: new SideSessionStore(capture.context, directory),
	};
}

function open(context: ExtensionContext, chat: ReturnType<SideSessionStore["create"]>) {
	const runtime = openSideSession(context, chat);
	runtimes.push(runtime);
	return runtime;
}

describe("saved raw-Agent side runtime", () => {
	it("restores follow-ups after reopening, persists only own messages and system boundary, and leaves the parent untouched", async () => {
		const { harness, context, parent, store, directory } = await setup();
		harness.setResponses([fauxAssistantMessage("Main reply")]);
		await harness.session.prompt("Parent seed MARKER_982");
		const before = readFileSync(parent.getSessionFile()!, "utf8");
		const chat = store.create("Initial child prompt");
		const runtime = open(context, chat);
		harness.setResponses([
			(request) => {
				expect(request.messages.some((message) => getMessageText(message).includes("MARKER_982"))).toBe(true);
				expect(
					getCurrentTools(request.messages)
						.map((tool) => tool.name)
						.sort(),
				).toEqual(["find", "grep", "ls", "read"]);
				return fauxAssistantMessage("First saved answer");
			},
		]);
		await runtime.agent.prompt("Initial child prompt");
		expect(chat.ownMessages.filter((message) => message.role !== "system").map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(chat.ownMessages.some((message) => message.role === "system")).toBe(true);
		expect(readFileSync(chat.historyPath!, "utf8")).not.toContain("MARKER_982");
		await runtime.close();
		const reopened = new SideSessionStore(context, directory).open(chat.id);
		const second = open(context, reopened);
		expect(second.agent.state.messages.slice(second.firstMessage).map(getMessageText)).toContain(
			"First saved answer",
		);
		harness.setResponses([
			(request) => {
				expect(request.messages.map(getMessageText)).toContain("First saved answer");
				return fauxAssistantMessage("Follow-up saved answer");
			},
		]);
		await second.agent.prompt("Follow-up");
		expect(reopened.ownMessages.map(getMessageText)).toContain("Follow-up saved answer");
		expect(readFileSync(parent.getSessionFile()!, "utf8")).toBe(before);
	});

	it("persists child-local model and effort selections and restores them independently of the parent's later model", async () => {
		const { harness, context, parent, store, directory } = await setup([
			{ id: "parent", reasoning: true },
			{ id: "side", reasoning: true },
			{ id: "later-parent", reasoning: false },
		]);
		const chat = store.create("Question");
		const before = readFileSync(parent.getSessionFile()!, "utf8");
		const settings = JSON.stringify(harness.settingsManager.getSettings());
		const parentThinkingLevel = harness.session.thinkingLevel;
		const runtime = open(context, chat);
		expect(chat.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "model_change", modelId: "parent" }),
		);
		const originalContext = JSON.stringify(runtime.agent.state.messages);
		runtime.setModel(harness.getModel("side")!);
		runtime.setThinkingLevel("high");
		expect(JSON.stringify(runtime.agent.state.messages)).toBe(originalContext);
		expect(chat.ownMessages.filter((message) => message.role === "system")).toHaveLength(1);
		expect(runtime.agent.state.model.id).toBe("side");
		expect(runtime.agent.state.thinkingLevel).toBe("high");
		expect(harness.session.model?.id).toBe("parent");
		expect(harness.session.thinkingLevel).toBe(parentThinkingLevel);
		expect(JSON.stringify(harness.settingsManager.getSettings())).toBe(settings);
		harness.setResponses([
			(request, options, _state, model) => {
				expect(model.id).toBe("side");
				expect(options?.reasoning).toBe("high");
				expect(
					getCurrentTools(request.messages)
						.map((tool) => tool.name)
						.sort(),
				).toEqual(["find", "grep", "ls", "read"]);
				return fauxAssistantMessage("Selected side model answer");
			},
		]);
		await runtime.agent.prompt("Question");
		const answeredContext = JSON.stringify(runtime.agent.state.messages);
		runtime.setThinkingLevel("low");
		runtime.setThinkingLevel("high");
		expect(JSON.stringify(runtime.agent.state.messages)).toBe(answeredContext);
		expect(chat.ownMessages.filter((message) => message.role === "system")).toHaveLength(1);
		expect(readFileSync(parent.getSessionFile()!, "utf8")).toBe(before);
		await runtime.close();
		await harness.session.setModel(harness.getModel("later-parent")!);
		const afterParentChange = readFileSync(parent.getSessionFile()!, "utf8");
		const reopened = open(context, new SideSessionStore(context, directory).open(chat.id));
		expect(reopened.agent.state.model.id).toBe("side");
		expect(reopened.agent.state.thinkingLevel).toBe("high");
		expect(harness.session.model?.id).toBe("later-parent");
		expect(readFileSync(parent.getSessionFile()!, "utf8")).toBe(afterParentChange);
	});

	it("clamps effort with canonical physical and virtual capabilities and retains a virtual selection after its physical answer", async () => {
		const { harness, context, store, directory } = await setup([
			{ id: "physical", reasoning: true },
			{ id: "plain", reasoning: false },
		]);
		context.modelRegistry.registerVirtualModel({
			provider: "btw-router",
			id: "auto",
			name: "Side router",
			thinkingLevels: ["low", "high"],
			route: (request) => ({ model: harness.getModel(), thinkingLevel: request.thinkingLevel }),
		});
		const virtual = context.modelRegistry.find("btw-router", "auto")!;
		const chat = store.create("Question");
		const runtime = open(context, chat);
		runtime.setThinkingLevel("max");
		expect(runtime.agent.state.thinkingLevel).toBe("high");
		runtime.setModel(harness.getModel("plain")!);
		expect(runtime.getAvailableThinkingLevels()).toEqual(["off"]);
		expect(runtime.agent.state.thinkingLevel).toBe("off");
		runtime.setThinkingLevel("high");
		expect(runtime.agent.state.thinkingLevel).toBe("off");
		runtime.setModel(virtual);
		expect(runtime.getAvailableThinkingLevels()).toEqual(["low", "high"]);
		expect(runtime.agent.state.thinkingLevel).toBe("low");
		runtime.setThinkingLevel("medium");
		expect(runtime.agent.state.thinkingLevel).toBe("high");
		harness.setResponses([
			(_request, options, _state, model) => {
				expect(model.id).toBe("physical");
				expect(options?.reasoning).toBe("high");
				return fauxAssistantMessage("Routed answer");
			},
		]);
		await runtime.agent.prompt("Question");
		await runtime.close();
		const reopened = open(context, new SideSessionStore(context, directory).open(chat.id));
		expect(reopened.agent.state.model.id).toBe("auto");
		expect(reopened.agent.state.thinkingLevel).toBe("high");
		expect(reopened.getAvailableThinkingLevels()).toEqual(["low", "high"]);
	});

	it("rejects model and effort changes during streaming or queued work without modifying the active selection or history", async () => {
		const { harness, context, store } = await setup([
			{ id: "first", reasoning: true },
			{ id: "second", reasoning: true },
		]);
		const chat = store.create("Question");
		const runtime = open(context, chat);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("Answer");
			},
		]);
		const running = runtime.agent.prompt("Question");
		await entered.promise;
		const before = JSON.stringify(chat.sessionManager.getEntries());
		const level = runtime.agent.state.thinkingLevel;
		try {
			expect(() => runtime.setModel(harness.getModel("second")!)).toThrow("active or queued");
			expect(() => runtime.setThinkingLevel("high")).toThrow("active or queued");
			expect(runtime.agent.state.model.id).toBe("first");
			expect(runtime.agent.state.thinkingLevel).toBe(level);
			expect(JSON.stringify(chat.sessionManager.getEntries())).toBe(before);
		} finally {
			release.resolve();
		}
		await running;
		runtime.agent.followUp({ role: "user", content: "Queued", timestamp: Date.now() });
		const queuedBefore = JSON.stringify(chat.sessionManager.getEntries());
		expect(() => runtime.setModel(harness.getModel("second")!)).toThrow("active or queued");
		expect(() => runtime.setThinkingLevel("high")).toThrow("active or queued");
		expect(JSON.stringify(chat.sessionManager.getEntries())).toBe(queuedBefore);
		runtime.agent.clearAllQueues();
	});

	it("surfaces a failed selection write without changing the live effort", async () => {
		const { harness, context, store } = await setup([{ id: "reasoning", reasoning: true }]);
		const chat = store.create("Question");
		const runtime = open(context, chat);
		const before = runtime.agent.state.thinkingLevel;
		vi.spyOn(chat.sessionManager, "appendThinkingLevelChange").mockImplementation(() => {
			throw new Error("selection disk full");
		});
		expect(() => runtime.setThinkingLevel(before === "high" ? "low" : "high")).toThrow("selection disk full");
		expect(runtime.agent.state.thinkingLevel).toBe(before);
		expect(harness.getPendingResponseCount()).toBe(0);
		await expect(runtime.close()).rejects.toThrow("selection disk full");
	});

	it("shows saved history but rejects continuation for a missing parent, without recreating it", async () => {
		const { harness, context, parent, store } = await setup();
		const chat = store.create("Question");
		chat.sessionManager.appendMessage({ role: "user", content: "Saved question", timestamp: Date.now() });
		rmSync(parent.getSessionFile()!);
		const before = readFileSync(chat.historyPath!, "utf8");
		const runtime = open(context, chat);
		expect(runtime.error).toContain("original parent context");
		expect(runtime.firstMessage).toBe(0);
		expect(runtime.agent.state.messages.map(getMessageText)).toContain("Saved question");
		await expect(runtime.agent.prompt("Follow-up")).rejects.toThrow("original parent context");
		expect(() => runtime.setModel(harness.getModel())).toThrow("original parent context");
		expect(() => runtime.setThinkingLevel("high")).toThrow("original parent context");
		expect(readFileSync(chat.historyPath!, "utf8")).toBe(before);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("omits the parent's unfinished final round but refuses an incomplete crashed child round", async () => {
		const { context, parent, store } = await setup();
		parent.appendMessage({ role: "user", content: "Parent work", timestamp: Date.now() });
		parent.appendMessage(
			fauxAssistantMessage([fauxToolCall("bash", { command: "running" })], { stopReason: "toolUse" }),
		);
		const chat = store.create("Question");
		const runtime = open(context, chat);
		expect(runtime.error).toBeUndefined();
		expect(runtime.agent.state.messages.some((message) => message.role === "assistant")).toBe(false);
		await runtime.close();
		chat.sessionManager.appendMessage(
			fauxAssistantMessage([fauxToolCall("read", { path: "note" })], { stopReason: "toolUse" }),
		);
		const reopened = open(context, chat);
		expect(reopened.error).toContain("interrupted tool round");
		await expect(reopened.agent.prompt("Unsafe resume")).rejects.toThrow("interrupted tool round");
	});

	it("keeps an incomplete final JSONL entry unchanged and its saved history viewable", async () => {
		const { context, store, directory } = await setup();
		const chat = store.create("Saved question before crash");
		appendFileSync(chat.historyPath!, "{");
		const before = readFileSync(chat.historyPath!);
		const reloaded = new SideSessionStore(context, directory);
		const runtime = open(context, reloaded.open(chat.id));
		expect(runtime.error).toContain("incomplete final JSONL entry");
		expect(runtime.agent.state.messages.map(getMessageText)).toContain("Saved question before crash");
		await expect(runtime.agent.prompt("Follow-up")).rejects.toThrow("incomplete final JSONL entry");
		await runtime.close();
		expect(readFileSync(chat.historyPath!)).toEqual(before);
		const page = reloaded.list();
		expect(page.items.map((item) => item.id)).toEqual([chat.id]);
		expect(page.total).toBe(1);
		expect(page.errors).toBeUndefined();
		expect(readFileSync(chat.historyPath!)).toEqual(before);
	});

	it("keeps read artifacts under the child's persistent owner and reads them after reopening", async () => {
		const { harness, context, directory, store } = await setup();
		const file = join(directory, "large.txt");
		writeFileSync(file, Array.from({ length: 4000 }, (_, index) => `line-${index} ${"x".repeat(100)}`).join("\n"));
		const chat = store.create("Read evidence");
		const runtime = open(context, chat);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: file })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Evidence saved"),
		]);
		await runtime.agent.prompt("Read evidence");
		const result = chat.ownMessages.find((message) => message.role === "toolResult");
		const uri = getMessageText(result).match(/artifact:\/\/[a-f0-9]{64}\/[a-f0-9-]+/)?.[0];
		expect(uri).toBeDefined();
		expect(uri).not.toContain("temporary");
		const storeArtifacts = getOutputArtifacts(chat.sessionManager)!;
		expect(readFileSync(storeArtifacts.resolve(uri!), "utf8").includes("line-400")).toBe(true);
		rmSync(file);
		await runtime.close();
		const reopened = new SideSessionStore(context, directory).open(chat.id);
		const second = open(context, reopened);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: uri!, offset: 401, limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Original evidence retrieved"),
		]);
		await second.agent.prompt("Read original evidence");
		expect(
			reopened.ownMessages
				.filter((message) => message.role === "toolResult")
				.map(getMessageText)
				.at(-1),
		).toContain("line-400");
	});

	it("aborts and drains on close without deleting completed messages, and permits independent chats", async () => {
		const { harness, context, store } = await setup();
		const first = store.create("First chat");
		const second = store.create("Second chat");
		const a = open(context, first);
		const b = open(context, second);
		harness.setResponses([fauxAssistantMessage("One"), fauxAssistantMessage("Two")]);
		await a.agent.prompt("Question one");
		await b.agent.prompt("Question two");
		await Promise.all([a.close(), b.close()]);
		expect(first.ownMessages.map(getMessageText)).toContain("One");
		expect(second.ownMessages.map(getMessageText)).toContain("Two");
		expect(a.agent.state.isStreaming).toBe(false);
		await expect(a.agent.prompt("Closed")).rejects.toThrow("closed");
	});

	it("refreshes under an exclusive saved-chat lease and leaves another writer's history untouched", async () => {
		const { harness, context, store, directory } = await setup();
		const chat = store.create("Question");
		const stale = new SideSessionStore(context, directory).open(chat.id);
		const first = open(context, chat);
		const otherProcess = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				"import lockfile from 'proper-lockfile'; try { lockfile.lockSync(process.argv[1]); process.exitCode = 2; } catch (error) { if (error.code !== 'ELOCKED') throw error; }",
				chat.historyPath!,
			],
			{ encoding: "utf8" },
		);
		expect(otherProcess.stderr).toBe("");
		expect(otherProcess.status).toBe(0);
		const blocked = open(context, stale);
		expect(blocked.error).toContain("execution owner");
		await expect(blocked.agent.prompt("Conflicting write")).rejects.toThrow("execution owner");
		await blocked.close();
		harness.setResponses([fauxAssistantMessage("First writer answer")]);
		await first.agent.prompt("Question");
		await first.close();
		const next = open(context, stale);
		expect(next.error).toBeUndefined();
		expect(next.agent.state.messages.map(getMessageText)).toContain("First writer answer");
	});

	it("waits for active listeners when closing and retains the initial question even before the first request", async () => {
		const { harness, context, store } = await setup();
		const chat = store.create("Question saved before opening");
		expect(chat.ownMessages.map(getMessageText)).toEqual(["Question saved before opening"]);
		const runtime = open(context, chat);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		runtime.agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				entered.resolve();
				await release.promise;
			}
		});
		harness.setResponses([fauxAssistantMessage("Saved before drain")]);
		const prompting = runtime.agent.prompt("Question saved before opening").catch(() => {});
		await entered.promise;
		let drained = false;
		const closing = runtime.close().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		release.resolve();
		await Promise.all([prompting, closing]);
		expect(chat.ownMessages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
			"Question saved before opening",
		]);
		expect(chat.ownMessages.map(getMessageText)).toContain("Saved before drain");
	});

	it("aborts instead of publishing an artifact reference when retention fails", async () => {
		const { harness, context, store, directory } = await setup();
		const file = join(directory, "note.txt");
		writeFileSync(file, "Evidence");
		const chat = store.create("Question");
		const runtime = open(context, chat);
		vi.spyOn(getOutputArtifacts(chat.sessionManager)!, "limit").mockRejectedValue(new Error("artifact disk full"));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: file })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Must not be called"),
		]);
		await expect(runtime.agent.prompt("Question")).rejects.toThrow("artifact disk full");
		expect(harness.getPendingResponseCount()).toBe(1);
		await expect(runtime.close()).rejects.toThrow("artifact disk full");
	});

	it("aborts and surfaces persistence failure instead of continuing with an unsaved transcript", async () => {
		const { harness, context, store } = await setup();
		const chat = store.create("Question");
		const runtime = open(context, chat);
		vi.spyOn(chat.sessionManager, "appendMessage").mockImplementation(() => {
			throw new Error("disk full");
		});
		harness.setResponses([fauxAssistantMessage("Must not be called")]);
		await expect(runtime.agent.prompt("Question")).rejects.toThrow("disk full");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(runtime.agent.state.isStreaming).toBe(false);
		await expect(runtime.close()).rejects.toThrow("disk full");
	});
});
