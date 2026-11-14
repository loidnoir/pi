// Main-chat message and tool presentation for auxiliary conversations, without tool execution.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { type Box, type Component, Container, Spacer, truncateToWidth } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "../../modes/interactive/components/assistant-message.ts";
import { BranchSummaryMessageComponent } from "../../modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../../modes/interactive/components/compaction-summary-message.ts";
import { CustomMessageComponent } from "../../modes/interactive/components/custom-message.ts";
import { ToolExecutionComponent } from "../../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../modes/interactive/components/user-message.ts";
import { getIconPreset } from "../../modes/interactive/icons.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { bashExecutionToText } from "../messages.ts";
import { withBuiltInRenderers } from "../tools/renderers/index.ts";

export interface ChatTranscriptOptions {
	cwd: string;
	invalidate(): void;
	hideThinkingBlock?: boolean;
}

interface ToolRow {
	component: ToolExecutionComponent;
	args: Record<string, unknown>;
	complete: boolean;
	result?: ToolResultMessage;
}
interface MessageRow {
	message: AgentMessage;
	component: Container | Box;
	assistant?: AssistantMessageComponent;
	user?: UserMessageComponent;
	tools: Map<string, ToolRow>;
}

/** Render an independently owned conversation with the same message components as the main chat. */
export class ChatTranscript implements Component {
	private readonly options: ChatTranscriptOptions;
	private readonly container = new Container();
	private rows: MessageRow[] = [];
	private expanded = false;
	private hideThinkingBlock: boolean;
	private disposed = false;
	private themeColors = theme.colors;
	private iconPreset = getIconPreset();

	constructor(options: ChatTranscriptOptions) {
		this.options = options;
		this.hideThinkingBlock = options.hideThinkingBlock ?? false;
	}

	/** Replace the visible page; a streaming assistant is optional and is not part of persisted messages. */
	setMessages(messages: readonly AgentMessage[], streamingAssistant?: AssistantMessage): void {
		if (this.disposed) return;
		const visible = streamingAssistant ? [...messages, streamingAssistant] : messages;
		const previous = this.rows;
		this.rows = [];
		this.container.clear();
		const tools = new Map<string, ToolRow>();
		for (const [index, message] of visible.entries()) {
			let row = previous[index];
			if (message.role === "toolResult" && tools.has(message.toolCallId)) {
				const tool = tools.get(message.toolCallId)!;
				this.updateResult(tool, message);
				// Keep indices aligned with the source page, including matched results.
				row = { message, component: new Container(), tools: new Map() };
			} else if (message.role === "assistant") {
				// An index or tool-call ID can recur in another page or chat; neither identifies a source turn.
				if (row?.message !== message) row = this.createRow(message);
				this.updateAssistant(row, message, message === streamingAssistant);
			} else if (!row || row.message !== message) {
				row = this.createRow(message);
			}
			for (const [id, tool] of row.tools) tools.set(id, tool);
			this.rows.push(row);
			this.container.addChild(row.component);
		}
	}

	render(width: number): string[] {
		if (width <= 0 || this.disposed) return [];
		if (this.themeColors !== theme.colors || this.iconPreset !== getIconPreset()) this.invalidate();
		const lines = this.container.render(width).map((line) => truncateToWidth(line, width));
		return lines.length ? [...lines, ""] : lines;
	}

	/** Expand tool output, images, and summaries together, as in the main chat. */
	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		for (const row of this.rows) {
			row.user?.setExpanded(expanded);
			if (
				row.component instanceof CustomMessageComponent ||
				row.component instanceof CompactionSummaryMessageComponent ||
				row.component instanceof BranchSummaryMessageComponent
			)
				row.component.setExpanded(expanded);
			for (const tool of row.tools.values()) tool.component.setExpanded(expanded);
		}
	}

	/** Toggle reasoning visibility without changing the side conversation's model state. */
	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		for (const row of this.rows) row.assistant?.setHideThinkingBlock(hide);
	}

	invalidate(): void {
		this.themeColors = theme.colors;
		this.iconPreset = getIconPreset();
		this.container.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.rows = [];
		this.container.clear();
	}

	private createRow(message: AgentMessage): MessageRow {
		const tools = new Map<string, ToolRow>();
		let component: Container | Box = new Container();
		let assistant: AssistantMessageComponent | undefined;
		let user: UserMessageComponent | undefined;
		switch (message.role) {
			case "user": {
				user = new UserMessageComponent(cleanContent(message.content), undefined, 1, [], undefined, undefined, {
					cwd: this.options.cwd,
				});
				user.setExpanded(this.expanded);
				component.addChild(new Spacer(1));
				component.addChild(user);
				break;
			}
			case "assistant": {
				const container = new Container();
				assistant = new AssistantMessageComponent(undefined, this.hideThinkingBlock);
				component = container;
				break;
			}
			case "toolResult": {
				// A bounded page can begin after the corresponding call; keep its result inspectable.
				const tool = this.createTool(message.toolName, message.toolCallId, {});
				this.updateResult(tool, message);
				tools.set(message.toolCallId, tool);
				component = tool.component;
				break;
			}
			case "custom":
				if (message.display) {
					const custom = new CustomMessageComponent({
						...message,
						customType: clean(message.customType),
						content: cleanContent(message.content),
					});
					custom.setExpanded(this.expanded);
					component = custom;
				}
				break;
			case "compactionSummary": {
				const summary = new CompactionSummaryMessageComponent({ ...message, summary: clean(message.summary) });
				summary.setExpanded(this.expanded);
				component = summary;
				break;
			}
			case "branchSummary": {
				const summary = new BranchSummaryMessageComponent({ ...message, summary: clean(message.summary) });
				summary.setExpanded(this.expanded);
				component = summary;
				break;
			}
			case "bashExecution":
				component = new UserMessageComponent(clean(bashExecutionToText(message)));
				break;
		}
		return { message, component, assistant, user, tools };
	}

	private updateAssistant(row: MessageRow, message: AssistantMessage, streaming: boolean): void {
		row.assistant!.updateContent(cleanAssistant(message), streaming);
		row.component.clear();
		row.component.addChild(row.assistant!);
		const previous = row.tools;
		row.tools = new Map();
		for (const call of message.content) {
			if (call.type !== "toolCall") continue;
			const tool = previous.get(call.id) ?? this.createTool(call.name, call.id, call.arguments);
			if (tool.args !== call.arguments) {
				tool.component.updateArgs(cleanArguments(call.arguments));
				tool.args = call.arguments;
			}
			if (!streaming && !tool.complete) {
				tool.complete = true;
				tool.component.setArgsComplete();
			}
			if (!tool.result && (message.stopReason === "aborted" || message.stopReason === "error"))
				tool.component.updateResult({
					content: [
						{
							type: "text",
							text: clean(
								message.errorMessage ?? (message.stopReason === "aborted" ? "Operation aborted" : "Error"),
							),
						},
					],
					isError: true,
				});
			row.tools.set(call.id, tool);
			row.component.addChild(tool.component);
		}
		row.message = message;
	}

	private createTool(name: string, id: string, args: Record<string, unknown>): ToolRow {
		const component = new ToolExecutionComponent(
			clean(name),
			id,
			cleanArguments(args),
			{},
			withBuiltInRenderers(name, undefined),
			{
				requestRender: () => {
					if (!this.disposed) this.options.invalidate();
				},
			},
			this.options.cwd,
		);
		component.setExpanded(this.expanded);
		return { component, args, complete: false };
	}

	private updateResult(tool: ToolRow, result: ToolResultMessage): void {
		if (tool.result === result) return;
		tool.result = result;
		tool.component.updateResult({
			...result,
			content: cleanContent(result.content),
			details: cleanToolValue(result.details),
		});
	}
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
}

function cleanContent(content: (TextContent | ImageContent)[]): (TextContent | ImageContent)[];
function cleanContent(content: string | (TextContent | ImageContent)[]): string | (TextContent | ImageContent)[];
function cleanContent(content: string | (TextContent | ImageContent)[]): string | (TextContent | ImageContent)[] {
	return typeof content === "string"
		? clean(content)
		: content.map((part) => (part.type === "text" ? { ...part, text: clean(part.text) } : part));
}

function cleanAssistant(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map((part) =>
			part.type === "text"
				? { ...part, text: clean(part.text) }
				: part.type === "thinking"
					? { ...part, thinking: clean(part.thinking) }
					: part,
		),
		errorMessage: message.errorMessage === undefined ? undefined : clean(message.errorMessage),
	};
}

function cleanArguments(args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(args).map(([key, value]) => [clean(key), cleanToolValue(value)]));
}

function cleanToolValue(value: unknown): unknown {
	// Tool arguments/details originate in model output or persisted JSON, not trusted terminal markup.
	if (typeof value === "string") return clean(value);
	if (Array.isArray(value)) return value.map(cleanToolValue);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), cleanToolValue(item)]));
	return value;
}
