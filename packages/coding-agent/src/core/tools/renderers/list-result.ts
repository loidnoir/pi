import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { fileIconPrefix } from "../../../modes/interactive/file-icons.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { replaceTabs } from "../render-utils.ts";

export function renderListResult(
	output: string,
	limit: number,
	warnings: string[],
	theme: Theme,
	isError: boolean,
	grepPath?: (line: string) => string | undefined,
): Component {
	const lines = output ? output.split("\n") : [];
	let inListing = true;
	let lastItem = -1;
	const rows = lines.slice(0, limit).map((line, index) => {
		if (!line) inListing = false;
		const path = isError ? undefined : grepPath ? grepPath(line) : inListing ? listingPath(line) : undefined;
		const icon = path && !/^[a-z][a-z\d+.-]*:\/\//i.test(path) ? fileIconPrefix(path) : undefined;
		if (icon !== undefined) lastItem = index;
		return { label: theme.fg("toolOutput", replaceTabs(line)), icon };
	});
	const remaining = lines.length - rows.length;
	const footer: string[] = [];
	if (remaining) {
		footer.push(
			`${theme.fg("muted", `... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
		);
	}
	if (warnings.length) footer.push(theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`));

	let cache: { width: number; lines: string[] } | undefined;
	return {
		invalidate() {
			cache = undefined;
		},
		render(width) {
			if (cache?.width === width) return cache.lines;
			if (width <= 0 || (!rows.length && !footer.length)) return [];
			const rendered = [""];
			for (const [index, { label, icon }] of rows.entries()) {
				const iconWidth = visibleWidth(icon ?? "");
				const marker = icon ? theme.fg("toolOutput", icon) : "";
				const labelWidth = width - 3 - iconWidth;
				const wrapped = icon !== undefined && labelWidth >= 2 ? wrapTextWithAnsi(label, labelWidth) : undefined;
				if (!wrapped || wrapped.some((line) => visibleWidth(line) > labelWidth)) {
					for (const line of wrapTextWithAnsi(marker + label, width)) rendered.push(truncateToWidth(line, width));
					continue;
				}
				const last = index === lastItem;
				const prefix = theme.fg("muted", last ? "└─ " : "├─ ") + marker;
				const indent = theme.fg("muted", last ? "   " : "│  ") + " ".repeat(iconWidth);
				for (const [part, line] of wrapped.entries())
					rendered.push(truncateToWidth((part ? indent : prefix) + line, width));
			}
			for (const text of footer) rendered.push(...wrapTextWithAnsi(text, width));
			cache = { width, lines: rendered };
			return rendered;
		},
	};
}

function listingPath(line: string): string | undefined {
	if (
		line === "(empty directory)" ||
		line === "No files found matching pattern" ||
		/^\[(?:Full (?:captured )?output:|Truncated:|Showing )/.test(line)
	)
		return undefined;
	return line;
}
