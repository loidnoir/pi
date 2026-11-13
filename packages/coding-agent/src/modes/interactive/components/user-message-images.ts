// Find display-only image file references without reading files or changing their source spelling.
import { basename, posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, hyperlink, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { Lexer, type Token } from "marked";
import { normalizePath } from "../../../utils/paths.ts";

export interface UserMessageImageReference {
	readonly start: number;
	readonly end: number;
	readonly path: string;
	readonly label: string;
	readonly url: string;
}

/** Locate image paths in prose, leaving Markdown code, links, and non-image references alone. */
export function getUserMessageImageReferences(source: string, cwd = process.cwd()): UserMessageImageReference[] {
	// Marked normalizes line endings. Keep offsets into the original source for display-only substitutions.
	const normalized = source.replace(/\r\n?/g, "\n");
	const removed = [...source.matchAll(/\r\n/g)].map((match, index) => match.index - index);
	const originalOffset = (offset: number) => offset + removed.filter((position) => position < offset).length;
	const spans: Array<{ start: number; end: number }> = [];
	collectTextSpans(normalized, Lexer.lex(normalized), 0, spans);
	const references: UserMessageImageReference[] = [];
	for (const span of spans) {
		for (const line of normalized.slice(span.start, span.end).matchAll(/[^\n]+/g)) {
			const previousCount = references.length;
			// Only explicit local paths qualify. Quoted and shell-escaped drag paths may contain spaces.
			for (const match of line[0].matchAll(
				/(?:^|(?<=[\s(]))(?:"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|(?:\\[^\r\n]|[^\s"'`<>])+)/g,
			)) {
				const raw = match[0].replace(/[),.;!?]+$/, "");
				const start = span.start + line.index + match.index;
				const reference = imageReference(
					decodePath(raw),
					originalOffset(start),
					originalOffset(start + raw.length),
					cwd,
				);
				if (reference) references.push(reference);
			}
			// Clipboard file lists also use unescaped, whole-line paths. Do not infer where an unquoted path
			// with spaces ends inside prose, or swallow multiple paths into a single filename.
			const raw = line[0].trim();
			if (references.length === previousCount && /\s/.test(raw) && !/\s(?:\/|~\/|\.{1,2}\/|file:\/\/)/i.test(raw)) {
				const start = span.start + line.index + line[0].indexOf(raw);
				const reference = imageReference(raw, originalOffset(start), originalOffset(start + raw.length), cwd);
				if (reference) references.push(reference);
			}
		}
	}
	return references;
}

/** Replace only recognized path ranges with compact, openable labels; retain the original text separately. */
export function collapseUserMessageImages(
	source: string,
	references: readonly UserMessageImageReference[],
	firstImageNumber: number,
): string {
	let result = "";
	let end = 0;
	for (const [index, reference] of references.entries()) {
		const label = `[image #${firstImageNumber + index} ${reference.label}]`;
		// A code span protects filename punctuation and the OSC 8 target from Markdown parsing.
		const display = getCapabilities().hyperlinks ? hyperlink(label, reference.url) : label;
		result += `${source.slice(end, reference.start)}\`${display}\``;
		end = reference.end;
	}
	return result + source.slice(end);
}

function imageReference(value: string, start: number, end: number, cwd: string): UserMessageImageReference | undefined {
	if (!/^(?:\/|~\/|\.{1,2}\/|[a-z]:[\\/]|\\\\|file:\/\/)/i.test(value) || /\p{Cc}/u.test(value)) return undefined;
	try {
		const path = normalizePath(value.replace(/^file:\/\//i, "file://"));
		if (!/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(path)) return undefined;
		const windows = process.platform === "win32" || /^(?:[a-z]:[\\/]|\\\\)/i.test(path);
		const name = windows ? win32.basename(path) : basename(path);
		const label = /^pi-clipboard-[a-f\d-]+\./i.test(name)
			? "clipboard"
			: truncateToWidth(stripTerminalSequences(name).replace(/[\p{Cc}[\]`]/gu, " "), 24);
		const pathApi = windows ? win32 : posix;
		const target = pathApi.isAbsolute(path) ? path : pathApi.resolve(cwd, path);
		return { start, end, path, label, url: pathToFileURL(target, { windows }).href };
	} catch {
		// Malformed file URLs are untrusted message text, not references.
		return undefined;
	}
}

function collectTextSpans(
	source: string,
	tokens: readonly Token[],
	base: number,
	spans: Array<{ start: number; end: number }>,
): void {
	let offset = 0;
	for (const token of tokens) {
		const start = source.indexOf(token.raw, offset);
		// Nested Markdown may strip quote/list indentation. Never guess a source range in that case.
		if (start < 0) continue;
		offset = start + token.raw.length;
		// Retina filenames such as 23.07.32@2x.png can be auto-tokenized as email links inside a path.
		// Bare autolinks remain safe here: only whole tokens starting with a local path can collapse.
		if (
			(token.type === "text" && !token.tokens?.length) ||
			token.type === "escape" ||
			(token.type === "link" && token.raw === token.text)
		) {
			const previous = spans.at(-1);
			if (previous?.end === base + start) previous.end = base + offset;
			else spans.push({ start: base + start, end: base + offset });
		} else if (token.type === "list") {
			collectTextSpans(token.raw, token.items, base + start, spans);
		} else if (
			token.type === "paragraph" ||
			token.type === "heading" ||
			token.type === "strong" ||
			token.type === "em" ||
			token.type === "del" ||
			token.type === "text" ||
			token.type === "list_item" ||
			token.type === "blockquote"
		) {
			collectTextSpans(token.raw, token.tokens ?? [], base + start, spans);
		}
	}
}

function decodePath(raw: string): string {
	let result = "";
	const windows = /^["']?(?:[a-z]:[\\/]|\\\\)/i.test(raw);
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < raw.length; index++) {
		const char = raw[index]!;
		if (char === quote) quote = undefined;
		else if (!quote && (char === "'" || char === '"')) quote = char;
		else if (char === "\\" && quote !== "'" && !windows && process.platform !== "win32") {
			const next = raw[index + 1];
			if (next !== undefined && (quote !== '"' || /[\\$"`]/.test(next))) {
				result += next;
				index++;
			} else result += char;
		} else result += char;
	}
	return quote ? "" : result;
}
