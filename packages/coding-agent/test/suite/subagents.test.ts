import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { getOutputArtifacts } from "../../src/core/output-artifacts.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { discoverAgentDefinitions } from "../../src/core/subagents/definitions.ts";
import { SubagentManager } from "../../src/core/subagents/manager.ts";
import type { SubagentHistoryPage } from "../../src/core/subagents/state.ts";
import { createSubagentExtension } from "../../src/extensions/subagents/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

const fixtures: Array<{ directory: string; harness: Harness; reader: SubagentManager }> = [];
const factoryFailures: unknown[] = [];

async function fixture(options: HarnessOptions = {}, directory = mkdtempSync(join(tmpdir(), "pi-native-agents-"))) {
	const parent = options.sessionManager ?? SessionManager.create(directory, join(directory, "sessions"));
	if (!options.sessionManager) {
		parent.appendMessage({ role: "user", content: "PARENT_PRIVATE_CONTEXT", timestamp: 1 });
		parent.appendMessage(fauxAssistantMessage("Parent setup response"));
	}
	const harness = await createHarness({
		...options,
		sessionManager: parent,
		agentDir: options.agentDir ?? directory,
		settings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", ...options.settings },
		extensionFactories: [createSubagentExtension(directory), ...(options.extensionFactories ?? [])],
	});
	harness.session.agent.sessionId = parent.getSessionId();
	const reader = new SubagentManager({
		parent,
		cwd: harness.tempDir,
		agentDir: directory,
		modelRuntime: harness.session.modelRuntime,
		getSettings: () => harness.settingsManager.getSettings(),
		getModel: () => harness.session.model,
		getThinkingLevel: () => harness.session.agent.state.thinkingLevel,
		getAllowedTools: () => harness.session.getActiveToolNames(),
		getSystemPrompt: () => harness.session.agent.state.systemPrompt,
	});
	fixtures.push({ directory, harness, reader });
	return { directory, parent, harness, reader };
}

afterEach(async () => {
	for (const { directory, harness, reader } of fixtures.splice(0)) {
		await Promise.all([
			harness.session.abort(),
			reader.close(),
			harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }),
		]);
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
	expect(factoryFailures.splice(0)).toEqual([]);
});

function delegate(args: Record<string, unknown>) {
	return fauxAssistantMessage(
		{ type: "toolCall", id: "delegate-call", name: "subagent", arguments: { action: "start", ...args } },
		{ stopReason: "toolUse" },
	);
}

function queueFactory(harness: Harness, factory: FauxResponseFactory) {
	const checked: FauxResponseFactory = async (context, options, state, model) => {
		if (options?.sessionId?.startsWith("label:")) return fauxAssistantMessage("Inspect delegated task");
		try {
			return await factory(context, options, state, model);
		} catch (error) {
			factoryFailures.push(error);
			throw error;
		}
	};
	harness.setResponses(Array.from({ length: 12 }, () => checked));
}

function retainedToolText(harness: Harness, message: unknown): string {
	const text = getMessageText(message);
	const uri = /^\[Full captured output: (artifact:\/\/(?:temporary\/)?[a-f0-9]{64}\/[a-f0-9-]{36})\./.exec(text)?.[1];
	return uri ? readFileSync(getOutputArtifacts(harness.sessionManager)!.resolve(uri), "utf8") : text;
}

describe("native sub-agent controls", () => {
	it("runs local tools in the child's cwd without inheriting parent extension closures or leaking its trace", async () => {
		let parentOnlyCalls = 0;
		const parentExtension: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "parent_only",
				label: "Parent only",
				description: "Parent-owned tool",
				parameters: Type.Object({}),
				async execute() {
					parentOnlyCalls++;
					return { content: [{ type: "text", text: "PARENT CONTAMINATION" }], details: {} };
				},
			});
		};
		const { parent, harness, reader } = await fixture({ extensionFactories: [parentExtension] });
		writeFileSync(join(harness.tempDir, "evidence.txt"), "PRIVATE_CHILD_TOOL_LOG: parser boundary evidence");
		let mainCalls = 0;
		let childCalls = 0;
		queueFactory(harness, (context, options) => {
			if (options?.sessionId === parent.getSessionId()) {
				if (++mainCalls === 1) return delegate({ task: "Read evidence.txt and return only a concise finding" });
				expect(JSON.stringify(context)).not.toContain("PRIVATE_CHILD_TOOL_LOG");
				expect(JSON.stringify(context)).not.toContain("CHILD_PRIVATE_REASONING");
				return fauxAssistantMessage("Parent received the concise finding");
			}
			if (++childCalls === 1) {
				expect(JSON.stringify(context)).not.toContain("PARENT_PRIVATE_CONTEXT");
				return fauxAssistantMessage(
					[
						{ type: "thinking", thinking: "CHILD_PRIVATE_REASONING" },
						{ type: "toolCall", id: "child-read", name: "read", arguments: { path: "evidence.txt" } },
						{ type: "toolCall", id: "child-parent-tool", name: "parent_only", arguments: {} },
					],
					{ stopReason: "toolUse" },
				);
			}
			const results = context.messages.filter((message) => message.role === "toolResult");
			expect(getMessageText(results.find((message) => message.toolCallId === "child-read"))).toContain(
				"PRIVATE_CHILD_TOOL_LOG",
			);
			expect(results.find((message) => message.toolCallId === "child-parent-tool")?.isError).toBe(true);
			return fauxAssistantMessage("Concise finding: the parser boundary is covered");
		});
		await harness.session.prompt("Delegate the local investigation");
		expect(getMessageText(getToolResult(harness, "subagent"))).toContain(
			"Concise finding: the parser boundary is covered",
		);
		expect(parentOnlyCalls).toBe(0);
		const child = reader.list()[0];
		const childLog = readFileSync(child.historyPath!, "utf8");
		expect(childLog).toContain("PRIVATE_CHILD_TOOL_LOG");
		expect(childLog).toContain("CHILD_PRIVATE_REASONING");
		const mainLog = readFileSync(parent.getSessionFile()!, "utf8");
		expect(mainLog).not.toContain("PRIVATE_CHILD_TOOL_LOG");
		expect(mainLog).not.toContain("CHILD_PRIVATE_REASONING");
		expect(mainLog).not.toContain("child-parent-tool");
	});

	it("inherits active conversation and original image attachments only when a snapshot is requested", async () => {
		const { parent, harness } = await fixture({ models: [{ id: "vision", input: ["text", "image"] }] });
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1kAAAAASUVORK5CYII=",
		};
		parent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Snapshot-specific private background" }, image],
			timestamp: 2,
		});
		parent.appendMessage(fauxAssistantMessage("Image context acknowledged"));
		let mainCalls = 0;
		queueFactory(harness, (context, options) => {
			if (options?.sessionId === parent.getSessionId())
				return ++mainCalls === 1
					? delegate({
							task: "Use the frozen background",
							contextMode: "snapshot",
							context: "Explicit additional requirement",
						})
					: fauxAssistantMessage("Snapshot result received");
			expect(JSON.stringify(context)).toContain("Snapshot-specific private background");
			expect(JSON.stringify(context)).toContain("Explicit additional requirement");
			const images = context.messages.flatMap((message) =>
				message.role !== "assistant" && typeof message.content !== "string"
					? message.content.filter((content) => content.type === "image")
					: [],
			);
			expect(images).toContainEqual(image);
			return fauxAssistantMessage("Original snapshot text and image were available");
		});
		await harness.session.prompt("Delegate with a snapshot");
		expect(getMessageText(getToolResult(harness, "subagent"))).toContain(
			"Original snapshot text and image were available",
		);
	});

	it("honors configured role tools and model without enabling recursive native delegation", async () => {
		const { directory, parent, harness, reader } = await fixture({
			models: [{ id: "main" }, { id: "review", reasoning: true }],
		});
		mkdirSync(join(directory, "agents"));
		writeFileSync(
			join(directory, "agents", "auditor.md"),
			`---\nname: auditor\ndescription: Review without writes\ntools: read\nmodel: ${harness.getModel().provider}/review\nthinkingLevel: high\n---\nCheck the assigned boundary without changing files.\n`,
		);
		const protectedFile = join(harness.tempDir, "protected.txt");
		writeFileSync(protectedFile, "Original shared-tree contents");
		let mainCalls = 0;
		let childCalls = 0;
		queueFactory(harness, (context, options, _state, model) => {
			if (options?.sessionId === parent.getSessionId())
				return ++mainCalls === 1
					? delegate({ agent: "auditor", task: "Review protected.txt" })
					: fauxAssistantMessage("Read-only review received");
			expect(model.id).toBe("review");
			if (++childCalls === 1)
				return fauxAssistantMessage(
					[
						{
							type: "toolCall",
							id: "forbidden-write",
							name: "write",
							arguments: { path: "protected.txt", content: "Overwritten" },
						},
						{
							type: "toolCall",
							id: "recursive-child",
							name: "subagent",
							arguments: { action: "start", task: "Nested task" },
						},
					],
					{ stopReason: "toolUse" },
				);
			const results = context.messages.filter((message) => message.role === "toolResult");
			expect(results.find((message) => message.toolCallId === "forbidden-write")?.isError).toBe(true);
			expect(results.find((message) => message.toolCallId === "recursive-child")?.isError).toBe(true);
			return fauxAssistantMessage("Read-only boundary held");
		});
		await harness.session.prompt("Use the configured auditor");
		expect(getMessageText(getToolResult(harness, "subagent"))).toContain("Read-only boundary held");
		expect(readFileSync(protectedFile, "utf8")).toBe("Original shared-tree contents");
		expect(reader.list()[0].thinkingLevel).toBe("high");
	});

	it("requires approval before executing a repository-controlled role in an untrusted project", async () => {
		const { harness, reader } = await fixture();
		harness.settingsManager.setProjectTrusted(false);
		mkdirSync(join(harness.tempDir, CONFIG_DIR_NAME, "agents"), { recursive: true });
		writeFileSync(
			join(harness.tempDir, CONFIG_DIR_NAME, "agents", "repo-worker.md"),
			"---\nname: repo-worker\ndescription: Repository controlled worker\ntools: write\n---\nChange the shared working tree.\n",
		);
		harness.setResponses([
			delegate({ agent: "repo-worker", task: "Execute a repository-defined role" }),
			fauxAssistantMessage("Approval was required"),
		]);
		await harness.session.prompt("Try the untrusted project role");
		expect(getToolResult(harness, "subagent").isError).toBe(true);
		expect(reader.list()).toEqual([]);
	});

	it.each(["completed", "failed"] as const)(
		"continues the idle parent with one bounded async %s result",
		async (outcome) => {
			const { parent, harness, reader } = await fixture();
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const delivered = Promise.withResolvers<void>();
			const unsubscribe = harness.session.subscribe((event) => {
				if (
					event.type === "message_end" &&
					event.message.role === "custom" &&
					event.message.customType === "subagent-result"
				)
					delivered.resolve();
			});
			let mainCalls = 0;
			queueFactory(harness, async (context, options) => {
				if (options?.sessionId === parent.getSessionId()) {
					if (++mainCalls === 1) return delegate({ task: "Produce the asynchronous finding", async: true });
					if (mainCalls === 2) return fauxAssistantMessage("The background child is still running");
					expect(mainCalls).toBe(3);
					expect(JSON.stringify(context)).toContain("FINAL_ASYNC_FINDING");
					return fauxAssistantMessage("Parent consumed the asynchronous finding");
				}
				started.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				const text = `FINAL_ASYNC_FINDING\n${"Long child evidence. ".repeat(6000)}`;
				return outcome === "completed"
					? fauxAssistantMessage(text)
					: fauxAssistantMessage("", { stopReason: "error", errorMessage: text });
			});
			const run = harness.session.prompt("Launch a background child");
			await started.promise;
			await run;
			const child = reader.list()[0];
			expect(child.status).toBe("running");
			expect(getMessageText(getToolResult(harness, "subagent"))).not.toContain("FINAL_ASYNC_FINDING");
			release.resolve();
			await delivered.promise;
			unsubscribe();
			await vi.waitFor(() => {
				expect(getMessageText(harness.session.messages.at(-1))).toBe("Parent consumed the asynchronous finding");
				expect(harness.session.isStreaming).toBe(false);
			});
			expect(mainCalls).toBe(3);
			await harness.session.extensionRunner?.emit({
				type: "session_tree",
				oldLeafId: null,
				newLeafId: parent.getLeafId()!,
			});
			await new Promise((resolve) => setImmediate(resolve));
			expect(mainCalls).toBe(3);
			const notices = harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "subagent-result",
			);
			expect(notices).toHaveLength(1);
			expect(getMessageText(notices[0])).toContain("FINAL_ASYNC_FINDING");
			expect(Buffer.byteLength(getMessageText(notices[0]))).toBeLessThan(53000);
			expect(readFileSync(child.historyPath!, "utf8")).toContain("Long child evidence. ".repeat(6000));
			if (outcome === "failed")
				expect(reader.history(child.id, 0, Number.MAX_SAFE_INTEGER).text).toContain(
					"Long child evidence. ".repeat(6000),
				);
		},
	);

	it("records a child result completed during current work without continuing the settled parent", async () => {
		const { parent, harness, reader } = await fixture();
		const currentWork = Promise.withResolvers<void>();
		const finishCurrentWork = Promise.withResolvers<void>();
		const releaseChild = Promise.withResolvers<void>();
		let mainCalls = 0;
		queueFactory(harness, async (_context, options) => {
			if (options?.sessionId === parent.getSessionId()) {
				if (++mainCalls === 1) return delegate({ task: "Finish while the parent works", async: true });
				if (mainCalls === 2) {
					currentWork.resolve();
					options?.signal?.addEventListener("abort", () => finishCurrentWork.resolve(), { once: true });
					await finishCurrentWork.promise;
				}
				return fauxAssistantMessage("Parent current work completed");
			}
			options?.signal?.addEventListener("abort", () => releaseChild.resolve(), { once: true });
			await releaseChild.promise;
			return fauxAssistantMessage("RESULT_BEFORE_PRINT_SHUTDOWN");
		});
		const running = harness.session.prompt("Delegate while completing the current parent work");
		await currentWork.promise;
		releaseChild.resolve();
		try {
			await vi.waitFor(() => expect(reader.list()[0].status).toBe("completed"));
			await new Promise((resolve) => setImmediate(resolve));
			expect(mainCalls).toBe(2);
		} finally {
			finishCurrentWork.resolve();
		}
		await running;
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(mainCalls).toBe(2);
		expect(JSON.stringify(harness.session.messages)).toContain("RESULT_BEFORE_PRINT_SHUTDOWN");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "subagent-result",
			),
		).toHaveLength(1);
	});

	it("waits for parent continue when an async child completes during pause", async () => {
		const { parent, harness, reader } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let mainCalls = 0;
		queueFactory(harness, async (context, options) => {
			if (options?.sessionId === parent.getSessionId()) {
				if (++mainCalls === 1) return delegate({ task: "Complete during parent pause", async: true });
				if (mainCalls === 2) return fauxAssistantMessage("Parent awaiting child");
				expect(JSON.stringify(context)).toContain("PAUSED_CHILD_RESULT");
				return fauxAssistantMessage("Parent consumed the result after continue");
			}
			started.resolve();
			options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return fauxAssistantMessage("PAUSED_CHILD_RESULT");
		});
		const running = harness.session.prompt("Launch a child then pause");
		await started.promise;
		await running;
		const paused = harness.session.recovery.pause();
		release.resolve();
		await paused;
		await vi.waitFor(() => {
			expect(reader.list()[0].status).toBe("completed");
			expect(harness.session.isStreaming).toBe(true);
		});
		expect(mainCalls).toBe(2);
		expect(harness.session.recovery.isPaused).toBe(true);
		harness.session.recovery.resume();
		await vi.waitFor(() => {
			expect(getMessageText(harness.session.messages.at(-1))).toBe("Parent consumed the result after continue");
			expect(harness.session.isStreaming).toBe(false);
		});
		expect(mainCalls).toBe(3);
	});

	it("retains an async result while another child needs recovery approval", async () => {
		const { parent, harness } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let mainCalls = 0;
		queueFactory(harness, async (context, options) => {
			if (options?.sessionId === parent.getSessionId()) {
				if (++mainCalls === 1) return delegate({ task: "Return late recovery evidence", async: true });
				if (mainCalls === 2) return fauxAssistantMessage("Parent waiting for child evidence");
				if (mainCalls === 3) return fauxAssistantMessage("Parent recovery approved");
				expect(mainCalls).toBe(4);
				expect(JSON.stringify(context)).toContain("LATE_RECOVERY_EVIDENCE");
				return fauxAssistantMessage("Parent consumed the approved child result");
			}
			started.resolve();
			options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return fauxAssistantMessage("LATE_RECOVERY_EVIDENCE");
		});
		const running = harness.session.prompt("Launch a child before recovery is needed");
		await started.promise;
		await running;
		expect(harness.session.recovery.info().main).toBe(false);
		let interrupted = true;
		const unregister = harness.session.recovery.registerPeer({
			pause: async () => {},
			resume: () => {},
			pending: () => (interrupted ? [{ id: "interrupted-child", label: "Interrupted child" }] : []),
			recover: async () => {
				interrupted = false;
			},
			discard: async () => {
				interrupted = false;
			},
		});
		const errors: unknown[] = [];
		const unsubscribe = harness.session.extensionRunner?.onError((error) => errors.push(error));
		release.resolve();
		await vi.waitFor(() => expect(harness.session.recovery.info().queuedInputs).toBe(1));
		expect(mainCalls).toBe(2);
		expect(harness.session.recovery.needsRecovery).toBe(true);
		await harness.session.recovery.recover();
		unregister();
		unsubscribe?.();
		expect(errors).toEqual([]);
		expect(mainCalls).toBe(4);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("Parent consumed the approved child result");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "subagent-result",
			),
		).toHaveLength(1);
	});

	it("does not enqueue a second notice after reopening with a child result awaiting recovery approval", async () => {
		const { parent, harness, directory } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let mainCalls = 0;
		queueFactory(harness, async (_context, options) => {
			if (options?.sessionId === parent.getSessionId())
				return ++mainCalls === 1
					? delegate({ task: "Return evidence before reopening", async: true })
					: fauxAssistantMessage("Parent awaiting evidence");
			started.resolve();
			options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return fauxAssistantMessage("RESULT_RETAINED_ACROSS_REOPEN");
		});
		const running = harness.session.prompt("Launch a child before reopening");
		await started.promise;
		await running;
		harness.session.recovery.registerPeer({
			pause: async () => {},
			resume: () => {},
			pending: () => [{ id: "interrupted-child", label: "Interrupted child" }],
			recover: async () => {},
			discard: async () => {},
		});
		release.resolve();
		await vi.waitFor(() => expect(harness.session.recovery.info().queuedInputs).toBe(1));
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.session.dispose();
		const reopened = await fixture({ sessionManager: SessionManager.open(parent.getSessionFile()!) }, directory);
		await reopened.harness.session.bindExtensions({ mode: "json" });
		await new Promise((resolve) => setImmediate(resolve));
		expect(reopened.harness.session.recovery.info().queuedInputs).toBe(1);
		reopened.harness.setResponses(
			Array.from({ length: 3 }, () => fauxAssistantMessage("Parent consumed the recovered child result")),
		);
		await reopened.harness.session.recovery.recover();
		expect(
			reopened.harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "subagent-result",
			),
		).toHaveLength(1);
	});

	it("replays an already completed child once without starting a parent turn", async () => {
		const { directory, harness, reader } = await fixture();
		const role = discoverAgentDefinitions(harness.tempDir, directory).agents.find(
			(agent) => agent.name === "worker",
		)!;
		queueFactory(harness, () => fauxAssistantMessage("REPLAYED_CHILD_RESULT"));
		const child = reader.start(role, "Finish before the parent opens", { delivery: "async" });
		await reader.wait(child.id);
		await harness.session.bindExtensions({ mode: "json" });
		await harness.session.waitForIdle();
		const notices = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "subagent-result",
		);
		expect(notices).toHaveLength(1);
		expect(getMessageText(notices[0])).toContain("REPLAYED_CHILD_RESULT");
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "pi.subagent-result-delivery"),
		).toBe(false);
	});

	it("delivers a child completion observed during tree navigation passively on the origin branch", async () => {
		const navigating = Promise.withResolvers<void>();
		const finishNavigation = Promise.withResolvers<void>();
		const { parent, harness, reader } = await fixture({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						navigating.resolve();
						await finishNavigation.promise;
					});
				},
			],
		});
		const beforeLaunch = parent.getLeafId()!;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let mainCalls = 0;
		queueFactory(harness, async (_context, options) => {
			if (options?.sessionId === parent.getSessionId())
				return ++mainCalls === 1
					? delegate({ task: "Complete during tree navigation", async: true })
					: fauxAssistantMessage("Parent awaiting branch-scoped evidence");
			started.resolve();
			options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return fauxAssistantMessage("NAVIGATION_CHILD_RESULT");
		});
		const running = harness.session.prompt("Launch a child then change branches");
		await started.promise;
		await running;
		const launchLeaf = parent.getLeafId()!;
		const navigation = harness.session.navigateTree(beforeLaunch, { summarize: false });
		await navigating.promise;
		release.resolve();
		try {
			await vi.waitFor(() => expect(reader.list()[0].status).toBe("completed"));
			await new Promise((resolve) => setImmediate(resolve));
			expect(mainCalls).toBe(2);
		} finally {
			finishNavigation.resolve();
			await navigation;
		}
		expect(JSON.stringify(harness.session.messages)).not.toContain("NAVIGATION_CHILD_RESULT");
		await harness.session.navigateTree(launchLeaf, { summarize: false });
		await harness.session.waitForIdle();
		expect(mainCalls).toBe(2);
		expect(getMessageText(harness.session.messages.at(-1))).toContain("NAVIGATION_CHILD_RESULT");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "subagent-result",
			),
		).toHaveLength(1);
	});

	it("preserves an eligible pending result when another branch's child finishes during a turn", async () => {
		const { parent, harness, reader } = await fixture();
		const beforeLaunch = parent.getLeafId()!;
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const busy = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let mainCalls = 0;
		let children = 0;
		queueFactory(harness, async (_context, options) => {
			if (options?.sessionId !== parent.getSessionId()) {
				const gate = ++children === 1 ? first : second;
				options?.signal?.addEventListener("abort", () => gate.resolve(), { once: true });
				await gate.promise;
				return fauxAssistantMessage(gate === first ? "FIRST_FINDING" : "SECOND_FINDING");
			}
			if (++mainCalls === 1 || mainCalls === 3) return delegate({ task: "Find evidence", async: true });
			if (mainCalls === 4) {
				busy.resolve();
				await finish.promise;
			}
			return fauxAssistantMessage(`Parent response ${mainCalls}`);
		});
		await harness.session.prompt("Launch the first child");
		const origin = parent.getLeafId()!;
		await harness.session.navigateTree(beforeLaunch, { summarize: false });
		first.resolve();
		await vi.waitFor(() => expect(reader.list()[0].status).toBe("completed"));
		const run = harness.session.prompt("Launch the second child on this branch");
		await busy.promise;
		second.resolve();
		try {
			await vi.waitFor(() => expect(reader.list().filter((agent) => agent.status === "completed")).toHaveLength(2));
		} finally {
			finish.resolve();
			await run;
		}
		expect(getMessageText(harness.session.messages.at(-1))).toContain("SECOND_FINDING");
		await harness.session.navigateTree(origin, { summarize: false });
		await harness.session.waitForIdle();
		expect(getMessageText(harness.session.messages.at(-1))).toBe("Parent response 5");
		expect(JSON.stringify(harness.session.messages)).toContain("FIRST_FINDING");
	});

	it.each([true, false])("holds an off-branch result with user chat at completion: %s", async (hasChat) => {
		const { parent, harness, reader } = await fixture();
		const beforeLaunch = hasChat ? parent.getLeafId()! : parent.getBranch()[0].id;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		const unsubscribe = harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "subagent-result"
			)
				delivered.resolve();
		});
		let mainCalls = 0;
		queueFactory(harness, async (context, options) => {
			if (options?.sessionId === parent.getSessionId()) {
				if (++mainCalls === 1) return delegate({ task: "Finish on the originating branch", async: true });
				if (mainCalls === 2) return fauxAssistantMessage("Child launched on this branch");
				expect(mainCalls).toBe(3);
				expect(JSON.stringify(context)).toContain("BRANCH_SCOPED_RESULT");
				return fauxAssistantMessage("Parent consumed the result on its originating branch");
			}
			started.resolve();
			options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return fauxAssistantMessage("BRANCH_SCOPED_RESULT");
		});
		const run = harness.session.prompt("Launch a branch-scoped child");
		await started.promise;
		await run;
		const launchLeaf = parent.getLeafId()!;
		const child = reader.list()[0];
		await harness.session.navigateTree(beforeLaunch, { summarize: false });
		release.resolve();
		await vi.waitFor(() => expect(reader.inspect(child.id).status).toBe("completed"));
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "subagent-result",
			),
		).toBe(false);
		expect(mainCalls).toBe(2);
		await harness.session.navigateTree(launchLeaf, { summarize: false });
		await delivered.promise;
		unsubscribe();
		await harness.session.waitForIdle();
		if (hasChat)
			expect(getMessageText(harness.session.messages.at(-1))).toBe(
				"Parent consumed the result on its originating branch",
			);
		else expect(getMessageText(harness.session.messages.at(-1))).toContain("BRANCH_SCOPED_RESULT");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "subagent-result",
			),
		).toHaveLength(1);
		expect(mainCalls).toBe(hasChat ? 3 : 2);
	});
	it("paginates the actual rows returned under the byte cap without losing queued children", async () => {
		const { directory, parent, harness, reader } = await fixture({ settings: { subagents: { maxConcurrent: 1 } } });
		const role = discoverAgentDefinitions(harness.tempDir, directory).agents.find(
			(agent) => agent.name === "worker",
		)!;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const seen: string[] = [];
		let mainCalls = 0;
		queueFactory(harness, async (context, options) => {
			if (options?.sessionId !== parent.getSessionId()) {
				started.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage("Stopped metadata-list fixture");
			}
			let skip = 0;
			if (++mainCalls > 1) {
				const result = context.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === "subagent",
				);
				const page = JSON.parse(retainedToolText(harness, result)) as {
					agents: Array<{ id: string }>;
					total: number;
					nextSkip?: number;
				};
				expect(page.total).toBe(120);
				seen.push(...page.agents.map((agent) => agent.id));
				if (page.nextSkip === undefined) return fauxAssistantMessage("All queued children listed");
				expect(page.nextSkip).toBe(seen.length);
				skip = page.nextSkip;
			}
			return fauxAssistantMessage(
				{
					type: "toolCall",
					id: `list-${mainCalls}`,
					name: "subagent",
					arguments: { action: "list", limit: 100, skip },
				},
				{ stopReason: "toolUse" },
			);
		});
		const children = Array.from({ length: 120 }, (_, index) => reader.start(role, `Queued task ${index}`));
		await started.promise;
		await harness.session.prompt("List the queued children through every page");
		expect(seen).toHaveLength(120);
		expect(new Set(seen)).toEqual(new Set(children.map((child) => child.id)));
	});

	it("returns parseable history pages and actionable offsets even for heavily escaped tool text", async () => {
		const { parent, harness, reader } = await fixture();
		let mainCalls = 0;
		let offset = 0;
		let retrieved = "";
		queueFactory(harness, (context, options) => {
			if (options?.sessionId !== parent.getSessionId())
				return fauxAssistantMessage(`${"\0".repeat(16000)}END_OF_CHILD_RESPONSE`);
			if (++mainCalls === 1) return delegate({ task: "Return the unusual original evidence" });
			const child = reader.list()[0];
			if (mainCalls === 2)
				return fauxAssistantMessage(
					{
						type: "toolCall",
						id: "history-first",
						name: "subagent",
						arguments: { action: "history", id: child.id },
					},
					{ stopReason: "toolUse" },
				);
			const result = context.messages.findLast(
				(message) => message.role === "toolResult" && message.toolName === "subagent",
			);
			const page = JSON.parse(retainedToolText(harness, result)) as SubagentHistoryPage;
			expect(page.offset).toBe(offset);
			retrieved += page.text;
			const nextOffset = page.nextOffset;
			if (nextOffset !== undefined) {
				expect(nextOffset).toBeGreaterThan(offset);
				offset = nextOffset;
				return fauxAssistantMessage(
					{
						type: "toolCall",
						id: `history-${mainCalls}`,
						name: "subagent",
						arguments: { action: "history", id: child.id, offset },
					},
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Original history can be paged without gaps");
		});
		await harness.session.prompt("Inspect the child's original evidence in pages");
		expect(retrieved).toContain(`${"\0".repeat(16000)}END_OF_CHILD_RESPONSE`);
	});

	it("does not deadlock group pause behind an already-running synchronous delegation tool", async () => {
		const { parent, harness, reader } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let mainCalls = 0;
		queueFactory(harness, async (_context, options) => {
			if (options?.sessionId === parent.getSessionId())
				return ++mainCalls === 1
					? delegate({ task: "Finish the synchronous child" })
					: fauxAssistantMessage("Parent continued once");
			started.resolve();
			options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return fauxAssistantMessage("Synchronous child completed");
		});
		const run = harness.session.prompt("Delegate then pause safely");
		await started.promise;
		const pausing = harness.session.recovery.pause();
		release.resolve();
		await pausing;
		expect(reader.list().map((agent) => agent.status)).toEqual(["completed"]);
		expect(mainCalls).toBe(1);
		harness.session.recovery.resume();
		await run;
		expect(mainCalls).toBe(2);
		expect(getMessageText(getToolResult(harness, "subagent"))).toContain("Synchronous child completed");
	});
});
