/**
 * Presentation for the grep tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `grep.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Text } from "@earendil-works/pi-tui";
import { iconPrefix } from "../../../modes/interactive/icons.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolRenderers, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { GrepToolDetails } from "../grep.ts";
import { getTextOutput, invalidArgText, shortenPath, str, type ToolRenderResultLike } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";
import { renderListResult } from "./list-result.ts";

type GrepRenderArgs = { pattern: string; path?: string; glob?: string; limit?: number; skip?: number };

function formatGrepCall(args: GrepRenderArgs | undefined, theme: Theme): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold(`${iconPrefix("search")}grep`)) +
		"  " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	if (args?.skip !== undefined) text += theme.fg("toolOutput", ` skip ${args.skip}`);
	return text;
}
function grepPath(line: string, files: readonly string[] | undefined): string | undefined {
	// Textual tool output is a parsing boundary. Prefer declared paths so colons or row-like text in a filename
	// cannot be confused with a line number; never inspect the matched source after the first row separator.
	if (files) {
		let path = "";
		for (const file of files) {
			if (
				file.length > path.length &&
				line.startsWith(file) &&
				/^([:-])\d+\1(?: |$)/.test(line.slice(file.length))
			) {
				path = file;
			}
		}
		return path || undefined;
	}
	// Older results and renderer overrides may lack file metadata. Only accept the tool's anchored row format.
	if (line.startsWith("[")) return undefined;
	return /^(.+?)([:-])\d+\2(?: |$)/.exec(line)?.[1];
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
) {
	const output = getTextOutput(result, showImages).trim();

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	const fileLimit = result.details?.fileLimitReached;
	const perFileLimit = result.details?.perFileLimitReached;
	const warnings: string[] = [];
	if (matchLimit) warnings.push(`${matchLimit} matches limit`);
	if (fileLimit) warnings.push(`${fileLimit} files per page`);
	if (perFileLimit) warnings.push(`${perFileLimit} matches per file`);
	if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
	if (linesTruncated) warnings.push("some lines truncated");
	return renderListResult(output, options.expanded ? Infinity : 15, warnings, theme, isError, (line) =>
		grepPath(line, result.details?.files),
	);
}

export const grepRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatGrepCall(args as GrepRenderArgs | undefined, theme));
		return text;
	},
	renderResult(result, options, theme, context) {
		return formatGrepResult(
			result as ToolRenderResultLike<GrepToolDetails | undefined>,
			options,
			theme,
			context.showImages,
			context.isError,
		);
	},
};
