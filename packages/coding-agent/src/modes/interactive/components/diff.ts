import { type Component, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { theme } from "../theme/theme.ts";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/s);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Separates common indentation before diffing so a leading insertion cannot consume it.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	let commonIndentLength = 0;
	while (
		commonIndentLength < oldContent.length &&
		oldContent[commonIndentLength] === newContent[commonIndentLength] &&
		/\s/.test(oldContent[commonIndentLength])
	) {
		commonIndentLength++;
	}

	const commonIndent = oldContent.slice(0, commonIndentLength);
	const oldText = oldContent.slice(commonIndentLength);
	const newText = newContent.slice(commonIndentLength);
	let wordDiff = Diff.diffWords(oldText, newText);
	if (
		wordDiff.map((part) => (part.added ? "" : part.value)).join("") !== oldText ||
		wordDiff.map((part) => (part.removed ? "" : part.value)).join("") !== newText
	) {
		wordDiff = Diff.diffWordsWithSpace(oldText, newText);
	}
	const renderSide = (content: string, side: "added" | "removed") => {
		const segments = graphemes.segment(content);
		let line = commonIndent;
		let offset = commonIndentLength;
		let firstChange = true;
		for (const part of wordDiff) {
			if (part[side]) {
				const value = firstChange ? part.value.trimStart() : part.value;
				firstChange = false;
				const end = offset + part.value.length;
				const start = end - value.length;
				line += content.slice(offset, start);
				line +=
					segments.containing(start)?.index === start &&
					(end === content.length || segments.containing(end)?.index === end)
						? theme.inverse(value)
						: value;
				offset = end;
			} else if (!part.added && !part.removed) {
				line += part.value;
				offset += part.value.length;
			}
		}
		return line;
	};
	return { removedLine: renderSide(oldContent, "removed"), addedLine: renderSide(newContent, "added") };
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines: string[] = [];
	for (const block of diffBlocks(diffText)) {
		if ("context" in block) lines.push(renderContext(block, 0));
		else {
			for (const line of block.removed) lines.push(line);
			for (const line of block.added) lines.push(line);
		}
	}
	return lines.join("\n");
}

type DiffBlock = { context: string; lineNum?: string } | { removed: string[]; added: string[] };

function renderContext(block: { context: string; lineNum?: string }, delta: number): string {
	if (block.lineNum === undefined) return theme.fg("toolDiffContext", block.context);
	const number =
		delta && block.lineNum.trim()
			? String(Number(block.lineNum) + delta).padStart(block.lineNum.length)
			: block.lineNum;
	return theme.fg("toolDiffContext", ` ${number} ${block.context}`);
}

function* diffBlocks(diffText: string): Generator<DiffBlock> {
	const lines = diffText.split("\n");
	let i = 0;
	while (i < lines.length) {
		const parsed = parseDiffLine(lines[i]);
		if (parsed?.prefix !== "-" && parsed?.prefix !== "+") {
			yield parsed
				? { context: replaceTabs(parsed.content), lineNum: parsed.lineNum }
				: { context: replaceTabs(lines[i]) };
			i++;
			continue;
		}
		const take = (prefix: string) => {
			const group = [];
			while (i < lines.length) {
				const line = parseDiffLine(lines[i]);
				if (line?.prefix !== prefix) break;
				group.push({ lineNum: line.lineNum, content: replaceTabs(line.content) });
				i++;
			}
			return group;
		};
		const removed = take("-");
		const added = take("+");
		if (removed.length === 1 && added.length === 1) {
			const pair = renderIntraLineDiff(removed[0].content, added[0].content);
			removed[0].content = pair.removedLine;
			added[0].content = pair.addedLine;
		}
		yield {
			removed: removed.map(({ lineNum, content }) => theme.fg("toolDiffRemoved", `-${lineNum} ${content}`)),
			added: added.map(({ lineNum, content }) => theme.fg("toolDiffAdded", `+${lineNum} ${content}`)),
		};
	}
}

function wrapDiffLine(line: string, width: number): string[] {
	const cells = visibleWidth(line);
	if (cells <= width) return [line];
	const wrapped = wrapTextWithAnsi(line, width);
	const widths = wrapped.map(visibleWidth);
	if (widths.every((length) => length <= width) && widths.reduce((sum, length) => sum + length, 0) === cells)
		return wrapped;
	const rows: string[] = [];
	const split = (text: string, length: number) => {
		if (length <= width) {
			rows.push(text);
			return;
		}
		const middle = Math.ceil(Math.floor(length / width) / 2) * width;
		const left = sliceByColumn(text, 0, middle, true);
		let cut = visibleWidth(left);
		if (cut) split(left, cut);
		else {
			const glyph = sliceByColumn(text, 0, 1);
			rows.push(truncateToWidth(glyph, width));
			cut = visibleWidth(glyph);
		}
		if (cut < length) split(sliceByColumn(text, cut, length - cut), length - cut);
	};
	split(line, cells);
	return rows;
}

function renderSideBySide(diffText: string, width: number): string[] {
	const divider = ` ${theme.fg("border", "│")} `;
	const leftWidth = Math.floor((width - 3) / 2);
	const rightWidth = width - 3 - leftWidth;
	const rows: string[] = [];
	const appendPair = (oldLine: string, newLine: string) => {
		const left = wrapDiffLine(oldLine, leftWidth);
		const right = wrapDiffLine(newLine, rightWidth);
		for (let i = 0; i < Math.max(left.length, right.length); i++) {
			const cell = left[i] ?? "";
			const padding = " ".repeat(leftWidth - visibleWidth(cell));
			rows.push(`${cell}\x1b[27;39m${padding}${divider}${right[i] ?? ""}\x1b[27;39m`);
		}
	};
	let delta = 0;
	for (const block of diffBlocks(diffText)) {
		if ("context" in block) {
			appendPair(renderContext(block, 0), renderContext(block, delta));
		} else {
			for (let i = 0; i < Math.max(block.removed.length, block.added.length); i++) {
				appendPair(block.removed[i] ?? "", block.added[i] ?? "");
			}
			delta += block.added.length - block.removed.length;
		}
	}
	return rows;
}

export class EditDiffComponent implements Component {
	private readonly diffText: string;
	private cache?: { width: number; rows: string[] };

	constructor(diffText: string) {
		this.diffText = diffText;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.rows;
		if (width <= 0) return [];
		const rows =
			width >= 80
				? renderSideBySide(this.diffText, width)
				: renderDiff(this.diffText)
						.split("\n")
						.flatMap((line) => {
							const parts = wrapDiffLine(line, width);
							return parts.length > 1 && line.includes("\x1b[7m")
								? parts.map((part) => `${part}\x1b[27m`)
								: parts;
						});
		this.cache = { width, rows };
		return rows;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}
