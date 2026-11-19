import { type Component, TruncatedText, type TUI } from "@earendil-works/pi-tui";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	RetryStatusIndicator,
	type StatusIndicator,
	WorkingStatusIndicator,
} from "../../src/modes/interactive/components/status-indicator.ts";
import { ThemedText } from "../../src/modes/interactive/components/themed-text.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";

export function statusBlocks(tui: TUI): Array<[string, Component]> {
	const paused = new WorkingStatusIndicator(tui, "Working...");
	paused.setPauseStatus("paused");
	const indicators: Array<[string, StatusIndicator]> = [
		["Working (standalone)", new WorkingStatusIndicator(tui, "Working...")],
		["Paused (standalone)", paused],
		["Retry (standalone)", new RetryStatusIndicator(tui, 1, 3, 5000)],
		["Compacting (standalone)", new CompactionStatusIndicator(tui, "manual")],
		["Summarizing branch (standalone)", new BranchSummaryStatusIndicator(tui)],
	];
	for (const [, indicator] of indicators) indicator.dispose();
	return [
		...indicators,
		["Status notice", new ThemedText(() => theme.fg("dim", "Session name set: Gallery"), 1, 0)],
		["Warning notice", new ThemedText(() => theme.fg("warning", "Warning: sample warning"), 1, 0)],
		["Error notice", new ThemedText(() => theme.fg("error", "Error: sample failure"), 1, 0)],
		["Queued steering", new TruncatedText(theme.fg("dim", "Steering: show the smaller example first"), 1, 0)],
		["Queued follow-up", new TruncatedText(theme.fg("dim", "Follow-up: compare the expanded output"), 1, 0)],
	];
}
