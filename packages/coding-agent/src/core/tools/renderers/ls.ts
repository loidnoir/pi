/**
 * Presentation for the ls tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `ls.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Text } from "@earendil-works/pi-tui";
import { iconPrefix } from "../../../modes/interactive/icons.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolRenderers, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { LsToolDetails } from "../ls.ts";
import { getTextOutput, renderToolPath, str, type ToolRenderResultLike } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";
import { renderListResult } from "./list-result.ts";

type LsRenderArgs = { path?: string; limit?: number };

function formatLsCall(args: LsRenderArgs | undefined, theme: Theme, cwd: string): string {
	const limit = args?.limit;
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd, { emptyFallback: ".", kind: "directory" });
	let text = `${theme.fg("toolTitle", theme.bold(`${iconPrefix("folder")}ls`))}  ${pathDisplay}`;
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}
function formatLsResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: LsToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
) {
	const output = getTextOutput(result, showImages).trim();

	const entryLimit = result.details?.entryLimitReached;
	const truncation = result.details?.truncation;
	const warnings: string[] = [];
	if (entryLimit) warnings.push(`${entryLimit} entries limit`);
	if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
	return renderListResult(output, options.expanded ? Infinity : 20, warnings, theme, isError);
}

export const lsRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatLsCall(args as LsRenderArgs | undefined, theme, context.cwd));
		return text;
	},
	renderResult(result, options, theme, context) {
		return formatLsResult(
			result as ToolRenderResultLike<LsToolDetails | undefined>,
			options,
			theme,
			context.showImages,
			context.isError,
		);
	},
};
