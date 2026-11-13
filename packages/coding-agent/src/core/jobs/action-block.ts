// Compact, expandable text blocks shared by native job and sub-agent renderers.
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ThemeColor } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { ToolRenderContext } from "../extensions/types.ts";

export interface ActionBlockContent {
	heading: string;
	preview?: string;
	expandedText?: string;
	hint?: string;
}

/** Resolve themed labels and icons on render, keeping collapsed previews within two terminal lines. */
export class ActionBlock extends Text {
	private content: () => ActionBlockContent;
	private outputPad: number;

	constructor(content: () => ActionBlockContent, outputPad = 0, background?: (text: string) => string) {
		super("", outputPad, 0, background);
		this.content = content;
		this.outputPad = outputPad;
	}

	update(content: () => ActionBlockContent): void {
		this.content = content;
		this.invalidate();
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const { heading, preview, expandedText, hint } = this.content();
		const title = heading.replace(/[\r\n\t]/gu, " ");
		const padding = Math.min(this.outputPad, Math.max(0, Math.floor((width - 1) / 2)));
		const available = Math.max(1, width - padding * 2);
		if (expandedText !== undefined) {
			this.setText(`${title}\n${expandedText}`);
		} else {
			const lines = [truncateToWidth(title, available)];
			if (preview) {
				const wrapped = wrapTextWithAnsi(preview, available);
				lines.push(...wrapped.slice(0, 2));
				if (wrapped.length > 2) lines[lines.length - 1] = truncateToWidth(`${wrapped[1]}…`, available);
			}
			if (hint) lines.push(truncateToWidth(hint, available));
			this.setText(lines.join("\n"));
		}
		// A wide glyph cannot fit in a one-column content area, even after Text wraps it.
		return super.render(width).map((line) => truncateToWidth(line, width));
	}
}

/** Reuse the component owned by a native tool's call or result slot. */
export function actionBlock(
	context: Pick<ToolRenderContext<unknown, unknown>, "lastComponent">,
	content: () => ActionBlockContent,
): ActionBlock {
	// Native renderers always return ActionBlock for each of their slots.
	const previous = context.lastComponent as ActionBlock | undefined;
	if (previous) {
		previous.update(content);
		return previous;
	}
	return new ActionBlock(content);
}

/** Bound and sanitize untrusted output before laying out its collapsed preview. */
export function compactPreview(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text.slice(0, 600))).trim();
}

/** Extract the original model-visible text without rewriting the result. */
export function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

/** Reveal the original tool text and retained details without changing either payload. */
export function expandedResultText(result: AgentToolResult<unknown>): string {
	const raw = resultText(result);
	const details = JSON.stringify(result.details, null, 2);
	const structured = JSON.stringify(result.structuredContent, null, 2);
	return (
		(raw || "(no output)") +
		(details && details !== "{}" ? `\n\nDetails:\n${details}` : "") +
		(structured && structured !== raw ? `\n\nStructured content:\n${structured}` : "")
	);
}

/** Keep failed, uncertain and active states distinct from successful completion. */
export function stateColor(state: string): ThemeColor {
	if (state === "completed" || state === "deleted") return "success";
	if (state === "failed" || state === "lost" || state === "interrupted" || state === "timed_out") return "error";
	if (state === "running" || state === "starting" || state === "queued") return "accent";
	return "warning";
}

/** Format a state label without inventing a successful outcome. */
export function stateLabel(state: string): string {
	const label = state.replaceAll("_", " ");
	return label ? label[0].toUpperCase() + label.slice(1) : "Unknown state";
}
