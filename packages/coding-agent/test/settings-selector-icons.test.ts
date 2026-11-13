import {
	fuzzyFilter,
	getCapabilities,
	setCapabilities,
	setKeybindings,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { getIconPreset, type IconName, icon, setIconPreset } from "../src/modes/interactive/icons.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const MAIN_ROWS: ReadonlyArray<{ id: string; label: string; icon: IconName; value: string }> = [
	{ id: "autocompact", label: "Auto-compact", icon: "compact", value: "true" },
	{ id: "show-images", label: "Show images", icon: "read", value: "true" },
	{ id: "image-width-cells", label: "Image width", icon: "read", value: "60" },
	{ id: "auto-resize-images", label: "Auto-resize images", icon: "compact", value: "true" },
	{ id: "block-images", label: "Block images", icon: "trust", value: "false" },
	{ id: "skill-commands", label: "Skill commands", icon: "skill", value: "true" },
	{ id: "show-hardware-cursor", label: "Show hardware cursor", icon: "terminal", value: "false" },
	{ id: "editor-padding", label: "Editor padding", icon: "edit", value: "0" },
	{ id: "output-padding", label: "Output padding", icon: "terminal", value: "1" },
	{ id: "autocomplete-max-visible", label: "Autocomplete max items", icon: "search", value: "5" },
	{ id: "clear-on-shrink", label: "Clear on shrink", icon: "terminal", value: "false" },
	{ id: "terminal-progress", label: "Terminal progress", icon: "terminal", value: "false" },
	{ id: "steering-mode", label: "Steering mode", icon: "chat", value: "one-at-a-time" },
	{ id: "follow-up-mode", label: "Follow-up mode", icon: "chat", value: "one-at-a-time" },
	{ id: "transport", label: "Transport", icon: "share", value: "auto" },
	{ id: "share-destination", label: "Session share destination", icon: "share", value: "auto" },
	{ id: "http-idle-timeout", label: "HTTP idle timeout", icon: "clock", value: "5 min" },
	{ id: "cache-warming-mode", label: "Cache warming", icon: "fast", value: "streaming" },
	{ id: "hide-thinking", label: "Hide thinking", icon: "thinking", value: "false" },
	{ id: "mermaid-rendering", label: "Mermaid diagrams", icon: "code", value: "streaming" },
	{ id: "cache-miss-notices", label: "Cache miss notices", icon: "info", value: "false" },
	{ id: "collapse-changelog", label: "Collapse changelog", icon: "history", value: "false" },
	{ id: "quiet-startup", label: "Quiet startup", icon: "terminal", value: "false" },
	{ id: "install-telemetry", label: "Install telemetry", icon: "info", value: "true" },
	{ id: "default-project-trust", label: "Default project trust", icon: "trust", value: "Ask" },
	{ id: "double-escape-action", label: "Double-escape action", icon: "keyboard", value: "tree" },
	{ id: "tree-filter-mode", label: "Tree filter mode", icon: "tree", value: "default" },
	{ id: "warnings", label: "Warnings", icon: "bug", value: "configure" },
	{ id: "model-thinking", label: "Default thinking level per model", icon: "thinking", value: "none" },
	{ id: "tui-mode", label: "TUI mode", icon: "terminal", value: "fullscreen" },
	{ id: "fullscreen-exit-output", label: "Fullscreen exit output", icon: "export", value: "transcript" },
	{ id: "fullscreen-scrollbar", label: "Fullscreen scrollbar", icon: "terminal", value: "auto" },
	{ id: "fullscreen-copy-on-select", label: "Fullscreen copy on select", icon: "copy", value: "true" },
	{ id: "fullscreen-wheel-scroll-lines", label: "Fullscreen wheel scrolling", icon: "terminal", value: "7" },
	{ id: "theme", label: "Theme", icon: "settings", value: "light/dark" },
	{ id: "icon-preset", label: "Icons", icon: "settings", value: "unicode" },
	{ id: "rex-enabled", label: "Rex views", icon: "terminal", value: "on" },
	{ id: "rex-mode", label: "Rex mode", icon: "terminal", value: "floating" },
	{ id: "minimized-rex-jobs", label: "Minimized Rex jobs", icon: "job", value: "on" },
];

function createConfig(): SettingsConfig {
	return {
		autoCompact: true,
		defaultModel: "not set",
		availableDefaultModels: [],
		showImages: true,
		imageWidthCells: 60,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		sessionShareDestination: "auto",
		httpIdleTimeoutMs: 300000,
		cacheWarmingMode: "streaming",
		thinkingLevel: "high",
		availableThinkingLevels: ["off", "high"],
		modelThinkingLevels: {},
		currentTheme: "light/dark",
		terminalTheme: "dark",
		availableThemes: ["system", "dark", "light"],
		iconPreset: "unicode",
		rex: { enabled: true, mode: "floating", minimizedJobs: true },
		hideThinkingBlock: false,
		mermaidRenderingMode: "streaming",
		showCacheMissNotices: false,
		collapseChangelog: false,
		enableInstallTelemetry: true,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 0,
		outputPad: 1,
		autocompleteMaxVisible: 5,
		quietStartup: false,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: false,
		tuiMode: "fullscreen",
		fullscreenExitOutput: "transcript",
		fullscreenScrollbar: "auto",
		fullscreenCopyOnSelect: true,
		fullscreenWheelScrollLines: 7,
		warnings: { anthropicExtraUsage: true },
	};
}

function createCallbacks() {
	return {
		onAutoCompactChange: vi.fn(),
		onShowImagesChange: vi.fn(),
		onImageWidthCellsChange: vi.fn(),
		onAutoResizeImagesChange: vi.fn(),
		onBlockImagesChange: vi.fn(),
		onEnableSkillCommandsChange: vi.fn(),
		onSteeringModeChange: vi.fn(),
		onFollowUpModeChange: vi.fn(),
		onTransportChange: vi.fn(),
		onSessionShareDestinationChange: vi.fn(),
		onHttpIdleTimeoutMsChange: vi.fn(),
		onCacheWarmingModeChange: vi.fn(),
		onModelThinkingLevelChange: vi.fn(),
		onModelThinkingLevelRemove: vi.fn(),
		onThemeChange: vi.fn(),
		onThemePreview: vi.fn(),
		onIconPresetChange: vi.fn(),
		onRexEnabledChange: vi.fn(),
		onRexModeChange: vi.fn(),
		onMinimizedRexJobsChange: vi.fn(),
		onHideThinkingBlockChange: vi.fn(),
		onMermaidRenderingModeChange: vi.fn(),
		onShowCacheMissNoticesChange: vi.fn(),
		onCollapseChangelogChange: vi.fn(),
		onEnableInstallTelemetryChange: vi.fn(),
		onDoubleEscapeActionChange: vi.fn(),
		onTreeFilterModeChange: vi.fn(),
		onShowHardwareCursorChange: vi.fn(),
		onEditorPaddingXChange: vi.fn(),
		onOutputPadChange: vi.fn(),
		onAutocompleteMaxVisibleChange: vi.fn(),
		onQuietStartupChange: vi.fn(),
		onDefaultProjectTrustChange: vi.fn(),
		onClearOnShrinkChange: vi.fn(),
		onShowTerminalProgressChange: vi.fn(),
		onTuiModeChange: vi.fn(),
		onFullscreenExitOutputChange: vi.fn(),
		onFullscreenScrollbarChange: vi.fn(),
		onFullscreenCopyOnSelectChange: vi.fn(),
		onFullscreenWheelScrollLinesChange: vi.fn(),
		onWarningsChange: vi.fn(),
		onCancel: vi.fn(),
	} satisfies SettingsCallbacks;
}

function mouseEvent(type: "press" | "click"): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 5,
		y: 2,
		screenX: 5,
		screenY: 2,
		width: 120,
		height: 20,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("settings row icons", () => {
	const originalCapabilities = getCapabilities();
	const originalPreset = getIconPreset();

	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	beforeEach(() => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		setIconPreset("unicode");
	});

	afterEach(() => {
		setCapabilities(originalCapabilities);
		setIconPreset(originalPreset);
	});

	it.each(["unicode", "nerd"] as const)(
		"decorates every row in order using %s icons and leaves values plain",
		(preset) => {
			setIconPreset(preset);
			const list = new SettingsSelectorComponent(createConfig(), createCallbacks()).getSettingsList();
			for (const row of MAIN_ROWS) {
				const lines = list.render(120).map(stripAnsi);
				const selected = lines.find((line) => line.startsWith("→ "));
				expect(selected?.startsWith(`→ ${icon(row.icon)}  ${row.label}  `), row.id).toBe(true);
				expect(selected?.endsWith(row.value), row.id).toBe(true);
				list.handleInput("\x1b[B");
			}
			expect(stripAnsi(list.render(120).join("\n"))).toContain(`→ ${icon("compact")}  Auto-compact`);
		},
	);

	it("omits only the image-display rows when the terminal does not support images", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const list = new SettingsSelectorComponent(createConfig(), createCallbacks()).getSettingsList();
		for (const row of MAIN_ROWS.filter((row) => row.id !== "show-images" && row.id !== "image-width-cells")) {
			expect(stripAnsi(list.render(120).join("\n")), row.id).toContain(`→ ${icon(row.icon)}  ${row.label}`);
			list.handleInput("\x1b[B");
		}
		expect(stripAnsi(list.render(120).join("\n"))).toContain(`→ ${icon("compact")}  Auto-compact`);
	});

	it.each(["unicode", "nerd"] as const)(
		"keeps fuzzy matching and its ordering independent of %s decoration",
		(preset) => {
			setIconPreset(preset);
			for (const query of ["auto", "theme", "cache", "Fullscreen", "Default thinking level", "?", "⚙", "\uf013"]) {
				const list = new SettingsSelectorComponent(createConfig(), createCallbacks()).getSettingsList();
				for (const character of query) list.handleInput(character);
				const expectedRows = fuzzyFilter([...MAIN_ROWS], query, (row) => row.label);
				if (expectedRows.length === 0) {
					expect(stripAnsi(list.render(120).join("\n"))).toContain("No matching settings");
				}
				for (const row of expectedRows) {
					expect(stripAnsi(list.render(120).join("\n")), query).toContain(`→ ${icon(row.icon)}  ${row.label}`);
					list.handleInput("\x1b[B");
				}
			}
		},
	);

	it("updates the existing menu immediately when the Icons setting changes", () => {
		const callbacks = createCallbacks();
		callbacks.onIconPresetChange.mockImplementation(setIconPreset);
		const list = new SettingsSelectorComponent(createConfig(), callbacks).getSettingsList();
		list.selectItem("icon-preset");
		expect(stripAnsi(list.render(120).join("\n"))).toContain(`→ ${icon("settings")}  Icons`);
		list.handleInput("\r");
		expect(callbacks.onIconPresetChange).toHaveBeenLastCalledWith("nerd");
		expect(stripAnsi(list.render(120).join("\n"))).toContain(`→ ${icon("settings")}  Icons`);
		list.selectItem("autocompact");
		expect(stripAnsi(list.render(120).join("\n"))).toContain(`→ ${icon("compact")}  Auto-compact`);
		list.selectItem("icon-preset");
		list.handleInput(" ");
		expect(callbacks.onIconPresetChange).toHaveBeenLastCalledWith("unicode");
		expect(stripAnsi(list.render(120).join("\n"))).toContain(`→ ${icon("settings")}  Icons`);
	});

	it("preserves IDs, keyboard and mouse controls, callback values, and cancel", () => {
		const callbacks = createCallbacks();
		const list = new SettingsSelectorComponent(createConfig(), callbacks).getSettingsList();
		list.render(120);
		list.handleInput("\r");
		list.handleInput(" ");
		list.handleMouse(mouseEvent("press"));
		list.handleMouse(mouseEvent("click"));
		expect(callbacks.onAutoCompactChange.mock.calls.flat()).toEqual([false, true, false]);

		list.handleInput("\x1b[6~");
		expect(stripAnsi(list.render(120).join("\n"))).toContain(`→ ${icon("terminal")}  Clear on shrink`);
		list.handleInput("\x1b[5~");
		expect(stripAnsi(list.render(120).join("\n"))).toContain(`→ ${icon("compact")}  Auto-compact`);
		list.handleInput("\x1b[A");
		list.handleInput("\r");
		expect(callbacks.onMinimizedRexJobsChange).toHaveBeenCalledWith(false);

		list.selectItem("image-width-cells");
		list.handleInput("\r");
		expect(callbacks.onImageWidthCellsChange).toHaveBeenCalledWith(80);
		for (const character of "Session share destination") list.handleInput(character);
		list.handleInput("\r");
		expect(callbacks.onSessionShareDestinationChange).toHaveBeenCalledWith("gist");
		list.handleInput("\x1b");
		expect(callbacks.onCancel).toHaveBeenCalledOnce();
	});

	it("decorates settings-owned submenu rows without changing their values", () => {
		const callbacks = createCallbacks();
		const list = new SettingsSelectorComponent(createConfig(), callbacks).getSettingsList();
		list.selectItem("warnings");
		list.handleInput("\r");
		for (const preset of ["unicode", "nerd"] as const) {
			setIconPreset(preset);
			expect(stripAnsi(list.render(120).join("\n"))).toContain(`→ ${icon("bug")}  Anthropic extra usage  true`);
		}
		list.handleInput("\r");
		expect(callbacks.onWarningsChange).toHaveBeenCalledWith({ anthropicExtraUsage: false });
		list.handleInput("\x1b");
		list.selectItem("theme");
		list.handleInput("\r");
		for (const preset of ["unicode", "nerd"] as const) {
			setIconPreset(preset);
			const output = stripAnsi(list.render(120).join("\n"));
			for (const label of ["Light theme", "Dark theme", "Change mode"]) {
				expect(output).toContain(`${icon("settings")}  ${label}`);
			}
			expect(output).toContain(`${icon("submit")}  Apply`);
		}
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		list.handleInput("\r");
		expect(callbacks.onThemeChange).toHaveBeenCalledWith("light/dark");
	});

	it.each(["unicode", "nerd"] as const)("keeps all rows within narrow terminal widths with %s icons", (preset) => {
		setIconPreset(preset);
		const component = new SettingsSelectorComponent(createConfig(), createCallbacks());
		for (const row of MAIN_ROWS) {
			component.getSettingsList().selectItem(row.id);
			for (const width of [12, 24, 40]) {
				for (const line of component.render(width)) expect(visibleWidth(line), row.id).toBeLessThanOrEqual(width);
			}
		}
	});
});
