import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { glyphPrefix, icon, iconPrefix, setIconPreset } from "../src/modes/interactive/icons.ts";

afterEach(() => setIconPreset("unicode"));

describe("icon presentation prefixes", () => {
	it.each([
		["job", "\uf085"],
		["tree", "\uf0e8"],
		["keyboard", "\uf11c"],
		["terminal", "\uf120"],
	] as const)(
		"reserves one optical column for the Nerd %s glyph without changing its terminal width",
		(name, glyph) => {
			setIconPreset("nerd");
			expect(icon(name)).toBe(glyph);
			expect(visibleWidth(glyph)).toBe(1);
			expect(glyphPrefix(glyph)).toBe(`${glyph}  `);
			expect(iconPrefix(name)).toBe(`${glyph}  `);
			expect(visibleWidth(iconPrefix(name))).toBe(3);
			setIconPreset("unicode");
			expect(iconPrefix(name)).toBe(`${icon(name)} `);
			expect(glyphPrefix(glyph)).toBe(`${glyph}  `);
			setIconPreset("nerd");
			expect(iconPrefix(name)).toBe(`${glyph}  `);
		},
	);

	it("keeps normal semantic and file pairs compact and leaves an absent glyph empty", () => {
		setIconPreset("nerd");
		expect(icon("edit")).toBe("\uf040");
		expect(iconPrefix("edit")).toBe("\uf040 ");
		expect(glyphPrefix("\ue628")).toBe("\ue628 ");
		expect(iconPrefix("code")).toBe("\uf44f ");
		expect(glyphPrefix("")).toBe("");
		setIconPreset("unicode");
		expect(icon("agentWorker")).toBe("</>");
		expect(iconPrefix("agentWorker")).toBe("</> ");
		expect(visibleWidth(iconPrefix("agentWorker"))).toBe(4);
	});
});
