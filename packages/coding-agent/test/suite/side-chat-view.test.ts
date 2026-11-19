import type { Agent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { CURSOR_MARKER, Loader, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateContextTokens } from "../../src/core/compaction/compaction.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { PaneControls } from "../../src/core/panes/host.ts";
import { SideChatView } from "../../src/core/panes/side-chat.ts";
import { createSideSession } from "../../src/core/side-session.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
const views: SideChatView[] = [];
const agents: Agent[] = [];
beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(async () => {
	for (const view of views.splice(0)) await view.dispose();
	for (const agent of agents.splice(0)) {
		agent.abort();
		await agent.waitForIdle();
	}
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function fixture(options: HarnessOptions = {}) {
	let context: ExtensionContext | undefined;
	const harness = await createHarness({
		...options,
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					context = ctx;
				});
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	if (!context) throw new Error("Missing extension context");
	const agent = createSideSession(context);
	agents.push(agent);
	const firstMessage = agent.state.messages.length;
	const controls: PaneControls = {
		invalidate: vi.fn(),
		close: vi.fn(),
		minimize: vi.fn(async () => {}),
		setTitle: vi.fn(async () => {}),
	};
	return { harness, agent, firstMessage, controls };
}

function localControls(agent: Agent) {
	return {
		setModel: vi.fn((model: Model<string>) => {
			agent.state.model = model;
		}),
		setThinkingLevel: vi.fn((level: ThinkingLevel) => {
			agent.state.thinkingLevel = level;
		}),
		getAvailableThinkingLevels: (): ThinkingLevel[] => ["off", "low", "high"],
	};
}

function text(view: SideChatView): string {
	return view.render(90, 60).map(stripTerminalSequences).join("\n");
}

describe("native side chat presentation", () => {
	it("shows saved own turns on reopen, omits inherited context, and uses native Markdown/tool rendering", async () => {
		const { harness, agent, firstMessage, controls } = await fixture();
		harness.setResponses([fauxAssistantMessage("A saved **answer**")]);
		await agent.prompt("Saved question");
		const view = new SideChatView(agent, controls, "", { firstMessage, saved: true, cwd: harness.tempDir });
		views.push(view);
		expect(text(view)).toContain("Saved question");
		expect(text(view)).toContain("A saved answer");
		expect(text(view)).toContain("saved separately");
		expect(text(view)).not.toContain("**You**");
		expect(text(view)).not.toContain("**Assistant**");
		for (const width of [1, 10, 50]) {
			const lines = view.render(width, 12);
			expect(lines.length).toBeLessThanOrEqual(12);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("expands tool results with the configurable main-chat binding", async () => {
		const { harness, agent, firstMessage, controls } = await fixture();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("missing-tool", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Tool finished"),
		]);
		await agent.prompt("Inspect a tool");
		const view = new SideChatView(agent, controls, "", { firstMessage });
		views.push(view);
		expect(text(view)).toContain("missing-tool");
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+y" }));
		view.handleInput("\u0019");
		expect(text(view)).toContain("Tool finished");
	});

	it("anchors a native multiline editor at the bottom, preserves IME focus, and counts inherited context", async () => {
		const { harness, agent, controls } = await fixture();
		agent.state.messages = [
			...agent.state.messages,
			{ role: "user", content: "PRIVATE inherited context ".repeat(400), timestamp: 1 },
		];
		const firstMessage = agent.state.messages.length;
		agent.state.messages = [...agent.state.messages, { role: "user", content: "Short own question", timestamp: 2 }];
		const view = new SideChatView(agent, controls, "", { firstMessage, saved: true });
		views.push(view);
		const expectedTokens = estimateContextTokens(agent.state.messages).tokens.toLocaleString();
		for (const height of [24, 40]) {
			const lines = view.render(120, height);
			expect(lines).toHaveLength(height);
			expect(lines.findIndex((line) => line.includes(CURSOR_MARKER))).toBe(height - 5);
			const plain = lines.map(stripTerminalSequences);
			expect(plain.join("\n")).not.toContain("PRIVATE inherited context");
			expect(plain.join("\n")).toContain(`${expectedTokens}/`);
			expect(plain.at(-3)).toContain("effort off");
			const questionRow = plain.findIndex((line) => line.includes("Short own question"));
			expect(plain.slice(questionRow + 2, height - 7).every((line) => !line.trim())).toBe(true);
			expect(plain[height - 6]).toMatch(/^─+$/);
		}
		view.handleInput("\x1b[200~line one\n日本語 two\x1b[201~");
		let lines = view.render(100, 30);
		expect(lines.map(stripTerminalSequences).join("\n")).toContain("line one");
		expect(lines.map(stripTerminalSequences).join("\n")).toContain("日本語 two");
		expect(lines.findIndex((line) => line.includes(CURSOR_MARKER))).toBe(25);
		view.focused = false;
		expect(view.render(100, 30).join("\n")).not.toContain(CURSOR_MARKER);
		view.focused = true;
		expect(view.render(100, 30).join("\n")).toContain(CURSOR_MARKER);
		for (const width of [1, 2, 10, 80])
			for (const height of [8, 12, 30]) {
				lines = view.render(width, height);
				expect(lines).toHaveLength(height);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		harness.setResponses([fauxAssistantMessage("Multiline prompt answered")]);
		const prompt = vi.spyOn(agent, "prompt");
		view.handleInput("\r");
		expect(prompt).toHaveBeenCalledWith("line one\n日本語 two");
		await agent.waitForIdle();
	});

	it.each([false, true])("scrolls side-chat history with a pinned prompt (history-only: %s)", async (historyOnly) => {
		const { agent, controls, firstMessage } = await fixture();
		agent.state.messages = [
			...agent.state.messages,
			fauxAssistantMessage(
				`\`\`\`text\n${Array.from({ length: 80 }, (_, index) => `SCROLL_ROW_${index}`).join("\n")}\n\`\`\``,
			),
		];
		const view = new SideChatView(agent, controls, "", {
			firstMessage,
			continuationError: historyOnly ? "Original main session is missing" : undefined,
		});
		views.push(view);
		if (!historyOnly) view.handleInput("Preserved draft");
		const render = () => view.render(90, 24).map(stripTerminalSequences);
		const firstRow = (lines: string[]) => Number(/SCROLL_ROW_(\d+)/.exec(lines.join("\n"))?.[1]);
		const bottom = render();
		expect(bottom.join("\n")).toContain("SCROLL_ROW_79");
		vi.mocked(controls.invalidate).mockClear();
		view.scrollBy(-6);
		const scrolled = render();
		expect(firstRow(scrolled)).toBe(firstRow(bottom) - 6);
		const pinnedRows = historyOnly ? 1 : 7;
		expect(scrolled.slice(-pinnedRows)).toEqual(bottom.slice(-pinnedRows));
		expect(controls.invalidate).toHaveBeenCalled();
		view.scrollBy(6);
		expect(render()).toEqual(bottom);
		view.scrollBy(-10000);
		const top = render();
		expect(top.join("\n")).toContain("SCROLL_ROW_0");
		view.scrollBy(-10000);
		expect(render()).toEqual(top);
		view.scrollBy(6);
		expect(render()).not.toEqual(top);
		view.scrollBy(10000);
		expect(render()).toEqual(bottom);
		setKeybindings(new KeybindingsManager({ "tui.select.pageUp": "ctrl+u", "tui.select.pageDown": "ctrl+d" }));
		view.handleInput("\x15");
		expect(firstRow(render())).toBe(firstRow(bottom) - 10);
		view.handleInput("\x04");
		expect(render()).toEqual(bottom);
	});

	it("keeps model and effort selectors local, preserves drafts, and honors configured main shortcuts", async () => {
		const { harness, agent, controls, firstMessage } = await fixture({
			models: [
				{ id: "pane-first", reasoning: true },
				{ id: "pane-second", reasoning: true },
			],
		});
		const runtime = localControls(agent);
		const originalMainModel = harness.session.agent.state.model;
		const secondModel = harness.models[1];
		const view = new SideChatView(agent, controls, "", {
			firstMessage,
			runtime,
			modelRuntime: harness.session.modelRuntime,
			scopedModels: harness.models.map((model) => ({ model })),
		});
		views.push(view);
		setKeybindings(
			new KeybindingsManager({
				"app.model.select": "ctrl+j",
				"app.model.cycleForward": "ctrl+n",
				"app.model.cycleBackward": "ctrl+b",
				"app.thinking.cycle": "ctrl+y",
				"app.thinking.toggle": "ctrl+w",
			}),
		);
		view.handleInput("Preserved draft");
		view.handleInput("\x0a");
		expect(text(view)).toContain("pane-second");
		expect(text(view)).not.toContain("Preserved draft");
		expect(view.render(100, 60).join("\n")).toContain(CURSOR_MARKER);
		view.focused = false;
		expect(view.render(100, 60).join("\n")).not.toContain(CURSOR_MARKER);
		view.focused = true;
		view.handleInput("\x1b");
		expect(text(view)).toContain("Preserved draft");
		view.ask("/model pane-second");
		view.handleInput("\r");
		expect(runtime.setModel).toHaveBeenLastCalledWith(secondModel);
		expect(agent.state.model.id).toBe("pane-second");
		expect(text(view)).toContain("Preserved draft");
		view.handleInput("\x0e");
		expect(agent.state.model.id).toBe("pane-first");
		view.handleInput("\x02");
		expect(agent.state.model.id).toBe("pane-second");
		view.handleInput("\x19");
		expect(agent.state.thinkingLevel).toBe("low");
		view.ask("/thinking high");
		expect(agent.state.thinkingLevel).toBe("high");
		view.ask("/thinking off");
		view.ask("/thinking");
		expect(text(view)).toContain("Thinking Level");
		expect(text(view)).not.toContain("set as default");
		view.handleInput("low");
		view.handleInput("\r");
		expect(agent.state.thinkingLevel).toBe("low");
		view.ask("/thinking invalid");
		expect(text(view)).toContain("Available effort levels: off, low, high");
		expect(agent.state.thinkingLevel).toBe("low");
		agent.state.messages = [
			...agent.state.messages,
			fauxAssistantMessage([
				{ type: "thinking", thinking: "Reasoning detail" },
				{ type: "text", text: "Own answer" },
			]),
		];
		expect(text(view)).toContain("Reasoning detail");
		view.handleInput("\x17");
		expect(text(view)).not.toContain("Reasoning detail");
		view.handleInput("\x17");
		expect(text(view)).toContain("Reasoning detail");
		expect(harness.session.agent.state.model).toBe(originalMainModel);
		expect(harness.session.agent.state.thinkingLevel).toBe("off");
		harness.setResponses([fauxAssistantMessage("Ordinary side-chat reply")]);
		view.ask("/effort high");
		await agent.waitForIdle();
		expect(text(view)).toContain("Ordinary side-chat reply");
		expect(agent.state.thinkingLevel).toBe("low");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("rejects picker confirmations and model or effort commands while a request is active", async () => {
		const { harness, agent, controls } = await fixture({
			models: [
				{ id: "busy-first", reasoning: true },
				{ id: "busy-second", reasoning: true },
			],
		});
		const runtime = localControls(agent);
		const view = new SideChatView(agent, controls, "", {
			runtime,
			modelRuntime: harness.session.modelRuntime,
			scopedModels: harness.models.map((model) => ({ model })),
		});
		views.push(view);
		view.ask("/model busy-second");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				started.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage("Finished busy task");
			},
		]);
		const active = agent.prompt("External active side request");
		await started.promise;
		expect(view.render(12, 6).map(stripTerminalSequences).join("\n")).toContain("Working");
		view.handleInput("\r");
		view.handleInput("\x10");
		view.handleInput("\x1b[Z");
		view.ask("/thinking high");
		view.ask("/model busy-second");
		expect(runtime.setModel).not.toHaveBeenCalled();
		expect(runtime.setThinkingLevel).not.toHaveBeenCalled();
		expect(text(view)).toContain("Wait for the current answer");
		expect(agent.state.model.id).toBe("busy-first");
		release.resolve();
		await active;
		await agent.waitForIdle();
		await vi.waitFor(() => {
			view.ask("/thinking high");
			expect(runtime.setThinkingLevel).toHaveBeenCalledWith("high");
		});
	});

	it("animates a prominent working row before initial dispatch and tokens, without moving the bottom editor", async () => {
		const { harness, agent, controls } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				started.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage("Complete answer");
			},
		]);
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const starts = vi.spyOn(Loader.prototype, "start");
		const view = new SideChatView(agent, controls, "Initial held question");
		views.push(view);
		const initial = view.render(80, 24);
		expect(stripTerminalSequences(initial[17])).toContain("Working...");
		expect(stripTerminalSequences(initial[18])).toMatch(/^─+$/);
		expect(initial.findIndex((line) => line.includes(CURSOR_MARKER))).toBe(19);
		const invalidations = vi.mocked(controls.invalidate).mock.calls.length;
		vi.advanceTimersByTime(80);
		expect(vi.mocked(controls.invalidate).mock.calls.length).toBeGreaterThan(invalidations);
		expect(stripTerminalSequences(view.render(80, 24)[17])).not.toBe(stripTerminalSequences(initial[17]));
		await started.promise;
		expect(text(view)).toContain("Working...");
		for (const [width, height] of [
			[1, 1],
			[2, 3],
			[8, 5],
			[12, 6],
			[40, 8],
		]) {
			const lines = view.render(width, height);
			expect(lines.length).toBeLessThanOrEqual(height);
			expect(lines.map(stripTerminalSequences).join("\n")).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(starts).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(1);
		release.resolve();
		await agent.waitForIdle();
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
		expect(text(view)).toContain("Complete answer");
		expect(text(view)).not.toContain("Working...");
		expect(stripTerminalSequences(view.render(80, 24)[17])).toBe("");
	});

	it("keeps one loader across thinking, held tools, provider prefill and queued follow-ups", async () => {
		const { harness, agent, controls } = await fixture();
		const toolStarted = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		agent.state.tools = [
			{
				name: "read",
				label: "Read",
				description: "Held faux read",
				parameters: Type.Object({}),
				execute: async (_id, _args, signal) => {
					toolStarted.resolve();
					signal?.addEventListener("abort", () => releaseTool.resolve(), { once: true });
					await releaseTool.promise;
					return { content: [{ type: "text", text: "Held tool evidence" }], details: {} };
				},
			},
		];
		const nextStarted = Promise.withResolvers<void>();
		const releaseNext = Promise.withResolvers<void>();
		const followupStarted = Promise.withResolvers<void>();
		const releaseFollowup = Promise.withResolvers<void>();
		harness.setResponses([
			fauxAssistantMessage(
				[
					{ type: "thinking", thinking: "Inspecting evidence" },
					{ type: "text", text: "Reading now" },
					fauxToolCall("read", {}),
				],
				{ stopReason: "toolUse" },
			),
			async (_context, options) => {
				nextStarted.resolve();
				options?.signal?.addEventListener("abort", () => releaseNext.resolve(), { once: true });
				await releaseNext.promise;
				return fauxAssistantMessage("First conclusion");
			},
			async (_context, options) => {
				followupStarted.resolve();
				options?.signal?.addEventListener("abort", () => releaseFollowup.resolve(), { once: true });
				await releaseFollowup.promise;
				return fauxAssistantMessage("Follow-up conclusion");
			},
		]);
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const starts = vi.spyOn(Loader.prototype, "start");
		const messages = vi.spyOn(Loader.prototype, "setMessage");
		const view = new SideChatView(agent, controls);
		views.push(view);
		view.ask("Read evidence");
		await toolStarted.promise;
		expect(text(view)).toContain("Running read...");
		view.ask("Queued follow-up");
		expect(text(view)).toContain("Queued:");
		releaseTool.resolve();
		await nextStarted.promise;
		expect(text(view)).toContain("Working...");
		expect(text(view)).not.toContain("Running read...");
		releaseNext.resolve();
		await followupStarted.promise;
		expect(text(view)).toContain("Working...");
		expect(starts).toHaveBeenCalledOnce();
		expect(messages).toHaveBeenCalledWith("Thinking...");
		expect(messages).toHaveBeenCalledWith("Answering...");
		expect(vi.getTimerCount()).toBe(1);
		releaseFollowup.resolve();
		await agent.waitForIdle();
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
		expect(text(view)).toContain("Follow-up conclusion");
		expect(text(view)).not.toContain("Working...");
	});

	it.each(["error", "abort"] as const)(
		"stops the working timer after %s without requiring another render",
		async (outcome) => {
			const { harness, agent, controls } = await fixture();
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			harness.setResponses([
				async (_context, options) => {
					started.resolve();
					options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
					await release.promise;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Deliberate side-chat failure" });
				},
			]);
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			const view = new SideChatView(agent, controls);
			views.push(view);
			view.ask("Held failing request");
			await started.promise;
			expect(text(view)).toContain("Working...");
			if (outcome === "abort") view.handleInput("\x1b");
			else release.resolve();
			await agent.waitForIdle();
			await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
			expect(text(view)).not.toContain("Working...");
			if (outcome === "error") expect(text(view)).toContain("Deliberate side-chat failure");
		},
	);

	it("stops initial and active loaders immediately on disposal, including pending asynchronous dispatch", async () => {
		const { harness, agent, controls } = await fixture();
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const prompt = vi.spyOn(agent, "prompt");
		const initial = new SideChatView(agent, controls, "Never dispatch this question");
		expect(vi.getTimerCount()).toBe(1);
		await initial.dispose();
		expect(vi.getTimerCount()).toBe(0);
		expect(prompt).not.toHaveBeenCalled();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("Late response after closing");
			},
		]);
		const view = new SideChatView(agent, controls);
		views.push(view);
		view.ask("Held async dispatch");
		await started.promise;
		try {
			expect(vi.getTimerCount()).toBe(1);
			const closing = view.dispose();
			expect(vi.getTimerCount()).toBe(0);
			const invalidations = vi.mocked(controls.invalidate).mock.calls.length;
			vi.advanceTimersByTime(240);
			expect(vi.mocked(controls.invalidate).mock.calls.length).toBe(invalidations);
			release.resolve();
			await closing;
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			release.resolve();
		}
	});

	it("permits history viewing but rejects follow-ups when original context is missing", async () => {
		const { harness, agent, firstMessage, controls } = await fixture();
		harness.setResponses([fauxAssistantMessage("Saved before parent deletion")]);
		await agent.prompt("Old question");
		const prompt = vi.spyOn(agent, "prompt");
		const close = vi.fn(async () => {});
		const view = new SideChatView(agent, controls, "", {
			firstMessage,
			saved: true,
			continuationError: "Original main session is missing",
			close,
		});
		views.push(view);
		view.ask("Do not silently drop context");
		expect(prompt).not.toHaveBeenCalled();
		expect(text(view)).toContain("Saved before parent deletion");
		expect(text(view)).toContain("Original main session is missing");
		expect(view.render(90, 60).join("\n")).not.toContain(CURSOR_MARKER);
		expect(
			view
				.render(90, 60)
				.map(stripTerminalSequences)
				.some((line) => /^─+$/.test(line)),
		).toBe(false);
		view.handleInput("\u001b");
		expect(controls.close).toHaveBeenCalledOnce();
		await view.dispose();
		await view.dispose();
		expect(close).toHaveBeenCalledOnce();
		expect(agent.state.messages).toEqual([]);
	});
});
