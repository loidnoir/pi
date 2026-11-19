/**
 * Presentation for the find tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `find.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Text } from "@earendil-works/pi-tui";
import { iconPrefix } from "../../../modes/interactive/icons.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolRenderers, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { FindToolDetails } from "../find.ts";
import { getTextOutput, invalidArgText, shortenPath, str, type ToolRenderResultLike } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";
import { renderListResult } from "./list-result.ts";

type FindRenderArgs = { pattern?: string; path?: string; limit?: number };

function formatFindCall(args: FindRenderArgs | undefined, theme: Theme): string {
	const pattern = str(args?.pattern ?? "**/*");
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold(`${iconPrefix("search")}find`)) +
		"  " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}
function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
) {
	const output = getTextOutput(result, showImages).trim();

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	const warnings: string[] = [];
	if (resultLimit) warnings.push(`${resultLimit} results limit`);
	if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
	return renderListResult(output, options.expanded ? Infinity : 20, warnings, theme, isError);
}

export const findRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatFindCall(args as FindRenderArgs | undefined, theme));
		return text;
	},
	renderResult(result, options, theme, context) {
		return formatFindResult(
			result as ToolRenderResultLike<FindToolDetails | undefined>,
			options,
			theme,
			context.showImages,
			context.isError,
		);
	},
};
