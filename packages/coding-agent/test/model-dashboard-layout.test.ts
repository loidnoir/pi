import { getKeybindings, SelectList, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createModelDashboardOptions } from "../src/core/model-dashboard-controller.ts";
import { type ModelDashboardResolved, ModelDashboardView } from "../src/core/panes/model-dashboard.ts";
import { dashboardHeader, dashboardSettingRow, dashboardTargetRow } from "../src/core/panes/model-dashboard-layout.ts";
import { getIconPreset, iconPrefix, setIconPreset } from "../src/modes/interactive/icons.ts";
import { getSelectListTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness } from "./suite/harness.ts";
import { fauxModel } from "./test-harness.ts";

const preset = getIconPreset();
const target = { id: "main", label: "Default" };
const resolved: ModelDashboardResolved = {
	model: { ...fauxModel, compat: undefined, cost: { input: 0.125, output: 2, cacheRead: 0.0125, cacheWrite: 0 } },
	thinkingLevel: "low",
	fastMode: true,
};

beforeAll(() => initTheme("dark"));
afterEach(() => setIconPreset(preset));

describe("model dashboard layout", () => {
	it("keeps the overview to a blank line and selectable target summaries, even below 40 columns", () => {
		const list = new SelectList(
			[
				dashboardTargetRow(target, resolved, false),
				dashboardTargetRow({ id: "btw", label: "Btw" }, { ...resolved, model: undefined }, true),
			],
			2,
			getSelectListTheme(),
		);
		expect(dashboardHeader(undefined, undefined)).toEqual([""]);
		expect(list.render(120).map(stripAnsi)).toEqual([
			"→ ├─ Default · faux-1 [faux] · thinking low · fast inactive",
			"  └─ Btw · No model · thinking low · fast inactive",
		]);
		const narrow = list.render(32);
		expect(stripAnsi(narrow[0])).toContain("Default · faux-1");
		expect(narrow.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	it.each(["unicode", "nerd"] as const)("updates the %s scope icon on each Tab", async (preset) => {
		setIconPreset(preset);
		const previousBindings = getKeybindings();
		const harness = await createHarness();
		setKeybindings(new KeybindingsManager());
		const view = new ModelDashboardView(
			{ invalidate: vi.fn(), close: vi.fn(), minimize: vi.fn(), setTitle: vi.fn() },
			createModelDashboardOptions(harness.session, harness.settingsManager, harness.tempDir),
		);
		try {
			view.handleInput("\r");
			for (const [scope, glyph] of [
				["session", iconPrefix("chat")],
				["project", iconPrefix("folder")],
				["global", preset === "unicode" ? "\u{1f310} " : "\uf0ac "],
				["session", iconPrefix("chat")],
			]) {
				expect(view.render(40, 20).map(stripAnsi)).toContain(`→ ├─ ${glyph}Scope: ${scope}`);
				view.handleInput("\t");
			}
		} finally {
			await view.dispose();
			setKeybindings(previousBindings);
			harness.cleanup();
		}
	});

	it.each(["unicode", "nerd"] as const)(
		"renders the two detail trees with %s icons and colored chosen values",
		(preset) => {
			setIconPreset(preset);
			const rows = [
				dashboardSettingRow("scope", "Project", false),
				dashboardSettingRow("model", "faux/faux-1", false),
				dashboardSettingRow("thinkingLevel", "High", false),
				dashboardSettingRow("fastMode", "Off", true),
			];
			const list = new SelectList(rows, 4, getSelectListTheme());
			list.setSelectedIndex(2);
			const settings = list.render(40);
			expect([...dashboardHeader(target, resolved), ...settings].map(stripAnsi)).toEqual([
				"",
				`  ├─ ${iconPrefix("compact")}Context: 128,000 tokens`,
				`  ├─ ${iconPrefix("import")}Input: $0.125 / 1M tokens`,
				`  ├─ ${iconPrefix("export")}Output: $2 / 1M tokens`,
				`  ├─ ${iconPrefix("read")}Cache read: $0.0125 / 1M tokens`,
				`  └─ ${iconPrefix("write")}Cache write: $0 / 1M tokens`,
				"",
				`  ├─ ${iconPrefix("folder")}Scope: Project`,
				`  ├─ ${iconPrefix("model")}Model: faux/faux-1`,
				`→ ├─ ${iconPrefix("thinking")}Thinking: High`,
				`  └─ ${iconPrefix("fast")}Fast: Off`,
			]);
			expect(settings[2]).toContain(theme.fg("accent", "High"));
			expect(settings[3]).toContain(theme.fg("accent", "Off"));
			expect(list.getSelectedItem()?.value).toBe("thinkingLevel");
		},
	);
});
