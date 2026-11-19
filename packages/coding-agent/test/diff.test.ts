import { visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateDiffString } from "../src/core/tools/edit-diff.ts";
import { EditDiffComponent, renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("renderDiff", () => {
	beforeAll(() => initTheme("dark"));

	it.each([
		{
			name: "text is inserted at the start of a line",
			diff: "-83   await commitRecordingChunk({\n+83   const result = await commitRecordingChunk({",
			expected: ["-83   await commitRecordingChunk({", "+83   const result = await commitRecordingChunk({"],
		},
		{
			name: "indented text is replaced",
			diff: "-12     const value = oldValue\n+12     const value = newValue",
			expected: ["-12     const value = oldValue", "+12     const value = newValue"],
		},
	])("preserves indentation when $name", ({ diff, expected }) => {
		const rendered = renderDiff(diff);

		expect(stripAnsi(rendered).split("\n")).toEqual(expected);
	});

	it("does not highlight shared indentation as an insertion", () => {
		const rendered = renderDiff(
			"-83   await commitRecordingChunk({\n+83   const result = await commitRecordingChunk({",
		);
		const inverseInsertion = theme.inverse("const result = ");

		expect(rendered.indexOf("+83   ")).toBeLessThan(rendered.indexOf(inverseInsertion));
		expect(rendered).toContain(inverseInsertion);
	});
});

describe("EditDiffComponent", () => {
	const styleLevel = chalk.level;
	beforeAll(() => {
		chalk.level = 3;
		initTheme("dark");
	});
	afterAll(() => {
		chalk.level = styleLevel;
	});

	it("switches at 80 cells and numbers both sides across unequal changes and omitted context", () => {
		const { diff } = generateDiffString("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nB\nextra\nc\nd\ne\nf\nh\n", 1);
		const component = new EditDiffComponent(diff);
		expect(component.render(79)).toEqual(renderDiff(diff).split("\n"));
		const wide = component.render(80);
		expect(
			wide.map((line) =>
				stripAnsi(line)
					.split("│")
					.map((cell) => cell.trim()),
			),
		).toEqual([
			["1 a", "1 a"],
			["-2 b", "+2 B"],
			["", "+3 extra"],
			["3 c", "4 c"],
			["...", "..."],
			["6 f", "7 f"],
			["-7 g", ""],
			["8 h", "8 h"],
		]);
		expect(component.render(80)).toBe(wide);
		component.invalidate();
		expect(component.render(80)).not.toBe(wide);
	});

	it("wraps every cell without losing wide glyphs or whitespace and keeps the divider aligned", () => {
		const content = `\t${"界".repeat(60)}${" ".repeat(42)}end`;
		const component = new EditDiffComponent(`+1 ${content}`);
		const wide = component.render(81);
		const rows = wide.map((line) => stripAnsi(line).split(" │ "));
		expect(new Set(rows.map(([left]) => visibleWidth(left))).size).toBe(1);
		expect(
			rows
				.map(([, right]) => right)
				.join("")
				.trimStart(),
		).toBe(`+1 ${content.replace("\t", "   ")}`);
		expect(wide.every((line) => visibleWidth(line) <= 81)).toBe(true);
		const narrow = component.render(30);
		expect(narrow.every((line) => visibleWidth(line) <= 30)).toBe(true);
		expect(narrow.map(stripAnsi).join("")).toBe(`+1 ${content.replace("\t", "   ")}`);
		expect(component.render(1).every((line) => visibleWidth(line) <= 1)).toBe(true);
	});

	it("keeps flag graphemes intact across a wrapped replacement", () => {
		const suffix = "z".repeat(90);
		const rows = new EditDiffComponent(`-1 🇺🇸${suffix}\n+1 🇺🇳${suffix}`).render(80);
		expect(rows.join("\n")).toContain("🇺🇸");
		expect(rows.join("\n")).toContain("🇺🇳");
		expect(rows.every((row) => visibleWidth(row) <= 80)).toBe(true);
		expect(rows.map((row) => stripAnsi(row).split(" │ ")[1]).join("")).toBe(`+1 🇺🇳${suffix}`);
	});

	it("keeps Unicode line and paragraph separators inside their added cell", () => {
		const diff = "+1 a\u2028b\u2029c";
		const [row] = new EditDiffComponent(diff).render(80);
		expect(
			stripAnsi(row)
				.split(" │ ")
				.map((cell) => cell.trim()),
		).toEqual(["", diff]);
	});

	it("ends inverse styling before padding on each narrow wrapped row", () => {
		const rows = new EditDiffComponent(`-1 ${"x".repeat(26)}\n+1 ${"y".repeat(26)}`).render(12);
		const highlighted = rows.filter((row) => row.includes("\x1b[7m"));
		expect(highlighted.length).toBeGreaterThan(2);
		for (const row of highlighted) expect(row.lastIndexOf("\x1b[27m")).toBeGreaterThan(row.lastIndexOf("\x1b[7m"));
	});

	it("retains intraline styling without replacing either side's whitespace", () => {
		const [row] = new EditDiffComponent("-1 old\tend   value\n+1 new\tend value").render(80);
		expect(
			stripAnsi(row)
				.split("│")
				.map((cell) => cell.trim()),
		).toEqual(["-1 old   end   value", "+1 new   end value"]);
		expect(row).toContain(theme.inverse("old"));
		expect(row).toContain(theme.inverse("new"));
	});
});
