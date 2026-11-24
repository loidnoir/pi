import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
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

const agent: SubagentInfo = {
	id: "12345678-1234-1234-1234-123456789abc",
	role: "worker",
	label: "Inspect evidence",
	status: "running",
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
	historyPath: "/agents/history/session.jsonl",
};

function setup(pages: { first: SubagentTranscriptPage; last: SubagentTranscriptPage }, id?: string) {
	let listener: ((event: SubagentEvent) => void) | undefined;
	const unsubscribe = vi.fn();
	const rawHistory = vi.fn();
	const cancel = vi.fn();
	const transcript = vi.fn((_id: string, offset: number | "end", _limit: number) =>
		offset === 0 ? pages.first : pages.last,
	);
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
		id,
	);
	return {
		view,
		controls,
		transcript,
		cancel,
		rawHistory,
		unsubscribe,
		emit: () => listener?.({ id: agent.id, type: "message" }),
	};
}

function page(fields: Pick<SubagentTranscriptPage, "offset" | "messages" | "nextOffset">): SubagentTranscriptPage {
	return {
		cwd: "/work/\x1b[2Jproject",
		totalMessages: 3,
		usage: { ...createUsageTotals(), input: 12_345, output: 678 },
		contextUsage: { tokens: 24_600, contextWindow: 200_000, percent: 12.3 },
		...fields,
	};
}

describe("subagent structured transcript view", () => {
	it("opens on the newest messages, follows them until scrolled away, and pages back through history", () => {
		const first = page({
			offset: 0,
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
		});
		const last = page({
			offset: 2,
			messages: [
				{
					role: "user",
					content: `Second-page question\n${Array.from({ length: 80 }, (_, i) => `history line ${i}`).join("\n")}`,
					timestamp: 3,
				},
			],
		});
		const { view, controls, transcript, cancel, rawHistory, unsubscribe, emit } = setup({ first, last }, agent.id);
		const render = () => view.render(100, 50).map(stripAnsi).join("\n");
		const arrive = (text: string) => {
			last.messages = [...last.messages, fauxAssistantMessage(text)];
			emit();
		};

		expect(transcript).toHaveBeenLastCalledWith(agent.id, "end", 100);
		expect(render()).toContain("Read-only agent history");
		expect(render()).toContain("history line 79");
		expect(render()).not.toContain("Second-page question");

		arrive("Newest child output");
		expect(transcript).toHaveBeenLastCalledWith(agent.id, "end", 100);
		expect(render()).toContain("Newest child output");

		view.scrollBy(-8);
		const scrolled = render();
		expect(scrolled).not.toContain("Newest child output");
		arrive("Output while reading older lines");
		expect(transcript).toHaveBeenLastCalledWith(agent.id, 2, 100);
		expect(render()).toBe(scrolled);
		view.handleInput("\x1b[B");
		expect(render()).not.toBe(scrolled);
		view.handleInput("\x1b[A");
		expect(render()).toBe(scrolled);

		view.scrollBy(1000);
		expect(render()).toContain("Output while reading older lines");
		arrive("Output after returning to the end");
		expect(transcript).toHaveBeenLastCalledWith(agent.id, "end", 100);
		expect(render()).toContain("Output after returning to the end");

		view.scrollBy(-1000);
		expect(render()).toContain("Second-page question");
		view.scrollBy(-1);
		expect(transcript).toHaveBeenLastCalledWith(agent.id, 0, 2);
		expect(render()).toContain("evidence.txt");
		expect(render()).not.toContain("Second-page question");
		expect(render()).not.toContain("Exact child evidence");
		view.handleInput("\x0f");
		expect(render()).toContain("Exact child evidence");
		const reading = render();
		first.usage = { ...first.usage, output: 9_000 };
		arrive("Output while reading the first page");
		expect(transcript).toHaveBeenLastCalledWith(agent.id, 0, 2);
		expect(render()).toBe(reading.replace("↓678 ", "↓9.0k"));

		view.handleInput("\x1b[6~");
		expect(transcript).toHaveBeenLastCalledWith(agent.id, 2, 100);
		expect(render()).toContain("Second-page question");
		expect(render()).not.toContain("evidence.txt");

		view.handleInput("\x1b");
		expect(render()).toContain("configured roles");
		expect(render()).toMatch(/ new · .* view\/select · .*\n.* stop · .* back\/close$/);
		expect(render()).not.toContain("Sub-agents");
		view.handleInput("\r");
		expect(transcript).toHaveBeenLastCalledWith(agent.id, "end", 100);
		expect(render()).toContain("Output while reading the first page");
		view.handleInput("\x1b");
		view.handleInput("\x1b");
		expect(controls.close).toHaveBeenCalledOnce();
		expect(cancel).not.toHaveBeenCalled();
		expect(rawHistory).not.toHaveBeenCalled();
		view.dispose();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("ends with one main-style footer line that stays below short histories and the message prompt", () => {
		const only = page({ offset: 0, messages: [{ role: "user", content: "Short task", timestamp: 1 }] });
		const { view } = setup({ first: only, last: only }, agent.id);
		const render = (width = 100) => view.render(width, 20).map(stripAnsi);
		try {
			const lines = render();
			expect(lines).toHaveLength(20);
			expect(lines[2]).toBe("running · worker · run 1");
			expect(lines.at(-1)).toMatch(/^\/work\/project ↑12k ↓678 {2,}12\.3%\/200k • \(test\) model • thinking off$/);
			expect(visibleWidth(lines.at(-1)!)).toBe(100);
			expect(view.render(100, 20).at(-1)).not.toContain("\x1b[2J");
			expect(view.render(100, 4).map(stripAnsi)).toEqual([...lines.slice(0, 3), lines.at(-1)]);
			expect(lines.join("\n")).not.toMatch(/Messages \d|ctrl\+|pageUp|session\.jsonl/);
			expect(render(60).at(-1)).toMatch(/^\/work\/project ↑12k ↓678 {2,}12\.3%\/200k • model • thinking off$/);
			for (const width of [0, 1, 8, 40]) {
				for (const line of view.render(width, 20)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}

			view.handleInput("\x05");
			const editing = render();
			expect(editing).toHaveLength(20);
			expect(editing.at(-3)).toBe("Message to child:");
			expect(editing.at(-1)).toBe(lines.at(-1));
			expect(editing.join("\n")).toContain("Short task");
		} finally {
			view.dispose();
		}
	});
});
