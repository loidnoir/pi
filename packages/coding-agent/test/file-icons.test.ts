import { join } from "node:path";
import { hyperlink, resetCapabilitiesCache, setCapabilities, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getReadmePath } from "../src/config.ts";
import { renderToolPath } from "../src/core/tools/render-utils.ts";
import { createAllToolRenderers } from "../src/core/tools/renderers/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { fileIcon, fileIconPrefix } from "../src/modes/interactive/file-icons.ts";
import { icon, setIconPreset } from "../src/modes/interactive/icons.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const renderers = createAllToolRenderers();
const tui = { requestRender() {} } as unknown as TUI;

function tool(name: keyof typeof renderers, args: Record<string, unknown> = {}): ToolExecutionComponent {
	return new ToolExecutionComponent(name, `file-icons-${name}`, args, {}, renderers[name], tui, process.cwd());
}

function plain(component: ToolExecutionComponent): string {
	return stripAnsi(component.render(300).join("\n"));
}

describe("file-type path icons", () => {
	beforeEach(() => {
		initTheme("dark");
		setIconPreset("nerd");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	});
	afterEach(() => {
		setIconPreset("unicode");
		initTheme("dark");
		resetCapabilitiesCache();
	});

	test.each([
		["src/file.ts", "\ue628"],
		["src/file.d.ts", "\ue628"],
		["src/file.mts", "\ue628"],
		["src/file.cts", "\ue628"],
		["src/file.tsx", "\ue7ba"],
		["src/file.test.TS", "\ue628"],
		["src/file.js", "\ue74e"],
		["src/file.mjs", "\ue74e"],
		["src/file.jsx", "\ue7ba"],
		["src/file.py", "\ue73c"],
		["src/file.rs", "\ue7a8"],
		["src/file.go", "\ue724"],
		["docs/file.md", "\ue73e"],
		["config.json", "\ue60b"],
		["config.yaml", "\ue6a8"],
		["config.yml", "\ue6a8"],
		["Dockerfile", "\ue7b0"],
		["Makefile", "\ue615"],
		[".gitignore", "\ue702"],
		["C:\\src\\file.ts", "\ue628"],
	])("selects the conventional glyph for %s", (path, glyph) => {
		expect(fileIcon(path)).toBe(glyph);
		expect(fileIconPrefix(path)).toBe(`${glyph} `);
	});

	test("uses shell, folder and unknown-file fallbacks without filesystem inference", () => {
		expect(fileIcon("run.sh")).toBe(icon("terminal"));
		expect(fileIcon(".zshrc")).toBe(icon("terminal"));
		for (const path of ["src/", "src\\", ".", ".."]) expect(fileIcon(path)).toBe(icon("folder"));
		expect(fileIcon("directory.ts", "directory")).toBe(icon("folder"));
		for (const path of ["file.unknown", "file.constructor", "file.toString", "LICENSE", "ts", "src"]) {
			expect(fileIcon(path)).toBe(icon("read"));
		}
	});

	test.each([
		"https://example.com/file.ts",
		"http://example.com/file.md",
		"artifact://session/file.ts",
		"ftp://host/file.py",
	])("does not treat the URI %s as a local file", (path) => {
		expect(fileIcon(path)).toBe("");
		expect(fileIcon(path, "directory")).toBe("");
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		expect(renderToolPath(path, theme, "/project")).toBe(theme.fg("accent", path));
		expect(plain(tool("read", { path }))).toContain(`read ${path}`);
	});

	test.each([
		{ name: "read", args: { path: "src/file.ts", offset: 9, limit: 2 }, expected: "read \ue628 src/file.ts:9-10" },
		{ name: "read", args: { file_path: "src/file.tsx" }, expected: "read \ue7ba src/file.tsx" },
		{ name: "write", args: { path: "src/file.py", content: "" }, expected: "write \ue73c src/file.py" },
		{ name: "edit", args: { path: "src/file.rs", edits: [] }, expected: "edit \ue7a8 src/file.rs" },
		{ name: "ls", args: { path: "directory.ts" }, expected: "ls \uf07b directory.ts" },
		{ name: "ls", args: {}, expected: "ls \uf07b ." },
	] as const)("decorates $name header paths", ({ name, args, expected }) => {
		expect(plain(tool(name, args))).toContain(expected);
	});

	test("decorates compact docs and resource reads but keeps skill labels semantic", () => {
		expect(plain(tool("read", { path: getReadmePath() }))).toContain("read docs \ue73e README.md");
		expect(plain(tool("read", { path: join(process.cwd(), ".pi", "AGENTS.md") }))).toContain(
			"read resource \ue73e .pi/AGENTS.md",
		);
		const skill = plain(tool("read", { path: "/tmp/example/SKILL.md" }));
		expect(skill).toContain(`${icon("skill")} [skill] example`);
		expect(skill).not.toContain("\ue73e");
	});

	test("keeps only the path inside its OSC 8 link", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const rendered = renderToolPath("src/file name.ts", theme, "/project");
		expect(rendered).toBe(
			theme.fg("accent", "\ue628 ") +
				hyperlink(theme.fg("accent", "src/file name.ts"), "file:///project/src/file%20name.ts"),
		);
		const compact = tool("read", { path: getReadmePath() }).render(300).join("\n");
		expect(compact.indexOf("\ue73e")).toBeLessThan(compact.indexOf("\x1b]8;;file:"));
		expect(compact).toContain("README.md");
	});

	test.each([":", "-"])("decorates grep %s rows only at the filename prefix", (separator) => {
		const path = "packages/my file:part.test.ts";
		const source = "other.py:18: matched text -20- README.md";
		const row = `${path}${separator}46${separator} ${source}`;
		const component = tool("grep", { pattern: "matched" });
		const result = {
			content: [{ type: "text", text: row }],
			details: { files: [path], matchCount: 1 },
			isError: false,
		};
		const before = JSON.stringify(result);
		component.updateResult(result);
		expect(plain(component)).toContain(`\ue628 ${row}`);
		expect(plain(component)).not.toContain(`\ue73c ${source}`);
		expect(JSON.stringify(result)).toBe(before);
	});

	test.each([":", "-"])("decorates a final empty grep %s row after output trimming", (separator) => {
		for (const details of [undefined, { files: ["file.ts"], matchCount: 1 }]) {
			const component = tool("grep", { pattern: "^$" });
			component.updateResult({
				content: [{ type: "text", text: `file.ts${separator}8${separator} ` }],
				details,
				isError: false,
			});
			expect(plain(component)).toContain(`\ue628 file.ts${separator}8${separator}`);
		}
	});

	test("uses grep file metadata for ambiguous paths and leaves notices and separators intact", () => {
		const path = "src/name:8: nested.tsx";
		const row = `${path}:9: content:10: in source`;
		const notice = "[Skipped missing paths: missing.ts:9: fake row]";
		const artifact = "[Full captured output: artifact://session/file. Use read with this path and offset/limit]";
		const component = tool("grep", { pattern: "content" });
		component.setExpanded(true);
		component.updateResult({
			content: [{ type: "text", text: `${artifact}\n${row}\n--\n\n${notice}` }],
			details: { files: ["src/name", path], matchCount: 1, perFileLimitReached: 20, linesTruncated: true },
			isError: false,
		});
		const rendered = plain(component);
		expect(rendered).toContain(`\ue7ba ${row}`);
		expect(
			rendered
				.split("\n")
				.find((line) => line.includes(notice))
				?.trim(),
		).toBe(notice);
		expect(
			rendered
				.split("\n")
				.find((line) => line.includes(artifact))
				?.trim(),
		).toBe(artifact);
		expect(rendered.split("\n").some((line) => line.trim() === "--")).toBe(true);
		expect(rendered).toContain("[Truncated: 20 matches per file, some lines truncated]");
	});

	test("supports legacy grep rows without decorating arbitrary output", () => {
		const component = tool("grep", { pattern: "value" });
		const output = [
			"src/my file:part.ts:9: value README.md:10: source",
			"src/my file:part.ts-8- context README.md-10- source",
			"No matches found",
			"No more results",
			"[Skipped missing paths: missing.ts:9: fake row]",
			"artifact://session/file.ts:9: not a local file",
			"https://example.com/file.ts:9: not a local file",
		].join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], isError: false });
		const rendered = plain(component);
		expect(rendered).toContain("\ue628 src/my file:part.ts:9: value README.md:10: source");
		expect(rendered).toContain("\ue628 src/my file:part.ts-8- context README.md-10- source");
		expect(rendered.match(/\ue628/g)).toHaveLength(2);
		expect(rendered).not.toContain("\ue73e");
		expect(rendered).not.toContain(`${icon("read")} [Skipped`);
	});

	test.each(["find", "ls"] as const)(
		"decorates %s listing rows, not notices or retained-output references",
		(name) => {
			const artifact = "[Full captured output: artifact://session/file. Use read with this path and offset/limit]";
			const notice = "[20 results limit reached. Skipped missing paths: missing.ts]";
			const output = `${artifact}\nsrc/\nmy file:part.ts\n[bracket].md\nLICENSE\nartifact://session/file.ts\n\n${notice}`;
			const component = tool(name);
			component.setExpanded(true);
			const result = { content: [{ type: "text", text: output }], isError: false };
			component.updateResult(result);
			const rendered = plain(component);
			expect(rendered).toContain(`${icon("folder")} src/`);
			expect(rendered).toContain("\ue628 my file:part.ts");
			expect(rendered).toContain("\ue73e [bracket].md");
			expect(rendered).toContain(`${icon("read")} LICENSE`);
			for (const line of [artifact, notice, "artifact://session/file.ts"]) {
				expect(
					rendered
						.split("\n")
						.find((row) => row.includes(line))
						?.trim(),
				).toBe(line);
			}
			expect(result.content[0].text).toBe(output);
		},
	);

	test.each([
		{ name: "find", output: "No files found matching pattern" },
		{ name: "ls", output: "(empty directory)" },
	] as const)("keeps the $name empty-result label undecorated", ({ name, output }) => {
		const component = tool(name);
		component.updateResult({ content: [{ type: "text", text: output }], isError: false });
		expect(
			plain(component)
				.split("\n")
				.find((line) => line.includes(output))
				?.trim(),
		).toBe(output);
	});

	test.each(["grep", "find", "ls"] as const)("does not parse %s errors as paths", (name) => {
		const output = "some file.ts:9: an error, not a result row";
		const component = tool(name);
		component.updateResult({ content: [{ type: "text", text: output }], isError: true });
		expect(
			plain(component)
				.split("\n")
				.find((line) => line.includes(output))
				?.trim(),
		).toBe(output);
	});

	test.each(["grep", "find", "ls"] as const)("preserves %s collapsed row counts and expansion", (name) => {
		const component = tool(name);
		const output = Array.from({ length: 25 }, (_, index) =>
			name === "grep" ? `file.ts:${index + 1}: value` : `file${index}.ts`,
		).join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], isError: false });
		const limit = name === "grep" ? 15 : 20;
		expect(plain(component)).toContain(`${25 - limit} more lines`);
		component.setExpanded(true);
		expect(plain(component)).not.toContain("more lines");
		expect(plain(component).match(/\ue628/g)).toHaveLength(25);
		for (const line of component.render(30)) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});

	test.each(["read", "write", "edit", "grep", "find", "ls"] as const)(
		"rebuilds %s glyphs and colors on invalidation",
		(name) => {
			const component = tool(name, { path: "file.ts", pattern: "value", content: "", edits: [] });
			component.updateResult({
				content: [{ type: "text", text: name === "grep" ? "file.ts:9: value" : "file.ts" }],
				isError: false,
			});
			const nerd = component.render(300).join("\n");
			expect(stripAnsi(nerd)).toContain(name === "ls" ? "\uf07b file.ts" : "\ue628 file.ts");
			initTheme("light");
			component.invalidate();
			const light = component.render(300).join("\n");
			expect(light).not.toBe(nerd);
			expect(stripAnsi(light)).toBe(stripAnsi(nerd));
			setIconPreset("unicode");
			component.invalidate();
			const unicode = plain(component);
			expect(unicode).not.toContain("\ue628");
			expect(unicode).not.toContain("\uf07b");
			setIconPreset("nerd");
			component.invalidate();
			expect(component.render(300).join("\n")).toBe(light);
		},
	);

	test("keeps Unicode paths plain, including compact reads", () => {
		setIconPreset("unicode");
		expect(fileIcon("file.ts")).toBe("");
		expect(fileIconPrefix("src/")).toBe("");
		expect(stripAnsi(renderToolPath("file.ts", theme, "/project"))).toBe("file.ts");
		expect(plain(tool("read", { path: "src/file.ts" }))).toContain("read src/file.ts");
		expect(plain(tool("read", { path: getReadmePath() }))).toContain("read docs README.md");
	});
});
