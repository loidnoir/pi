import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PaneControls } from "../src/core/panes/host.ts";
import type { SubagentManager } from "../src/core/subagents/manager.ts";
import type { SubagentEvent, SubagentInfo, SubagentTranscriptPage } from "../src/core/subagents/state.ts";
import { SubagentsView } from "../src/core/subagents/view.ts";
import { createUsageTotals } from "../src/core/usage-totals.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
});
afterEach(() => setKeybindings(previousKeys));

describe("subagent structured transcript view", () => {
	it("pages native tool output with a read-only header and closes without stopping the child", () => {
		const agent: SubagentInfo = {
			id: "12345678-1234-1234-1234-123456789abc",
			role: "worker",
			label: "Inspect evidence",
			status: "completed",
			model: "test/model",
			thinkingLevel: "off",
			tools: ["read"],
			createdAt: 0,
			updatedAt: 0,
			run: 1,
			async: false,
			originEntryId: null,
			preview: "",
			usage: createUsageTotals(),
		};
		const first: SubagentTranscriptPage = {
			cwd: process.cwd(),
			offset: 0,
			totalMessages: 3,
			nextOffset: 2,
			messages: [
				fauxAssistantMessage(
					{ type: "toolCall", id: "call", name: "read", arguments: { path: "evidence.txt" } },
					{ stopReason: "toolUse" },
				),
				{
					role: "toolResult",
					toolCallId: "call",
					toolName: "read",
					content: [{ type: "text", text: "Exact child evidence" }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		const second: SubagentTranscriptPage = {
			cwd: process.cwd(),
			offset: 2,
			totalMessages: 3,
			messages: [
				{
					role: "user",
					content: `Second-page question\n${Array.from({ length: 80 }, (_, i) => `history line ${i}`).join("\n")}`,
					timestamp: 3,
				},
			],
		};
		let listener: ((event: SubagentEvent) => void) | undefined;
		const unsubscribe = vi.fn();
		const rawHistory = vi.fn();
		const cancel = vi.fn();
		const transcript = vi.fn((_id: string, offset = 0) => (offset === 0 ? first : second));
		const manager = {
			list: () => [agent],
			inspect: () => agent,
			history: rawHistory,
			transcript,
			cancel,
			subscribe: (callback: (event: SubagentEvent) => void) => {
				listener = callback;
				return unsubscribe;
			},
		} as unknown as SubagentManager;
		const controls: PaneControls = {
			invalidate: vi.fn(),
			close: vi.fn(),
			minimize: async () => {},
			setTitle: async () => {},
		};
		const view = new SubagentsView(
			manager,
			controls,
			{ definitions: () => ({ agents: [], errors: [] }), start: async () => agent, resume: async () => agent },
			agent.id,
		);
		const render = () => view.render(100, 50).map(stripAnsi).join("\n");
		expect(render()).toContain("Read-only agent history");
		expect(render()).toContain("evidence.txt");
		expect(render()).not.toContain("Exact child evidence");
		view.handleInput("\x0f");
		expect(render()).toContain("Exact child evidence");
		view.handleInput("\x1b[6~");
		expect(transcript).toHaveBeenLastCalledWith(agent.id, 2);
		expect(render()).toContain("Second-page question");
		expect(render()).not.toContain("evidence.txt");
		const firstScreen = render();
		view.scrollBy(8);
		const scrolled = render();
		expect(scrolled).not.toContain("Second-page question");
		expect(scrolled).toContain("history line 12");
		view.handleInput("\x1b[B");
		expect(render()).not.toBe(scrolled);
		view.handleInput("\x1b[A");
		expect(render()).toBe(scrolled);
		listener?.({ id: agent.id, type: "message" });
		expect(render()).toBe(scrolled);
		expect(transcript).toHaveBeenLastCalledWith(agent.id, 2);
		view.handleInput("\x1b[5~");
		expect(render()).toBe(firstScreen);
		view.handleInput("\x1b[5~");
		expect(transcript).toHaveBeenLastCalledWith(agent.id, 0);
		expect(render()).toContain("Exact child evidence");
		view.handleInput("\x1b");
		expect(render()).toContain("configured roles");
		expect(render()).not.toContain("Sub-agents");
		view.handleInput("\x1b");
		expect(controls.close).toHaveBeenCalledOnce();
		expect(cancel).not.toHaveBeenCalled();
		expect(rawHistory).not.toHaveBeenCalled();
		view.dispose();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
