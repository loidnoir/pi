import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "../src/core/panes/chat-transcript.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { setIconPreset } from "../src/modes/interactive/icons.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeEach(() => initTheme("dark"));
afterEach(() => {
	setIconPreset("unicode");
	vi.restoreAllMocks();
});

const user: AgentMessage = { role: "user", content: "A **question** with 日本語", timestamp: 1 };
const result: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "read-1",
	toolName: "read",
	content: [{ type: "text", text: "Private tool evidence" }],
	isError: false,
	timestamp: 3,
};
function toolMessage(): AssistantMessage {
	return fauxAssistantMessage(
		[
			{ type: "thinking", thinking: "Inspect **evidence**" },
			{ type: "text", text: "Reading the file." },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.txt" } },
		],
		{ stopReason: "toolUse" },
	);
}

function text(transcript: ChatTranscript, width = 80): string {
	return transcript.render(width).map(stripAnsi).join("\n");
}

describe("auxiliary chat transcript", () => {
	it("uses native user, assistant and builtin tool components, matching results without duplicate headers", () => {
		const userRender = vi.spyOn(UserMessageComponent.prototype, "render");
		const assistantRender = vi.spyOn(AssistantMessageComponent.prototype, "render");
		const toolRender = vi.spyOn(ToolExecutionComponent.prototype, "render");
		const transcript = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn() });
		transcript.setMessages([user, toolMessage(), result, fauxAssistantMessage("The **answer**.")]);
		const collapsed = text(transcript);
		expect(userRender).toHaveBeenCalled();
		expect(assistantRender).toHaveBeenCalled();
		expect(toolRender).toHaveBeenCalled();
		expect(collapsed).toContain("question");
		expect(collapsed).toContain("evidence");
		expect(collapsed).toContain("answer");
		expect(collapsed.match(/notes\.txt/g)).toHaveLength(1);
		expect(collapsed).not.toContain("Private tool evidence");
		transcript.setExpanded(true);
		expect(text(transcript)).toContain("Private tool evidence");
		transcript.setExpanded(false);
		expect(text(transcript)).not.toContain("Private tool evidence");
		transcript.dispose();
	});

	it("separates user groups and the final answer while leaving native tool spacing unchanged", () => {
		const transcript = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn() });
		transcript.setMessages([
			fauxAssistantMessage("Previous answer"),
			user,
			toolMessage(),
			result,
			fauxAssistantMessage("Final answer"),
		]);
		const lines = transcript.render(100).map(stripAnsi);
		const previous = lines.findIndex((line) => line.includes("Previous answer"));
		const question = lines.findIndex((line) => line.includes("question"));
		const thinking = lines.findIndex((line) => line.includes("Inspect evidence"));
		const reading = lines.findIndex((line) => line.includes("Reading the file."));
		const tool = lines.findIndex((line) => line.includes("notes.txt"));
		expect(lines[previous + 1]).toBe("");
		expect(question).toBeGreaterThan(previous + 2);
		expect(thinking).toBeGreaterThan(question + 2);
		expect(lines.slice(question + 1, thinking).every((line) => !line.trim())).toBe(true);
		const native = [
			...new AssistantMessageComponent(toolMessage()).render(100),
			...new ToolExecutionComponent(
				"read",
				"read-1",
				{ path: "notes.txt" },
				{},
				withBuiltInRenderers("read", undefined),
				{ requestRender: () => {} },
				process.cwd(),
			).render(100),
		].map(stripAnsi);
		const nativeSpacing =
			native.findIndex((line) => line.includes("notes.txt")) -
			native.findIndex((line) => line.includes("Reading the file."));
		expect(tool - reading).toBe(nativeSpacing);
		expect(lines.at(-1)).toBe("");
		transcript.setHideThinkingBlock(true);
		expect(text(transcript)).not.toContain("Inspect evidence");
		transcript.setMessages([toolMessage()]);
		expect(text(transcript)).not.toContain("Inspect evidence");
		transcript.setHideThinkingBlock(false);
		expect(text(transcript)).toContain("Inspect evidence");
	});

	it("expands native user images even when the message is wrapped in group spacing", () => {
		const expanded = vi.spyOn(UserMessageComponent.prototype, "setExpanded");
		const transcript = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn() });
		transcript.setMessages([user]);
		transcript.setExpanded(true);
		expect(expanded).toHaveBeenLastCalledWith(true);
	});

	it("updates mutable streaming assistants and preserves their Markdown and tool rows through completion", () => {
		const transcript = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn() });
		const streaming = fauxAssistantMessage("Partial", { stopReason: "pending" });
		transcript.setMessages([user], streaming);
		expect(text(transcript)).toContain("Partial");
		streaming.content.push({ type: "toolCall", id: "read-1", name: "read", arguments: { path: "old.txt" } });
		transcript.setMessages([user], streaming);
		expect(text(transcript)).toContain("old.txt");
		streaming.content[1] = { type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.txt" } };
		transcript.setMessages([user], streaming);
		expect(text(transcript)).toContain("notes.txt");
		expect(text(transcript)).not.toContain("old.txt");
		streaming.stopReason = "toolUse";
		transcript.setMessages([user, streaming, result]);
		transcript.setExpanded(true);
		expect(text(transcript)).toContain("Private tool evidence");
		transcript.setMessages([user, streaming, result]);
		expect(text(transcript)).toContain("Private tool evidence");
	});

	it.each<{ name: string; args: Record<string, string> }>([
		{ name: "read", args: { path: "different.txt" } },
		{ name: "bash", args: { command: "echo new-command" } },
	])("does not reuse an unrelated $name turn's tool renderer or result at the same page index", ({ name, args }) => {
		const transcript = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn() });
		transcript.setExpanded(true);
		transcript.setMessages([toolMessage(), result]);
		expect(text(transcript)).toContain("Private tool evidence");
		const next = fauxAssistantMessage(
			{ type: "toolCall", id: result.toolCallId, name, arguments: args },
			{ stopReason: "toolUse" },
		);
		const fresh = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn() });
		fresh.setExpanded(true);
		transcript.setMessages([next]);
		fresh.setMessages([next]);
		expect(transcript.render(100)).toEqual(fresh.render(100));
		expect(text(transcript)).not.toContain("Private tool evidence");
		expect(text(transcript)).not.toContain("notes.txt");
		const nextResult: ToolResultMessage = {
			...result,
			toolName: name,
			content: [{ type: "text", text: "New turn evidence" }],
		};
		transcript.setMessages([next, nextResult]);
		fresh.setMessages([next, nextResult]);
		expect(transcript.render(100)).toEqual(fresh.render(100));
		expect(text(transcript)).toContain("New turn evidence");
		expect(text(transcript)).not.toContain("Private tool evidence");
	});

	it("renders a new persisted assistant snapshot correctly after its streaming snapshot", () => {
		const transcript = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn() });
		const streaming = fauxAssistantMessage(
			{ type: "toolCall", id: result.toolCallId, name: "read", arguments: { path: "notes.txt" } },
			{ stopReason: "pending" },
		);
		transcript.setMessages([user], streaming);
		expect(text(transcript)).toContain("notes.txt");
		const persisted: AssistantMessage = { ...streaming, stopReason: "toolUse" };
		transcript.setExpanded(true);
		transcript.setMessages([user, persisted, result]);
		const fresh = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn() });
		fresh.setExpanded(true);
		fresh.setMessages([user, persisted, result]);
		expect(transcript.render(100)).toEqual(fresh.render(100));
		expect(text(transcript)).toContain("Private tool evidence");
	});

	it("uses the native branch summary with sanitization and both initial and subsequent expansion", () => {
		const render = vi.spyOn(BranchSummaryMessageComponent.prototype, "render");
		const transcript = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn() });
		const message: AgentMessage = {
			role: "branchSummary",
			summary: "Branch **evidence**\x1b]52;c;INJECTED\x07\x1b[31m details\x1b[0m",
			fromId: "branch-source",
			timestamp: 1,
		};
		transcript.setMessages([message]);
		expect(text(transcript)).toContain("Branch summary (");
		expect(text(transcript)).not.toContain("evidence");
		expect(render).toHaveBeenCalled();
		transcript.setExpanded(true);
		expect(text(transcript)).toContain("Branch Summary");
		expect(text(transcript)).toContain("Branch evidence details");
		expect(transcript.render(100).join("\n")).not.toContain("INJECTED");
		expect(transcript.render(100).join("\n")).not.toContain("\x1b[31m");
		const initialExpanded = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn() });
		initialExpanded.setExpanded(true);
		initialExpanded.setMessages([message]);
		expect(transcript.render(100)).toEqual(initialExpanded.render(100));
		transcript.setExpanded(false);
		expect(text(transcript)).not.toContain("evidence");
	});

	it("sanitizes untrusted text, thinking, arguments, errors and details before native rendering without changing source messages", () => {
		const hostile = "\x1b]52;c;INJECTED\x07\x1b[31mvisible\x1b[0m\r";
		const transcript = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn() });
		const assistant = fauxAssistantMessage(
			[
				{ type: "thinking", thinking: hostile },
				{ type: "text", text: `**${hostile}**` },
				{ type: "toolCall", id: "custom", name: "unknown", arguments: { nested: { text: hostile } } },
			],
			{ stopReason: "toolUse" },
		);
		const messages: AgentMessage[] = [
			{ ...user, content: hostile },
			assistant,
			{
				...result,
				toolCallId: "custom",
				toolName: "unknown",
				content: [{ type: "text", text: hostile }],
				details: { text: hostile },
			},
			fauxAssistantMessage("", { stopReason: "error", errorMessage: hostile }),
		];
		const before = JSON.stringify(messages);
		transcript.setExpanded(true);
		transcript.setMessages(messages);
		const rendered = transcript.render(100).join("\n");
		expect(rendered).not.toContain("INJECTED");
		expect(rendered).not.toContain("\x1b[31m");
		expect(rendered).not.toContain("\r");
		expect(stripAnsi(rendered)).toContain("visible");
		expect(JSON.stringify(messages)).toBe(before);
	});

	it("keeps results visible when a page starts after its tool call, and drops previous-page content", () => {
		const transcript = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn() });
		transcript.setExpanded(true);
		transcript.setMessages([user]);
		transcript.setMessages([result]);
		expect(text(transcript)).toContain("Private tool evidence");
		expect(text(transcript)).not.toContain("question");
	});

	it("refreshes theme and icon caches, fits narrow resizes, hides system/context entries, and disposes without executing tools", () => {
		const transcript = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn(), hideThinkingBlock: true });
		const messages: AgentMessage[] = [
			{ role: "system", content: "PRIVATE SYSTEM", timestamp: 0 },
			{ role: "custom", customType: "subagent-context", content: "PRIVATE CONTEXT", display: false, timestamp: 0 },
			user,
			toolMessage(),
			result,
		];
		transcript.setMessages(messages);
		expect(text(transcript)).not.toContain("PRIVATE");
		expect(text(transcript)).not.toContain("Inspect evidence");
		const dark = transcript.render(80).join("\n");
		initTheme("light");
		const light = transcript.render(80).join("\n");
		expect(light).not.toBe(dark);
		const fresh = new ChatTranscript({ cwd: process.cwd(), invalidate: vi.fn(), hideThinkingBlock: true });
		fresh.setMessages(messages);
		expect(transcript.render(80)).toEqual(fresh.render(80));
		for (const preset of ["nerd", "unicode"] as const) {
			setIconPreset(preset);
			for (const width of [0, 1, 2, 8, 40, 100])
				for (const line of transcript.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		transcript.dispose();
		transcript.setMessages([user]);
		expect(transcript.render(80)).toEqual([]);
	});
});
