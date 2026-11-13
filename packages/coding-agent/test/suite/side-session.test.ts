import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { openPane, type PaneHandle } from "../../src/core/panes/host.ts";
import { SideChatView } from "../../src/core/panes/side-chat.ts";
import { createSideSession } from "../../src/core/side-session.ts";
import { createBtwExtension } from "../../src/extensions/btw/index.ts";
import { iconPrefix, setIconPreset } from "../../src/modes/interactive/icons.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

vi.mock("../../src/core/panes/host.ts", () => ({ openPane: vi.fn() }));

const harnesses: Harness[] = [];
const agents: Agent[] = [];
afterEach(async () => {
	for (const agent of agents.splice(0)) {
		agent.abort();
		await agent.waitForIdle();
	}
	for (const harness of harnesses.splice(0)) harness.cleanup();
	setIconPreset("unicode");
	vi.mocked(openPane).mockReset();
});

async function sideContext(): Promise<{ harness: Harness; context: ExtensionContext }> {
	const capture: { context?: ExtensionContext } = {};
	const harness = await createHarness({
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
	if (!capture.context) throw new Error("Expected extension context after session start");
	return { harness, context: capture.context };
}

describe("temporary read-only side conversations", () => {
	it("formats each new /btw pane title through the live shared prefix without a model call", async () => {
		const panes: PaneHandle[] = [];
		vi.mocked(openPane).mockImplementation(async (_ctx, options) => {
			const closed = Promise.withResolvers<void>();
			const view = options.create({ invalidate() {}, close() {}, async minimize() {}, async setTitle() {} });
			const handle: PaneHandle = {
				backend: "tui",
				placement: undefined,
				closed: closed.promise,
				async close() {
					await view.dispose();
					closed.resolve();
				},
				async show() {},
				async minimize() {},
			};
			panes.push(handle);
			return handle;
		});
		const harness = await createHarness({ extensionFactories: [createBtwExtension()] });
		harnesses.push(harness);
		harness.setResponses([
			() => {
				throw new Error("Opening an empty side pane must not call a model");
			},
		]);
		await harness.session.bindExtensions({});
		const before = JSON.stringify(harness.sessionManager.getEntries());
		for (const preset of ["nerd", "unicode"] as const) {
			setIconPreset(preset);
			await harness.session.prompt("/btw");
			try {
				expect(vi.mocked(openPane).mock.calls.at(-1)?.[1].title).toBe(
					`${iconPrefix("chat")}btw — temporary read-only conversation`,
				);
			} finally {
				await panes.pop()!.close();
			}
		}
		expect(openPane).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(harness.sessionManager.getEntries())).toBe(before);
	});

	it("inherits main context, reads files and rejects write/bash without changing main history", async () => {
		const { harness, context } = await sideContext();
		harness.setResponses([fauxAssistantMessage("Main answer")]);
		await harness.session.prompt("Main context marker ZX_104");
		const file = join(harness.tempDir, "note.txt");
		writeFileSync(file, "read-only marker");
		const before = JSON.stringify(harness.sessionManager.getEntries());
		const mainMessages = JSON.stringify(harness.session.messages);
		const side = createSideSession(context);
		agents.push(side);
		harness.setResponses([
			(request) => {
				expect(request.messages.some((message) => getMessageText(message).includes("ZX_104"))).toBe(true);
				expect(
					getCurrentTools(request.messages)
						.map((tool) => tool.name)
						.sort(),
				).toEqual(["find", "grep", "ls", "read"]);
				return fauxAssistantMessage([fauxToolCall("read", { path: file })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "changed" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "exit 9" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Side answer"),
			fauxAssistantMessage("Follow-up answer"),
		]);
		await side.prompt("Inspect the note");
		await side.prompt("Explain that answer");
		const results = side.state.messages.filter((message) => message.role === "toolResult");
		expect(getMessageText(results.find((message) => message.toolName === "read"))).toContain("read-only marker");
		for (const name of ["write", "bash"])
			expect(results.find((message) => message.toolName === name)?.isError).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("read-only marker");
		expect(side.state.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
			"Follow-up answer",
		);
		expect(JSON.stringify(harness.sessionManager.getEntries())).toBe(before);
		expect(JSON.stringify(harness.session.messages)).toBe(mainMessages);
		const view = new SideChatView(side, { invalidate() {}, close() {}, async minimize() {}, async setTitle() {} });
		await view.dispose();
		expect(side.state.messages).toEqual([]);
		expect(side.peekQueuedMessages()).toEqual([]);
	});

	it("excludes an unfinished main tool round instead of fabricating tool results", async () => {
		const { harness, context } = await sideContext();
		harness.sessionManager.appendMessage({ role: "user", content: "Current work", timestamp: Date.now() });
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxToolCall("bash", { command: "long operation" })], { stopReason: "toolUse" }),
		);
		const before = JSON.stringify(harness.sessionManager.getEntries());
		const side = createSideSession(context);
		agents.push(side);
		expect(
			side.state.messages.some((message) => message.role === "user" && getMessageText(message) === "Current work"),
		).toBe(true);
		expect(side.state.messages.some((message) => message.role === "assistant" || message.role === "toolResult")).toBe(
			false,
		);
		harness.setResponses([fauxAssistantMessage("Independent answer")]);
		await side.prompt("A side question while main is busy");
		expect(getMessageText(side.state.messages.at(-1))).toBe("Independent answer");
		expect(JSON.stringify(harness.sessionManager.getEntries())).toBe(before);
	});
});
