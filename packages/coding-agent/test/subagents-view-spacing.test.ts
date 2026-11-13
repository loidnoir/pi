import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PaneControls } from "../src/core/panes/host.ts";
import type { SubagentManager } from "../src/core/subagents/manager.ts";
import type { SubagentInfo } from "../src/core/subagents/state.ts";
import { SubagentsView } from "../src/core/subagents/view.ts";
import { createUsageTotals } from "../src/core/usage-totals.ts";
import { icon, iconPrefix, setIconPreset } from "../src/modes/interactive/icons.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
});
afterEach(() => {
	setKeybindings(previousKeys);
	setIconPreset("unicode");
});

describe("sub-agent icon-label spacing", () => {
	it("measures live role/status prefixes instead of assuming fixed glyph widths", () => {
		const agent: SubagentInfo = {
			id: "12345678-1234-1234-1234-123456789abc",
			role: "worker",
			label: "日本語 renderer investigation",
			status: "running",
			model: "test/model",
			thinkingLevel: "off",
			tools: [],
			createdAt: 0,
			updatedAt: 0,
			run: 1,
			async: true,
			originEntryId: null,
			preview: "",
			usage: createUsageTotals(),
		};
		// A presentation-only adapter: no child processes, model calls, or history I/O.
		const manager = {
			list: () => [agent],
			subscribe: () => () => {},
			history: () => ({ text: "", offset: 0, totalCharacters: 0 }),
		} as unknown as SubagentManager;
		const controls: PaneControls = {
			invalidate: vi.fn(),
			close: vi.fn(),
			minimize: async () => {},
			setTitle: async () => {},
		};
		const view = new SubagentsView(manager, controls, {
			definitions: () => ({
				agents: [{ name: "worker", description: "Implement tasks", systemPrompt: "", source: "builtin" }],
				errors: [],
			}),
			start: async () => agent,
			resume: async () => agent,
		});
		try {
			for (const preset of ["unicode", "nerd", "unicode"] as const) {
				setIconPreset(preset);
				const listing = view.render(100, 24).map(stripAnsi).join("\n");
				expect(listing).toContain(`${icon("statusDot")}  ${iconPrefix("agentWorker")}worker`);
				view.handleInput("\r");
				const prefix = `${icon("statusDot")}  ${iconPrefix("agentWorker")}`;
				expect(stripAnsi(view.render(100, 24)[0])).toBe(prefix + agent.label);
				for (const width of [0, 1, 2, 4, 10, 20, 100])
					expect(visibleWidth(view.render(width, 24)[0])).toBeLessThanOrEqual(width);
				view.handleInput("\x1b");
				view.handleInput("\x0e");
				expect(view.render(100, 24).map(stripAnsi).join("\n")).toContain(
					`> ${iconPrefix("agentWorker")}worker [builtin] — Implement tasks`,
				);
				view.handleInput("\x1b");
			}
		} finally {
			view.dispose();
		}
	});
});
