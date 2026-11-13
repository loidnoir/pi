import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { icon, setIconPreset } from "../src/modes/interactive/icons.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
		setIconPreset("unicode");
	});

	it("keeps idle status at the same height as standalone status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("keeps the top border unchanged unless the editor opts in", () => {
		initTheme("dark");
		const tui = {
			requestRender: vi.fn(),
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		const indicator = new WorkingStatusIndicator(tui, "Working");
		editor.setWorkingStatusIndicator(indicator);

		expect(stripAnsi(editor.render(20)[0]!)).toBe("─".repeat(20));
		const standaloneLine = indicator.render(20)[1]!;
		expect(standaloneLine).toContain(theme.getFgAnsi("accent"));
		expect(standaloneLine).toContain(theme.getFgAnsi("muted"));
		indicator.dispose();
	});

	it("embeds the working indicator when the editor opts in", () => {
		initTheme("dark");
		const tui = {
			requestRender: vi.fn(),
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		expect(editor.embedWorkingStatus).toBe(true);
		editor.borderColor = theme.getThinkingBorderColor("high");
		const indicator = new WorkingStatusIndicator(tui, "Working", undefined, (text) => editor.borderColor(text));
		editor.setWorkingStatusIndicator(indicator);

		const topBorder = editor.render(20)[0]!;
		expect(stripAnsi(topBorder)).toBe("── ⠋ Working ───────");
		expect(visibleWidth(topBorder)).toBe(20);
		expect(topBorder.split(theme.getFgAnsi("thinkingHigh"))).toHaveLength(5);
		indicator.dispose();
	});

	it("embeds compaction, summary, and retry labels within the border width", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		const indicators = [
			new CompactionStatusIndicator(tui, "manual"),
			new CompactionStatusIndicator(tui, "threshold"),
			new CompactionStatusIndicator(tui, "overflow"),
			new BranchSummaryStatusIndicator(tui),
			new RetryStatusIndicator(tui, 1, 3, 3000),
		];
		try {
			for (const indicator of indicators) {
				editor.setWorkingStatusIndicator(indicator);
				const label = stripAnsi(indicator.render(120)[1]!).trim();
				expect(stripAnsi(editor.render(120)[0]!)).toContain(`── ${label} `);
				for (const width of [1, 4, 10, 20, 80, 120]) {
					expect(visibleWidth(editor.render(width)[0]!)).toBe(width);
				}
			}
			vi.advanceTimersByTime(1000);
			expect(stripAnsi(editor.render(120)[0]!)).toContain("Retrying (1/3) in 2s");
			editor.setWorkingStatusIndicator(undefined);
			expect(stripAnsi(editor.render(120)[0]!)).toBe("─".repeat(120));
		} finally {
			for (const indicator of indicators) indicator.dispose();
		}
	});

	it.each(["unicode", "nerd"] as const)("renders static pause states with %s icons in both placements", (preset) => {
		initTheme("dark");
		setIconPreset(preset);
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender, terminal: { rows: 10 } } as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), { embedWorkingStatus: true });
		const indicator = new WorkingStatusIndicator(tui, "Working");
		editor.setWorkingStatusIndicator(indicator);
		try {
			for (const status of ["pausing", "paused"] as const) {
				indicator.setPauseStatus(status);
				const label = `${icon("pause")} ${status === "pausing" ? "Pausing…" : "Paused"}`;
				expect(stripAnsi(indicator.render(80)[1]!)).toContain(label);
				expect(stripAnsi(editor.render(80)[0]!)).toContain(label);
				expect(vi.getTimerCount()).toBe(0);
				requestRender.mockClear();
				vi.advanceTimersByTime(1000);
				expect(requestRender).not.toHaveBeenCalled();
				for (const width of [1, 2, 4, 10, 20, 80]) {
					expect(indicator.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
					expect(visibleWidth(editor.render(width)[0]!)).toBe(width);
				}
			}
			setIconPreset(preset === "nerd" ? "unicode" : "nerd");
			indicator.invalidate();
			expect(stripAnsi(indicator.render(80)[1]!)).toContain(`${icon("pause")} Paused`);
		} finally {
			indicator.dispose();
		}
	});

	it("restores custom messages and animation options, including options changed while held", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Custom work", { frames: ["a", "b"], intervalMs: 20 });
		try {
			indicator.setPauseStatus("paused");
			indicator.setMessage("Updated work");
			indicator.setIndicator({ frames: ["c", "d"], intervalMs: 30 });
			expect(vi.getTimerCount()).toBe(0);
			expect(stripAnsi(indicator.render(80)[1]!)).toContain("Paused");
			indicator.setPauseStatus(undefined);
			expect(stripAnsi(indicator.render(80)[1]!)).toContain("c Updated work");
			vi.advanceTimersByTime(30);
			expect(stripAnsi(indicator.render(80)[1]!)).toContain("d Updated work");
			expect(vi.getTimerCount()).toBe(1);
			indicator.setPauseStatus("paused");
			indicator.setIndicator({ frames: [] });
			indicator.setPauseStatus(undefined);
			expect(stripAnsi(indicator.render(80)[1]!).trim()).toBe("Updated work");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			indicator.dispose();
		}
	});

	it("restores compaction, summary, and retry labels after the pause presentation ends", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicators = [
			new CompactionStatusIndicator(tui, "manual"),
			new BranchSummaryStatusIndicator(tui),
			new RetryStatusIndicator(tui, 1, 3, 3000),
		];
		try {
			for (const indicator of indicators) {
				const before = stripAnsi(indicator.render(120)[1]!);
				indicator.setPauseStatus("paused");
				expect(stripAnsi(indicator.render(120)[1]!)).toContain(`${icon("pause")} Paused`);
				indicator.setPauseStatus(undefined);
				expect(stripAnsi(indicator.render(120)[1]!)).toBe(before);
			}
		} finally {
			for (const indicator of indicators) indicator.dispose();
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});
});
