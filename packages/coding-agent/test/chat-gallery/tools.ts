import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { renderJobsCall, renderJobsResult } from "../../src/core/jobs/render.ts";
import { renderSubagentCall, renderSubagentResult } from "../../src/core/subagents/render.ts";
import { renderTasksCall, renderTasksResult, taskStateText } from "../../src/core/tasks/render.ts";
import type { TaskSnapshot } from "../../src/core/tasks/state.ts";
import { createAllToolRenderers } from "../../src/core/tools/renderers/index.ts";
import { renderAskCall, renderAskResult } from "../../src/extensions/ask/render.ts";
import { codemodeRenderers } from "../../src/extensions/codemode/renderer.ts";
import { createMcpToolRenderers } from "../../src/extensions/mcp/tools.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";

const builtin = createAllToolRenderers();
const renderers = {
	...builtin,
	tasks: { renderCall: renderTasksCall, renderResult: renderTasksResult },
	ask: { renderCall: renderAskCall, renderResult: renderAskResult },
	jobs: { renderCall: renderJobsCall, renderResult: renderJobsResult },
	subagent: { renderCall: renderSubagentCall, renderResult: renderSubagentResult },
	codemode: codemodeRenderers,
	mcp__gallery__swatches: createMcpToolRenderers("gallery/swatches"),
	gallery_lookup: {},
	unknown_tool: undefined,
};

interface Fixture {
	tool: keyof typeof renderers;
	variant: string;
	args: Record<string, unknown>;
	content?: string | Array<TextContent | ImageContent>;
	details?: unknown;
	state?: "error" | "partial";
	durationMs?: number;
}

const sourcePath = "src/palette.ts";
const source = 'export const accent = "blue";';
const log = Array.from({ length: 12 }, (_, i) => `Swatch ${i + 1}: OK`).join("\n");
const id = "a24ec012-1234-4321-9876-123456789abc";
const snapshot: TaskSnapshot = {
	version: 1,
	revision: 2,
	nextId: 3,
	tasks: [
		{ id: 1, title: "Prepare palette", status: "completed" },
		{ id: 2, title: "Review contrast", status: "in_progress" },
	],
};
const fixtures: Fixture[] = [
	{ tool: "read", variant: "source range", args: { path: sourcePath, offset: 1, limit: 1 }, content: source },
	{
		tool: "read",
		variant: "skill",
		args: { path: "skills/review-preview/SKILL.md" },
		content: "---\nname: review-preview\ndescription: Review palette previews\n---\nCompare swatches at two widths.",
	},
	{
		tool: "read",
		variant: "embedded image",
		args: { path: "swatch.png" },
		content: [
			{
				type: "image",
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNo+A8AAgIBgG5WixMAAAAASUVORK5CYII=",
			},
		],
	},
	{
		tool: "read",
		variant: "error",
		args: { path: sourcePath, offset: 99 },
		content: "Offset 99 is beyond end of file (1 line total)",
		state: "error",
	},
	{ tool: "write", variant: "pending", args: { path: sourcePath, content: source } },
	{
		tool: "edit",
		variant: "recorded diff",
		args: { path: sourcePath, edits: [{ oldText: '"blue"', newText: '"teal"' }] },
		content: "Updated palette.ts",
		details: { diff: `-1 ${source}\n+1 export const accent = "teal";`, firstChangedLine: 1 },
	},
	{ tool: "bash", variant: "completed", args: { command: "npm run swatches" }, content: log, durationMs: 4200 },
	{
		tool: "bash",
		variant: "partial output",
		args: { command: "npm run swatches" },
		content: "Checking swatches…\nSwatch 1: OK",
		state: "partial",
	},
	{
		tool: "powershell",
		variant: "completed",
		args: { command: "Get-ChildItem -Name src" },
		content: "palette.ts\nswatches.ts",
		durationMs: 200,
	},
	{
		tool: "grep",
		variant: "matches",
		args: { pattern: "accent", path: "src", glob: "*.ts" },
		content: `palette.ts:1: ${source}\nswatches.ts:4: const selected = accent;\ntheme.ts:9: return accent;`,
	},
	{ tool: "find", variant: "matches", args: { pattern: "*.ts", path: "src" }, content: "palette.ts\nswatches.ts" },
	{ tool: "ls", variant: "directory", args: { path: "." }, content: "src/\ntest/\npackage.json" },
	{
		tool: "tasks",
		variant: "active task",
		args: { action: "list" },
		content: taskStateText(snapshot),
		details: { action: "list", snapshot },
	},
	{
		tool: "ask",
		variant: "submitted form",
		args: { html: '<form><label>Accent color<input name="accent" required></label></form>' },
		content: '{"accent":"teal"}',
		details: { kind: "submitted", answers: { accent: "teal" } },
	},
	{
		tool: "jobs",
		variant: "running",
		args: { action: "inspect", id },
		content: JSON.stringify(
			{
				job: {
					id,
					name: "Check swatches",
					command: "npm run swatches",
					runtime: { state: "running" },
					progress: { percent: 50, message: "Checking contrast" },
				},
			},
			null,
			2,
		),
	},
	{
		tool: "subagent",
		variant: "completed",
		args: { action: "result", id },
		content: JSON.stringify(
			{
				agent: { id, role: "reviewer", label: "Review palette", status: "completed" },
				text: "All swatches meet the contrast target.",
				truncated: false,
			},
			null,
			2,
		),
	},
	{
		tool: "codemode",
		variant: "nested call",
		args: { code: 'return await tools.ls({ path: "src" });' },
		content: [
			{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
			{ type: "text", text: "palette.ts\nswatches.ts" },
		],
		details: {
			calls: [{ id: "gallery-codemode/1", name: "ls", args: '{"path":"src"}', status: "ok", durationMs: 12 }],
		},
		durationMs: 100,
	},
	{
		tool: "mcp__gallery__swatches",
		variant: "result preview",
		args: { palette: "teal" },
		content: log,
		details: { server: "gallery", tool: "swatches" },
	},
	{ tool: "gallery_lookup", variant: "fallback preview", args: { query: "swatches" }, content: log },
	{ tool: "unknown_tool", variant: "unregistered fallback", args: { color: "teal" }, content: "Found one swatch." },
];

export function toolBlocks(tui: TUI, expanded: boolean): Array<[string, Component]> {
	return fixtures.map(({ tool, variant, args, content, details, state, durationMs }) => {
		const label = `${tool} · ${variant}`;
		const component = new ToolExecutionComponent(
			tool,
			`gallery-${label}`,
			args,
			{ showImages: false },
			renderers[tool],
			tui,
			"/gallery",
		);
		if (content !== undefined) {
			component.updateResult(
				{
					content: typeof content === "string" ? [{ type: "text", text: content }] : content,
					isError: state === "error",
					details,
					durationMs,
				},
				state === "partial",
			);
		}
		component.setExpanded(expanded);
		return [label, component];
	});
}
