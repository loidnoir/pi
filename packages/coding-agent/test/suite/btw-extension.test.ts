import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getKeybindings, setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { openPane, type PaneHandle, type PaneView } from "../../src/core/panes/host.ts";
import { SideChatView } from "../../src/core/panes/side-chat.ts";
import { SideChatListView } from "../../src/core/panes/side-chat-list.ts";
import { createBtwExtension } from "../../src/extensions/btw/index.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

vi.mock("../../src/core/panes/host.ts", () => ({ openPane: vi.fn() }));

const harnesses: Harness[] = [];
const presented: { pane: PaneHandle; view: PaneView }[] = [];
let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
	vi.mocked(openPane).mockImplementation(async (_ctx, options) => {
		const closed = Promise.withResolvers<void>();
		let disposed = false;
		let pane: PaneHandle;
		const view = options.create({
			invalidate() {},
			close() {
				void pane.close();
			},
			async minimize() {},
			async setTitle() {},
		});
		pane = {
			backend: "tui",
			placement: undefined,
			closed: closed.promise,
			async close() {
				if (disposed) return closed.promise;
				disposed = true;
				await view.dispose();
				closed.resolve();
			},
			show: vi.fn(async () => {}),
			async minimize() {},
		};
		presented.push({ pane, view });
		return pane;
	});
});
afterEach(async () => {
	for (const { pane } of presented.splice(0)) await pane.close();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.mocked(openPane).mockReset();
	setKeybindings(previousKeys);
});

async function fixture(options: Pick<HarnessOptions, "models"> = {}) {
	const harness = await createHarness({ ...options, extensionFactories: [createBtwExtension()] });
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "tui" });
	return harness;
}

function text(view: PaneView): string {
	return view.render(120, 40).map(stripTerminalSequences).join("\n");
}

function currentChat(): SideChatView {
	const view = presented.at(-1)!.view;
	if (!(view instanceof SideChatView)) throw new Error("Expected side chat");
	return view;
}

describe("saved /btw command", () => {
	it("bare /btw restores a parent-scoped history list without starting a model", async () => {
		const harness = await fixture();
		const before = JSON.stringify(harness.sessionManager.getEntries());
		harness.setResponses([
			() => {
				throw new Error("A list must not call a model");
			},
		]);
		await harness.session.prompt("/btw");
		expect(presented[0].view).toBeInstanceOf(SideChatListView);
		expect(text(presented[0].view)).toContain("No side chats yet");
		await harness.session.prompt("/btw");
		expect(openPane).toHaveBeenCalledOnce();
		expect(presented[0].pane.show).toHaveBeenCalledOnce();
		expect(JSON.stringify(harness.sessionManager.getEntries())).toBe(before);
	});

	it("wires local model and effort controls without changing the main session", async () => {
		const harness = await fixture({
			models: [
				{ id: "parent-model", reasoning: true },
				{ id: "side-model", reasoning: true },
			],
		});
		const before = JSON.stringify(harness.sessionManager.getEntries());
		const parentModel = harness.session.agent.state.model;
		const parentEffort = harness.session.agent.state.thinkingLevel;
		harness.setResponses([fauxAssistantMessage("Ready for local controls")]);
		await harness.session.prompt("/btw Independent controls");
		const chat = currentChat();
		await vi.waitFor(() => expect(text(chat)).toContain("Ready for local controls"));
		await chat.agent.waitForIdle();
		await new Promise<void>((resolve) => setImmediate(resolve));
		chat.handleInput("\u0010");
		expect(chat.agent.state.model.id).toBe("side-model");
		chat.ask("/thinking low");
		expect(chat.agent.state.thinkingLevel).toBe("low");
		expect(text(chat)).toContain("effort low");
		expect(harness.session.agent.state.model).toBe(parentModel);
		expect(harness.session.agent.state.thinkingLevel).toBe(parentEffort);
		expect(JSON.stringify(harness.sessionManager.getEntries())).toBe(before);
	});

	it("every /btw prompt creates separate history; selection restores or reopens it without another request", async () => {
		const harness = await fixture();
		const before = JSON.stringify(harness.sessionManager.getEntries());
		await harness.session.prompt("/btw");
		const list = presented[0].view;
		harness.setResponses([fauxAssistantMessage("First saved answer"), fauxAssistantMessage("Second saved answer")]);
		await harness.session.prompt("/btw Same question");
		const first = currentChat();
		await vi.waitFor(() => expect(text(first)).toContain("First saved answer"));
		await harness.session.prompt("/btw Same question");
		const second = currentChat();
		await vi.waitFor(() => expect(text(second)).toContain("Second saved answer"));
		expect(first).not.toBe(second);
		expect(text(list)).toContain("2 saved");
		expect(JSON.stringify(harness.sessionManager.getEntries())).toBe(before);
		list.handleInput("\r");
		await vi.waitFor(() => expect(presented[2].pane.show).toHaveBeenCalledOnce());
		expect(openPane).toHaveBeenCalledTimes(3);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await presented[2].pane.close();
		list.handleInput("\r");
		await vi.waitFor(() => expect(openPane).toHaveBeenCalledTimes(4));
		const reopened = currentChat();
		expect(text(reopened)).toContain("Second saved answer");
		expect(harness.getPendingResponseCount()).toBe(0);
		harness.setResponses([fauxAssistantMessage("Reopened follow-up answer")]);
		reopened.ask("Continue this chat");
		await vi.waitFor(() => expect(text(reopened)).toContain("Reopened follow-up answer"));
		expect(JSON.stringify(harness.sessionManager.getEntries())).toBe(before);
	});
});
