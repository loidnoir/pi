// Decorates top-level reasoning headings without rewriting or splitting their Markdown source.
import { getCapabilities, Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Marked, type Token } from "marked";
import { stripAnsi } from "../../../utils/ansi.ts";
import { type IconName, iconPrefix } from "../icons.ts";
import { theme } from "../theme/theme.ts";

interface HeadingMetadata {
	icon: IconName;
	titles: string[];
}

const HEADING_MARKER = "\x1b]777;pi-thinking-heading;";
const HEADING_MARKER_REGEX = /\x1b\]777;pi-thinking-heading;([^\x07]*)\x07/g;
const HEADING_ICONS = ["thinking", "edit", "location", "search", "sparkles", "read", "clock"] as const;
const headingParser = new Marked();

/** Renders a complete thinking document with an icon beside each detected heading. */
export class ThinkingMarkdown extends Markdown {
	private outputPad: number;
	private headings: Map<string, HeadingMetadata>;

	constructor(
		text: string,
		outputPad: number,
		markdownTheme: MarkdownTheme,
		transform: (markdown: string, availableWidth: number) => string,
	) {
		const headingIds = new Map<string, string>();
		const headings = new Map<string, HeadingMetadata>();
		const markHeading = (text: string): string => {
			const headingId = headingIds.get(stripAnsi(text));
			return headingId === undefined ? text : `${HEADING_MARKER}${headingId}\x07${text}`;
		};
		super(
			text,
			0,
			0,
			{ ...markdownTheme, heading: (text) => markdownTheme.heading(markHeading(text)) },
			{ color: (text) => theme.fg("thinkingText", markHeading(text)), italic: true },
			{
				transform: (markdown, availableWidth) => {
					const transformed = transform(markdown, availableWidth);
					headingIds.clear();
					headings.clear();
					collectHeadings(transformed, headingIds, headings);
					return transformed;
				},
			},
		);
		this.outputPad = outputPad;
		this.headings = headings;
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const prefixWidth = Math.max(...HEADING_ICONS.map((name) => visibleWidth(iconPrefix(name))));
		const gutterWidth = Math.min(this.outputPad + prefixWidth, width - 1);
		const contentWidth = width - gutterWidth;
		const markedHeadings: (HeadingMetadata | undefined)[] = [];
		const lines = super.render(contentWidth).map((line, index) =>
			line.replace(HEADING_MARKER_REGEX, (_marker, id: string, offset: number) => {
				const prefix = stripAnsi(line.slice(0, offset).replace(HEADING_MARKER_REGEX, ""));
				// Nested blocks retain visible prefixes, except below three content columns where Markdown omits them.
				if (contentWidth >= 3 && /^(?:#{3,6} )?$/.test(prefix)) {
					markedHeadings[index] = this.headings.get(id);
				}
				return "";
			}),
		);
		let firstContent = true;
		return lines.map((line, index) => {
			const heading = markedHeadings[index];
			let headingIcon = heading?.titles.some((title) => matchesHeading(lines, index, title))
				? heading.icon
				: undefined;
			if (firstContent && stripAnsi(line).trim()) {
				headingIcon ??= "thinking";
				firstContent = false;
			}
			const prefix = headingIcon
				? `${" ".repeat(this.outputPad)}${iconPrefix(headingIcon)}`
				: " ".repeat(gutterWidth);
			const gutter = truncateToWidth(theme.fg("thinkingText", prefix), gutterWidth, "");
			return truncateToWidth(gutter + line, width, "");
		});
	}
}

function collectHeadings(markdown: string, ids: Map<string, string>, headings: Map<string, HeadingMetadata>): void {
	let mathDelimiter: string | undefined;
	for (const token of headingParser.lexer(markdown.replace(/\t/g, "   "))) {
		if (token.type !== "heading" && token.type !== "paragraph") continue;
		let hasBlockMath = mathDelimiter !== undefined;
		// The TUI also recognizes display math across blank paragraphs; the standard Markdown lexer does not.
		for (const delimiter of token.raw.match(/\$\$|\\\[|\\\]/g) ?? []) {
			hasBlockMath = true;
			if (delimiter === mathDelimiter) mathDelimiter = undefined;
			else if (!mathDelimiter && delimiter !== "\\]") mathDelimiter = delimiter === "\\[" ? "\\]" : delimiter;
		}
		const firstText = firstHeadingText(token.tokens ?? []);
		if (hasBlockMath || !firstText || token.text.includes("\n")) continue;
		const title = headingText(token.tokens ?? []);
		const headingIcon = reasoningHeadingIcon(firstText);
		const first = token.tokens?.[0];
		const emphasizedHeading = token.tokens?.length === 1 && (first?.type === "strong" || first?.type === "em");
		const prose = headingIcon && emphasizedHeading ? title.replace(/^[a-z]+:\s*/i, "") : title;
		// An emphasized action label may use a colon, but sentence-like paragraphs remain prose.
		if (token.type === "paragraph" && headingIcon !== "clock" && /[.!?;:](?:\s|$)/.test(prose)) continue;
		if (token.type === "paragraph" && !headingIcon && !/^[A-Z]/.test(firstText)) continue;
		// A source-derived key stays valid when Markdown reuses a block after earlier headings change.
		const id = Buffer.from(firstText).toString("base64url");
		ids.set(firstText, id);
		let heading = headings.get(id);
		if (!heading) {
			heading = { icon: headingIcon ?? "thinking", titles: [] };
			headings.set(id, heading);
		}
		const prefix = token.type === "heading" && token.depth >= 3 ? `${"#".repeat(token.depth)} ` : "";
		heading.titles.push(prefix + title);
	}
}

/** Selects an icon only for an action word at the beginning of a heading. */
export function reasoningHeadingIcon(text: string): IconName | undefined {
	const action = /^([a-z]+)(?=\s|$|[*_]+(?:\s|$)|[.!?:](?:\s|$)|\.{2,}(?:\s|$))/i
		.exec(text.trim())?.[1]
		?.toLowerCase();
	if (!action) return undefined;
	if (/^design(?:s|ed|ing)?$/.test(action)) return "edit";
	if (/^locat(?:e|es|ed|ing)$/.test(action)) return "location";
	if (/^review(?:s|ed|ing)?$/.test(action)) return "search";
	if (/^refin(?:e|es|ed|ing)$/.test(action)) return "sparkles";
	if (/^check(?:s|ed|ing)?$/.test(action)) return "read";
	if (/^(?:a?wait)(?:s|ed|ing)?$/.test(action)) return "clock";
	return undefined;
}

function firstHeadingText(tokens: readonly Token[]): string | undefined {
	const first = tokens[0];
	if (first?.type === "strong" || first?.type === "em") return firstHeadingText(first.tokens ?? []);
	return first?.type === "text" ? first.text : undefined;
}

function headingText(tokens: readonly Token[]): string {
	return tokens
		.map((token) => {
			if (token.type === "strong" || token.type === "em" || token.type === "del")
				return headingText(token.tokens ?? []);
			if (token.type === "link") {
				const text = headingText(token.tokens ?? []);
				const href = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
				return getCapabilities().hyperlinks || token.text === token.href || token.text === href
					? text
					: `${text} (${token.href})`;
			}
			return token.type === "text" || token.type === "codespan" || token.type === "escape" ? token.text : token.raw;
		})
		.join("");
}

function matchesHeading(lines: readonly string[], start: number, title: string): boolean {
	let remaining = title.trim();
	for (let index = start; index < lines.length; index++) {
		const line = stripAnsi(lines[index]).trim();
		if (!line || !remaining.startsWith(line)) return false;
		remaining = remaining.slice(line.length).trimStart();
		if (!remaining) {
			const next = stripAnsi(lines[index + 1] ?? "").trim();
			// A paragraph immediately followed by a list has no blank separator in the Markdown renderer.
			return !next || /^(?:[-+*]|\d+[.)])\s/.test(next);
		}
	}
	return false;
}
