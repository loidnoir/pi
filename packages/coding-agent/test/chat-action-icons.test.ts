import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createAllToolRenderers } from "../src/core/tools/renderers/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { type IconName, icon, setIconPreset } from "../src/modes/interactive/icons.ts";
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
		expect(nerd.trimStart().startsWith(`${icon(item.icon)}  `)).toBe(true);

		setIconPreset("unicode");
		component.invalidate();
		const unicode = stripAnsi(component.render(100).join("\n"));
		expect(unicode.trimStart().startsWith(`${icon(item.icon)}  `)).toBe(true);
		expect(unicode).not.toBe(nerd);
	});

	test("uses the eye glyph and separates the read action from the file label", () => {
		setIconPreset("nerd");
		const component = new ToolExecutionComponent(
			"read",
			"read-eye-icon",
			{ path: "src/example.ts" },
			{},
			renderers.read,
			tui,
			process.cwd(),
		);
		expect(icon("read")).toBe("\u{f0208}");
		const rendered = component.render(100).join("\n");
		expect(stripAnsi(rendered)).toContain(`${icon("read")}  read — \ue628  src/example.ts`);
		expect(rendered).toContain(theme.fg("muted", " — "));
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
		expect(stripAnsi(component.render(100).join("\n"))).toContain(`${icon("skill")}  [skill] example`);
	});

	test("prefixes unknown tools without a registered renderer", () => {
		setIconPreset("nerd");
		const component = new ToolExecutionComponent("custom", "custom-icon", {}, {}, undefined, tui, ".");
		expect(stripAnsi(component.render(100).join("\n"))).toContain(`${icon("tool")}  custom`);
	});

	test("keeps background job acknowledgments compact without claiming completion", () => {
		setIconPreset("nerd");
		const component = new ToolExecutionComponent(
			"bash",
			"background-icon",
			{ command: "npm run check", async: true, name: "Type check" },
			{},
			renderers.bash,
			tui,
			".",
		);
		const output = "Job 12345678-abcd\nState: running\nFull output: /tmp/job.log\nUse jobs to inspect or control it.";
		component.updateResult({
			content: [{ type: "text", text: output }],
			details: { jobId: "12345678-abcd", jobState: "running" },
			isError: false,
		});
		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain(`${icon("job")}  Start background job · Type check`);
		expect(collapsed).toContain("Job 12345678 · running");
		expect(collapsed).not.toContain("completed");
		expect(collapsed).not.toContain("/tmp/job.log");
		component.setExpanded(true);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("Full output: /tmp/job.log");
	});
});
