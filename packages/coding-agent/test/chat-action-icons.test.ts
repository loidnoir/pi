import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createAllToolRenderers } from "../src/core/tools/renderers/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { fileIcon } from "../src/modes/interactive/file-icons.ts";
import { type IconName, icon, iconPrefix, setIconPreset } from "../src/modes/interactive/icons.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const tui = { requestRender() {} } as unknown as TUI;
const renderers = createAllToolRenderers();
const cases: { name: keyof typeof renderers; icon: IconName; args: Record<string, unknown> }[] = [
	{ name: "read", icon: "read", args: { path: "src/example.ts" } },
	{ name: "write", icon: "write", args: { path: "example.ts", content: "const value = 1;" } },
	{ name: "edit", icon: "edit", args: { path: "example.ts", edits: [] } },
	{ name: "bash", icon: "terminal", args: { command: "pwd" } },
	{ name: "powershell", icon: "terminal", args: { command: "Get-Location" } },
	{ name: "grep", icon: "search", args: { pattern: "value" } },
	{ name: "find", icon: "search", args: { pattern: "*.ts" } },
	{ name: "ls", icon: "folder", args: { path: "." } },
];

describe("chat action icons", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => setIconPreset("unicode"));

	test.each(cases)("prefixes $name with its semantic icon and updates existing rows", (item) => {
		setIconPreset("nerd");
		const component = new ToolExecutionComponent(
			item.name,
			`icon-${item.name}`,
			item.args,
			{},
			renderers[item.name],
			tui,
			process.cwd(),
		);
		const nerd = stripAnsi(component.render(100).join("\n"));
		const nerdPrefix = `${icon(item.icon)}${item.icon === "terminal" ? "  " : " "}`;
		expect(nerd.trimStart().startsWith(nerdPrefix)).toBe(true);
		expect(nerd.trimStart().startsWith(`${nerdPrefix} `)).toBe(false);

		setIconPreset("unicode");
		component.invalidate();
		const unicode = stripAnsi(component.render(100).join("\n"));
		expect(unicode.trimStart().startsWith(`${icon(item.icon)} `)).toBe(true);
		expect(unicode.trimStart().startsWith(`${icon(item.icon)}  `)).toBe(false);
		expect(unicode).not.toBe(nerd);
	});

	test.each(["read", "write", "edit", "ls"] as const)(
		"keeps %s icon-label pairs tight and header groups separate",
		(name) => {
			const path = "日本語 file.ts";
			const args = { path, content: "", edits: [] };
			const original = structuredClone(args);
			const component = new ToolExecutionComponent(
				name,
				`spacing-${name}`,
				args,
				{},
				renderers[name],
				tui,
				process.cwd(),
			);
			const actionIcon = name === "ls" ? "folder" : name;
			for (const preset of ["nerd", "unicode", "nerd"] as const) {
				setIconPreset(preset);
				component.invalidate();
				const glyph = fileIcon(path, name === "ls" ? "directory" : "file");
				const fileLabel = glyph ? `${glyph} ${path}` : path;
				const separator = name === "read" ? "  ·  " : "  ";
				expect(stripAnsi(component.render(120).join("\n"))).toContain(
					`${icon(actionIcon)} ${name}${separator}${fileLabel}`,
				);
				for (const width of [4, 8, 12, 30])
					for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			expect(args).toEqual(original);
		},
	);

	test("uses the eye glyph and separates the read action from the file label", () => {
		const component = new ToolExecutionComponent(
			"read",
			"read-eye-icon",
			{ path: "src/example.ts" },
			{},
			renderers.read,
			tui,
			process.cwd(),
		);
		for (const preset of ["nerd", "unicode", "nerd"] as const) {
			setIconPreset(preset);
			component.invalidate();
			const rendered = component.render(100).join("\n");
			const pathLabel = preset === "nerd" ? "\ue628 src/example.ts" : "src/example.ts";
			expect(stripAnsi(rendered)).toContain(`${icon("read")} read  ·  ${pathLabel}`);
			expect(stripAnsi(rendered)).not.toMatch(/[-—]/u);
			expect(rendered).toContain(
				`${theme.fg("toolTitle", theme.bold(`${iconPrefix("read")}read`))}${theme.fg("muted", "  ·  ")}`,
			);
			for (const width of [4, 8, 12, 30])
				for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(icon("read")).toBe("\u{f0208}");
	});

	test("uses a skill icon for compact instruction reads", () => {
		setIconPreset("nerd");
		const component = new ToolExecutionComponent(
			"read",
			"read-skill-icon",
			{ path: "/tmp/example/SKILL.md" },
			{},
			renderers.read,
			tui,
			process.cwd(),
		);
		expect(stripAnsi(component.render(100).join("\n"))).toContain(`${icon("skill")} [skill] example`);
	});

	test("prefixes unknown tools without a registered renderer", () => {
		setIconPreset("nerd");
		const component = new ToolExecutionComponent("custom", "custom-icon", {}, {}, undefined, tui, ".");
		expect(stripAnsi(component.render(100).join("\n"))).toContain(`${icon("tool")} custom`);
	});

	test.each(["bash", "powershell"] as const)(
		"keeps %s background job acknowledgments compact without claiming completion",
		(name) => {
			setIconPreset("nerd");
			const component = new ToolExecutionComponent(
				name,
				"background-icon",
				{ command: "npm run check", async: true, name: "Type check" },
				{},
				renderers[name],
				tui,
				".",
			);
			const output =
				"Job 12345678-abcd\nState: running\nFull output: /tmp/job.log\nUse jobs to inspect or control it.";
			component.updateResult({
				content: [{ type: "text", text: output }],
				details: { jobId: "12345678-abcd", jobState: "running" },
				isError: false,
			});
			const collapsed = stripAnsi(component.render(100).join("\n"));
			expect(collapsed).toContain(`${icon("job")}  Start background job · Type check`);
			for (const preset of ["unicode", "nerd"] as const) {
				setIconPreset(preset);
				component.invalidate();
				expect(stripAnsi(component.render(100).join("\n"))).toContain(`${iconPrefix("job")}Start background job`);
				for (const width of [4, 8, 12, 30])
					for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			expect(collapsed).toContain("Job 12345678 · running");
			expect(collapsed).not.toContain("completed");
			expect(collapsed).not.toContain("/tmp/job.log");
			component.setExpanded(true);
			expect(stripAnsi(component.render(100).join("\n"))).toContain("Full output: /tmp/job.log");
		},
	);
});
