import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { reasoningHeadingIcon, ThinkingMarkdown } from "../src/modes/interactive/components/thinking-markdown.ts";
import { icon, setIconPreset } from "../src/modes/interactive/icons.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function thinkingMarkdown(text: string): ThinkingMarkdown {
	return new ThinkingMarkdown(text, 1, getMarkdownTheme(), (markdown) => markdown);
}

describe("reasoning heading icons", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => setIconPreset("unicode"));

	test.each([
		["Design", "edit"],
		["Designs", "edit"],
		["Designed", "edit"],
		["Designing", "edit"],
		["Locate", "location"],
		["Locates", "location"],
		["Located", "location"],
		["Locating", "location"],
		["Review", "search"],
		["Reviews", "search"],
		["Reviewed", "search"],
		["Reviewing", "search"],
		["Refine", "sparkles"],
		["Refines", "sparkles"],
		["Refined", "sparkles"],
		["Refining", "sparkles"],
		["Check", "read"],
		["Checks", "read"],
		["Checked", "read"],
		["Checking", "read"],
		["Wait", "clock"],
		["Waits", "clock"],
		["Waited", "clock"],
		["Waiting", "clock"],
		["Await", "clock"],
		["Awaits", "clock"],
		["Awaited", "clock"],
		["Awaiting", "clock"],
	] as const)("matches the %s action family", (word, expected) => {
		expect(reasoningHeadingIcon(`${word} the status update`)).toBe(expected);
		expect(reasoningHeadingIcon(word.toLowerCase())).toBe(expected);
	});

	test.each([
		"Redesigning the renderer",
		"Designer notes",
		"Location metadata",
		"Previewing changes",
		"Reviewer calls",
		"Checker output",
		"Waiter status",
		"review.ts",
		"checking/status.ts",
		"design_system",
		"Review-related documentation",
		"I am checking the renderer",
		"The review is finished",
		"`Review` this call",
		"Finishing the status fix",
		"Delegating pause-status work",
	])("does not classify arbitrary mentions or word fragments: %s", (text) => {
		expect(reasoningHeadingIcon(text)).toBeUndefined();
	});

	test("reproduces all headings in the single screenshot thinking block", () => {
		setIconPreset("nerd");
		const headings = [
			["Delegating pause-status work", "thinking"],
			["Finishing the status fix", "thinking"],
			["Refining paused-state display", "sparkles"],
			["Designing paused-state priority", "edit"],
			["Designing pause wrapper", "edit"],
			["Locating status update path", "location"],
			["Reviewing the status changes", "search"],
			["Checking paused status", "read"],
			["Awaiting the status tests", "clock"],
			["Waiting for the agent", "clock"],
		] as const;
		const markdown = headings.map(([heading]) => `**${heading}**`).join("\n\n");
		const rendered = thinkingMarkdown(markdown)
			.render(80)
			.map((line) => stripAnsi(line).trimEnd());
		expect(rendered.filter((line) => line.trim())).toEqual(
			headings.map(([heading, name]) => ` ${icon(name)} ${heading}`),
		);
	});

	test("supports plain, emphasized, ATX, and setext heading forms", () => {
		const markdown = [
			"Designing the wrapper",
			"*Locating the path*",
			"## Reviewing the changes",
			"### Reviewing a third-level heading",
			"###### Locating a sixth-level heading",
			"Checking the status\n---",
			"**Refining the layout**",
			"# Awaiting the tests",
		].join("\n\n");
		const rendered = stripAnsi(thinkingMarkdown(markdown).render(80).join("\n"));
		for (const [name, title] of [
			["edit", "Designing"],
			["location", "Locating"],
			["search", "Reviewing"],
			["read", "Checking"],
			["sparkles", "Refining"],
			["clock", "Awaiting"],
		] as const) {
			expect(rendered).toContain(`${icon(name)} ${title}`);
		}
		expect(rendered).toContain(`${icon("search")} ### Reviewing a third-level heading`);
		expect(rendered).toContain(`${icon("location")} ###### Locating a sixth-level heading`);
	});

	test("decorates standalone emphasized action labels with colons without classifying prose or code", () => {
		const markdown = [
			"**Review: paused-state UI**",
			"**Design: pause wrapper**",
			"*Checking: paused state*",
			"**Review: this is a complete sentence.**",
			"Review: ordinary prose is not explicitly a heading",
			"`Review: paused-state UI`",
			"```md\nDesign: pause wrapper\n```",
		].join("\n\n");
		const rendered = thinkingMarkdown(markdown).render(80).map(stripAnsi);
		expect(rendered.filter((line) => line.includes(`${icon("search")} `))).toEqual([
			expect.stringContaining(`${icon("search")} Review: paused-state UI`),
		]);
		expect(rendered.filter((line) => line.includes(`${icon("edit")} `))).toEqual([
			expect.stringContaining(`${icon("edit")} Design: pause wrapper`),
		]);
		expect(rendered.join("\n")).toContain(`${icon("read")} Checking: paused state`);
	});

	test("keeps repeated heading text in prose, nested blocks, and display math undecorated", () => {
		const markdown = [
			"Checking the state",
			"Checking the state\nis ordinary multiline prose.",
			"- Checking the state",
			"> # Checking the state",
			"$$\n\\text{Designing a formula}\n\nChecking math contents\n\n$$",
			"\\[\nChecking bracket math\n\nReviewing formula terms\n\\]",
			"**Designing** the first wrapper",
			"**Designing** the second wrapper",
		].join("\n\n");
		const rendered = thinkingMarkdown(markdown).render(80).map(stripAnsi);
		expect(rendered.filter((line) => line.includes(`${icon("read")} `))).toEqual([
			expect.stringContaining(`${icon("read")} Checking the state`),
		]);
		expect(rendered.filter((line) => line.includes(`${icon("edit")} `))).toHaveLength(2);
		expect(rendered.join("\n")).not.toContain(`${icon("search")} `);
	});

	test("keeps per-heading metadata valid when cached blocks move after new earlier headings", () => {
		const component = thinkingMarkdown("Designing the wrapper\n\nChecking the status");
		component.render(80);
		component.setText("Locating the file\n\nDesigning the wrapper\n\nChecking the status");
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain(`${icon("location")} Locating the file`);
		expect(rendered).toContain(`${icon("edit")} Designing the wrapper`);
		expect(rendered).toContain(`${icon("read")} Checking the status`);
	});

	test("keeps the full Markdown document and excludes nested blocks, code, files, and prose", () => {
		const markdown = [
			"**Designing the wrapper**",
			"```md\nChecking hidden code\n\nReviewing hidden code\n```",
			"- **Checking a list item**\n\n  Reviewing a loose continuation\n\n  - Locating a nested item",
			"> ## Checking a quoted heading\n>\n> Reviewing quoted text",
			"| Checking a table heading | Review |\n| --- | --- |\n| Locating a table value | Refining |",
			"    Reviewing indented code\n\n    Checking more code",
			"`Checking` a code identifier",
			"review.ts and checking/status.ts",
			"I am reviewing the renderer",
			"Checking the state is prose,\nnot a standalone heading",
			"Checking this is a complete sentence.",
			"[Reviewing a linked label][target]",
			"**Refining the layout** with [context][target]",
			"[target]: https://example.com/context",
		].join("\n\n");
		const width = 96;
		const rendered = thinkingMarkdown(markdown).render(width);
		const gutterWidth = visibleWidth(` ${icon("thinking")} `);
		const body = rendered.map((line) => stripAnsi(line).slice(gutterWidth));
		const ordinary = new Markdown(markdown, 0, 0, getMarkdownTheme(), {
			color: (text) => theme.fg("thinkingText", text),
			italic: true,
		}).render(width - gutterWidth);
		expect(body).toEqual(ordinary.map(stripAnsi));
		const visible = stripAnsi(rendered.join("\n"));
		expect(visible).toContain(`${icon("edit")} Designing the wrapper`);
		expect(visible).toContain(`${icon("sparkles")} Refining the layout`);
		for (const name of ["location", "search", "read", "clock"] as const) {
			expect(visible).not.toContain(`${icon(name)} `);
		}
		expect(rendered.join("\n")).not.toContain("pi-thinking-heading");
	});

	test.each(["unicode", "nerd"] as const)("uses %s glyphs after preset invalidation", (preset) => {
		const component = thinkingMarkdown("**Designing the wrapper**\n\nLocating the path\n\nRefining the layout");
		setIconPreset(preset === "nerd" ? "unicode" : "nerd");
		const before = component.render(80);
		setIconPreset(preset);
		component.invalidate();
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(component.render(80)).not.toEqual(before);
		for (const name of ["edit", "location", "sparkles"] as const) expect(rendered).toContain(`${icon(name)} `);
	});

	test.each([0, 1, 2, 3, 4, 5, 8, 20, 80])("keeps all lines within %i columns", (width) => {
		for (const preset of ["unicode", "nerd"] as const) {
			setIconPreset(preset);
			const component = thinkingMarkdown(
				"Designing a long wrapper for 日本語\n\nChecking the first status display\n\n| Review | Check |\n| --- | --- |\n| 日本語 | value |",
			);
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("retains one transformed full document at the exact content width", () => {
		const source = "Reviewing the changes\n\nChecking the renderer";
		const transform = vi.fn((markdown: string, _availableWidth: number) =>
			markdown.replace("Reviewing", "Designing"),
		);
		const component = new ThinkingMarkdown(source, 1, getMarkdownTheme(), transform);
		const rendered = stripAnsi(component.render(80).join("\n"));
		component.render(80);
		expect(transform).toHaveBeenCalledExactlyOnceWith(source, 77);
		expect(rendered).toContain(`${icon("edit")} Designing the changes`);
		expect(rendered).toContain(`${icon("read")} Checking the renderer`);
	});
});
