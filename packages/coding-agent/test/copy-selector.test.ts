import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CopySelectorComponent } from "../src/modes/interactive/components/copy-selector.ts";
import { type CopyItem, getCopyItems } from "../src/modes/interactive/copy-items.ts";
import { iconPrefix, setIconPreset } from "../src/modes/interactive/icons.ts";
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

describe("copy selector icon prefixes", () => {
	it("formats live presentation labels without changing copied content or selection", () => {
		const source = "```ts\nconst 日本語 = 1;\n```\n\n> Keep **Markdown**.\n";
		const items = getCopyItems(source);
		const original = structuredClone(items);
		const select = vi.fn<(item: CopyItem) => void>();
		const component = new CopySelectorComponent(items, select, vi.fn());
		for (const preset of ["nerd", "unicode", "nerd"] as const) {
			setIconPreset(preset);
			component.invalidate();
			const rendered = stripAnsi(component.render(120).join("\n"));
			for (const item of items)
				expect(rendered).toContain(`${iconPrefix(item.kind === "whole" ? "copy" : item.kind)}${item.label}`);
			for (const width of [4, 8, 20, 40])
				for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		component.handleInput("\r");
		expect(select).toHaveBeenCalledWith(items[0]);
		expect(select.mock.calls[0][0]).toBe(items[0]);
		expect(items).toEqual(original);
		expect(items.at(-1)?.text).toBe(source);
	});
});
