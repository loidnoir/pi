import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { MessageRenderOptions, ToolRenderContext } from "../src/core/extensions/types.ts";
import { ActionBlock } from "../src/core/jobs/action-block.ts";
import { renderJobMessage, renderJobsCall, renderJobsResult } from "../src/core/jobs/render.ts";
import { createJobsToolDefinition } from "../src/core/jobs/tool.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { renderSubagentCall, renderSubagentMessage, renderSubagentResult } from "../src/core/subagents/render.ts";
import { createSubagentToolDefinition } from "../src/core/subagents/tool.ts";
import { createJobsExtension } from "../src/extensions/jobs/index.ts";
import { createSubagentExtension } from "../src/extensions/subagents/index.ts";
import { icon, setIconPreset } from "../src/modes/interactive/icons.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const id = "12345678-1234-1234-1234-123456789abc";
const agent = { id, role: "worker", label: "Fix renderer", status: "running", preview: "Reading source" };
const job = { id, name: "Type check", command: "npm run check", runtime: { state: "running" } };

function context(
	args: unknown = {},
	changes: Partial<ToolRenderContext<unknown, unknown>> = {},
): ToolRenderContext<unknown, unknown> {
	return {
		args,
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		keyText: () => "alt+e",
		keyHint: (_key, description) => `alt+e ${description}`,
		...changes,
	};
}

function output(value: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: {} };
}

function text(component: Component, width = 180): string {
	return stripVTControlCharacters(component.render(width).join("\n"))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function message(content: string, customType: string, details: unknown = {}): CustomMessage {
	return { role: "custom", customType, content, details, display: true, timestamp: 0 };
}

function messageOptions(expanded = false): MessageRenderOptions {
	return { expanded, outputPad: 2, keyText: () => "alt+e", keyHint: (_key, description) => `alt+e ${description}` };
}

beforeAll(() => initTheme("dark"));
afterEach(() => setIconPreset("unicode"));

describe("sub-agent presentation", () => {
	it.each([
		["roles", "List agent roles"],
		["start", "Start sub-agent"],
		["list", "List sub-agents"],
		["inspect", "Inspect sub-agent"],
		["history", "Read agent history"],
		["result", "Read agent result"],
		["wait", "Wait for sub-agent"],
		["message", "Message sub-agent"],
		["resume", "Resume sub-agent"],
		["cancel", "Cancel sub-agent"],
		["delete", "Delete sub-agent"],
	])("renders the %s call without JSON", (action, label) => {
		const rendered = text(
			renderSubagentCall({ action, id, agent: "scout", task: "Inspect parser", async: true }, theme, context()),
		);
		expect(rendered).toContain(label);
		expect(rendered).toContain(action === "start" ? "scout" : id.slice(0, 8));
		expect(rendered).toContain("Inspect parser");
		expect(rendered).not.toContain("{");
		expect(rendered).not.toContain("Completed");
	});

	it.each([undefined, null, [], "partial", {}, { action: "sta" }, { action: 1 }, { action: "start", task: {} }])(
		"handles incomplete or malformed streamed arguments: %j",
		(args) => {
			expect(text(renderSubagentCall(args, theme, context(args, { argsComplete: false })), 30)).toContain(
				"Sub-agent",
			);
		},
	);

	it.each(["unicode", "nerd"] as const)("uses a clock for waiting calls in %s", (preset) => {
		setIconPreset(preset);
		const args = { action: "wait", id };
		const before = JSON.stringify(args);
		const component = renderSubagentCall(args, theme, context(args));
		expect(text(component)).toContain(`${icon("clock")}  Wait for sub-agent`);
		for (const line of component.render(20)) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(JSON.stringify(args)).toBe(before);
	});

	it("retains useful streamed arguments when strict providers include null optionals", () => {
		const args = { action: "start", agent: "reviewer", task: "Review", id: null, context: null, async: true };
		const rendered = text(renderSubagentCall(args, theme, context(args, { argsComplete: false })));
		expect(rendered).toContain("Start sub-agent · reviewer");
		expect(rendered).toContain("Review");
		const inspected = text(
			renderSubagentResult(
				output({ agents: [] }),
				{ expanded: false, isPartial: false },
				theme,
				context({ action: "roles", id: null, task: null, agent: null }),
			),
		);
		expect(inspected).toContain("No agent roles");
	});

	it("reuses the streaming call component and expands the original arguments", () => {
		const first = renderSubagentCall({}, theme, context());
		const args = { action: "start", agent: "scout", task: "Read source", context: "original background" };
		const updated = renderSubagentCall(args, theme, context(args, { lastComponent: first, expanded: true }));
		expect(updated).toBe(first);
		expect(text(updated)).toContain(JSON.stringify(args, null, 2));
	});

	it.each(["queued", "running", "completed", "failed", "stopped", "interrupted", "paused", "future_state"])(
		"shows actual %s state",
		(status) => {
			const rendered = text(
				renderSubagentResult(
					output({ agent: { ...agent, status }, text: "Child answer", truncated: false }),
					{ expanded: false, isPartial: false },
					theme,
					context(),
				),
			);
			expect(rendered.toLowerCase()).toContain(status.replaceAll("_", " "));
			expect(rendered).toContain("Child answer");
			expect(rendered).toContain("alt+e to expand");
			if (status !== "completed") expect(rendered).not.toContain("Completed");
		},
	);

	it.each(["start", "resume", "inspect", "result", "wait", "message", "cancel"])(
		"renders %s results using the returned agent state",
		(action) => {
			const rendered = text(
				renderSubagentResult(
					output({ agent, notice: "Submitted; this is not a completion result." }),
					{ expanded: false, isPartial: action === "start" },
					theme,
					context({ action, id }),
				),
			);
			expect(rendered).toContain("Running");
			expect(rendered).toContain("Fix renderer");
			expect(rendered).not.toContain("Completed");
		},
	);

	it("renders roles, lists, history and deletion", () => {
		const render = (value: unknown, action: string) =>
			text(
				renderSubagentResult(output(value), { expanded: false, isPartial: false }, theme, context({ action, id })),
			);
		expect(
			render({ agents: [{ name: "scout", description: "Read source" }], total: 4, nextSkip: 1 }, "roles"),
		).toContain("4 agent roles · more available\nscout — Read source");
		expect(render({ agents: [agent], total: 1 }, "list")).toContain(
			"1 sub-agents\n12345678 · running · Fix renderer",
		);
		expect(
			render({ text: "Original child history", offset: 0, nextOffset: 22, totalCharacters: 50 }, "history"),
		).toContain("Agent history 12345678 · more available\nOriginal child history");
		expect(render({ deleted: id }, "delete")).toContain("Deleted sub-agent 12345678");
		expect(render({ agents: [] }, "roles")).toContain("No agent roles");
		expect(render({ agents: [] }, "list")).toContain("No sub-agents");
	});

	it("keeps definition and child errors visible while collapsed", () => {
		const render = (value: unknown) =>
			text(renderSubagentResult(output(value), { expanded: false, isPartial: false }, theme, context()));
		expect(render({ errors: [{ path: "role.md", error: "Invalid role" }], agents: [] })).toContain(
			"role.md: Invalid role",
		);
		expect(render({ agent: { ...agent, status: "failed", error: "Provider disconnected" } })).toContain(
			"Error: Provider disconnected",
		);
	});

	it("surfaces errors beyond the list preview and distinguishes an empty final answer", () => {
		const render = (value: unknown) =>
			text(
				renderSubagentResult(
					output(value),
					{ expanded: false, isPartial: false },
					theme,
					context({ action: "list" }),
				),
			);
		expect(
			render({ agents: [agent, agent, agent, { ...agent, status: "failed", error: "Late child error" }] }),
		).toContain("4 sub-agents · errors\n12345678 · failed · Fix renderer · Error: Late child error");
		expect(render({ agent: { ...agent, status: "completed" }, text: "", truncated: false })).toContain(
			"No result text",
		);
	});

	it("bounds previews by terminal lines and reveals original output and details on expansion", () => {
		const result = output({ agent, text: "Long child evidence ".repeat(200), truncated: false });
		result.details = { evidence: "/tmp/original.jsonl" };
		const before = JSON.stringify(result);
		const collapsed = renderSubagentResult(result, { expanded: false, isPartial: false }, theme, context());
		expect(collapsed.render(24)).toHaveLength(5);
		for (const line of collapsed.render(24)) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		const expanded = renderSubagentResult(result, { expanded: true, isPartial: false }, theme, context());
		expect(text(expanded, 10000)).toContain(result.content[0].type === "text" ? result.content[0].text : "");
		expect(text(expanded, 10000)).toContain('"evidence": "/tmp/original.jsonl"');
		expect(JSON.stringify(result)).toBe(before);
	});
});

describe("job presentation", () => {
	it.each([
		["list", "List jobs"],
		["inspect", "Inspect job"],
		["logs", "Read job logs"],
		["stop", "Stop job"],
		["rename", "Rename job"],
		["restart", "Restart job"],
		["delete", "Delete job"],
	])("renders the %s action with a short target", (action, label) => {
		const rendered = text(renderJobsCall({ action, id }, theme, context()));
		expect(rendered).toContain(`${label} · 12345678`);
		expect(rendered).not.toContain("{");
	});

	it.each([undefined, null, [], "partial", {}, { action: "res" }, { command: {} }, { action: 1 }])(
		"handles incomplete job arguments: %j",
		(args) => {
			expect(text(renderJobsCall(args, theme, context(args, { argsComplete: false })), 30)).toContain("Jobs");
		},
	);

	it("retains the action when strict providers include null optionals", () => {
		const args = { action: "list", id: null, name: null, command: null, all: null };
		expect(text(renderJobsCall(args, theme, context(args, { argsComplete: false })))).toContain("List jobs");
		expect(
			text(renderJobsCall({ ...args, action: "restart", id, command: "node test.js" }, theme, context())),
		).toContain("Restart job · 12345678\n\nnode test.js");
	});

	it("shows rename, replacement command and project scope", () => {
		expect(text(renderJobsCall({ action: "rename", id, name: "Renderer tests" }, theme, context()))).toContain(
			"Renderer tests",
		);
		expect(text(renderJobsCall({ action: "restart", id, command: "node test.js" }, theme, context()))).toContain(
			"node test.js",
		);
		expect(text(renderJobsCall({ action: "list", all: true }, theme, context()))).toContain("all projects");
	});

	it.each([
		"starting",
		"running",
		"completed",
		"failed",
		"stopped",
		"timed_out",
		"lost",
		"unreachable",
		"future_state",
	])("renders actual %s worker state", (state) => {
		const rendered = text(
			renderJobsResult(
				output({ job: { ...job, runtime: { state } } }),
				{ expanded: false, isPartial: false },
				theme,
				context(),
			),
		);
		expect(rendered.toLowerCase()).toContain(state.replaceAll("_", " "));
		expect(rendered).toContain("Type check");
		expect(rendered).toContain("npm run check");
		if (state !== "completed") expect(rendered).not.toContain("Completed");
	});

	it("shows progress, exit code and log previews", () => {
		const result = output({
			job: {
				...job,
				progress: { percent: 42, message: "Checking source" },
				runtime: { state: "failed", exitCode: 2 },
			},
			log: { text: "Type error at file.ts:12", path: "/tmp/log", truncated: true },
		});
		const rendered = text(renderJobsResult(result, { expanded: false, isPartial: false }, theme, context()));
		expect(rendered).toContain("42% Checking source · exit 2");
		expect(rendered).toContain("Type error at file.ts:12");
	});

	it.each(["inspect", "logs", "stop", "rename", "restart"])(
		"renders %s results without inventing completion",
		(action) => {
			const rendered = text(
				renderJobsResult(output({ job }), { expanded: false, isPartial: false }, theme, context({ action, id })),
			);
			expect(rendered).toContain("Running");
			expect(rendered).not.toContain("Completed");
		},
	);

	it("renders lists, deletion and empty logs", () => {
		const render = (value: unknown) =>
			text(renderJobsResult(output(value), { expanded: false, isPartial: false }, theme, context()));
		expect(render({ jobs: [job] })).toContain("1 background jobs\n12345678 · running · Type check");
		expect(render({ jobs: [] })).toContain("No background jobs");
		expect(render({ deleted: id })).toContain("Deleted job 12345678");
		expect(
			text(
				renderJobsResult(
					{ content: [{ type: "text", text: `Deleted job ${id} and its logs` }], details: {} },
					{ expanded: false, isPartial: false },
					theme,
					context({ action: "delete", id }),
				),
			),
		).toContain("Deleted job 12345678");
		expect(render({ job, log: { text: "", path: "/tmp/log", truncated: false } })).toContain("No log output");
	});

	it("keeps runtime and progress errors visible", () => {
		const render = (value: unknown) =>
			text(renderJobsResult(output(value), { expanded: false, isPartial: false }, theme, context()));
		expect(render({ job: { ...job, runtime: { state: "unreachable", error: "Worker unavailable" } } })).toContain(
			"Error: Worker unavailable",
		);
		expect(render({ job: { ...job, progressError: "Invalid progress report" } })).toContain(
			"Error: Invalid progress report",
		);
	});

	it("surfaces errors beyond the list preview", () => {
		const result = output({
			jobs: [job, job, job, { ...job, runtime: { state: "failed", error: "Late worker error" } }],
		});
		expect(text(renderJobsResult(result, { expanded: false, isPartial: false }, theme, context()))).toContain(
			"4 background jobs · errors\n12345678 · failed · Type check · Error: Late worker error",
		);
	});

	it("reuses components and preserves full text, details and structured data", () => {
		const result = output({ job, log: { text: "log output ".repeat(200), path: "/tmp/log", truncated: false } });
		result.details = { jobId: id, jobState: "running" };
		result.structuredContent = { original: true };
		const before = JSON.stringify(result);
		const collapsed = renderJobsResult(result, { expanded: false, isPartial: false }, theme, context());
		expect(collapsed.render(20)).toHaveLength(5);
		const expanded = renderJobsResult(
			result,
			{ expanded: true, isPartial: false },
			theme,
			context({}, { lastComponent: collapsed }),
		);
		expect(expanded).toBe(collapsed);
		expect(text(expanded, 10000)).toContain(result.content[0].type === "text" ? result.content[0].text : "");
		expect(text(expanded, 10000)).toContain('"jobState": "running"');
		expect(text(expanded, 10000)).toContain('"original": true');
		expect(JSON.stringify(result)).toBe(before);
	});
});

describe("native action section spacing", () => {
	it.each([
		{
			name: "sub-agent launch",
			call: renderSubagentCall,
			result: renderSubagentResult,
			args: { action: "start", agent: "worker", task: "Review parser behavior" },
			value: {
				agent: { ...agent, status: "queued", label: "Review parser behavior", preview: "" },
				notice: "Submitted; this is not a completion result.",
			},
			title: () => `${icon("agent")}  Start sub-agent · worker`,
			description: "Review parser behavior",
			status: "Queued · worker 12345678 · Review parser behavior",
			preview: "Submitted; this is not a completion result.",
		},
		{
			name: "job restart",
			call: renderJobsCall,
			result: renderJobsResult,
			args: { action: "restart", id, command: "node test.js" },
			value: { job: { ...job, command: "node test.js", runtime: { state: "starting" } } },
			title: () => `${icon("job")}  Restart job · 12345678`,
			description: "node test.js",
			status: "Starting · 12345678 · Type check",
			preview: "node test.js",
		},
	])("separates the $name title, description, and status controls", (entry) => {
		const call = entry.call(entry.args, theme, context(entry.args));
		const result = entry.result(
			output(entry.value),
			{ expanded: false, isPartial: false },
			theme,
			context(entry.args),
		);
		const lines = stripVTControlCharacters([...call.render(180), ...result.render(180)].join("\n"))
			.split("\n")
			.map((line) => line.trimEnd());
		expect(lines).toEqual([entry.title(), "", entry.description, "", entry.status, entry.preview, "alt+e to expand"]);
	});

	it("omits missing call descriptions but separates message controls from their heading", () => {
		const call = renderJobsCall({ action: "inspect", id }, theme, context());
		expect(call.render(180)).toHaveLength(1);
		const notice = new ActionBlock(() => ({ kind: "message", heading: "Job · Completed", hint: "alt+e to expand" }));
		expect(text(notice)).toBe("Job · Completed\n\nalt+e to expand");
	});

	it("keeps an expanded action heading separate from original content", () => {
		const args = { action: "start", task: "Review parser behavior" };
		const call = renderSubagentCall(args, theme, context(args, { expanded: true }));
		expect(text(call)).toContain(`Start sub-agent · worker\n\n${JSON.stringify(args, null, 2)}`);
		const result = output({ agent, text: "Original evidence", truncated: false });
		const expanded = renderSubagentResult(result, { expanded: true, isPartial: false }, theme, context(args));
		expect(text(expanded)).toContain(
			`Running · worker 12345678 · Fix renderer\n\n${JSON.stringify({ agent, text: "Original evidence", truncated: false }, null, 2)}`,
		);
	});
});

describe("native renderer fallbacks and integration", () => {
	it.each([0, 1, 2, 3, 8, 30])("fits width %s with output padding and wide text", (width) => {
		for (const outputPad of [0, 1, 2, 4]) {
			for (const expanded of [false, true]) {
				const block = new ActionBlock(
					() => ({
						kind: "message",
						heading: "Job · 実行中",
						preview: "A wide preview 日本語 text",
						expandedText: expanded ? "Original 日本語 details" : undefined,
						hint: "alt+e to expand",
					}),
					outputPad,
				);
				const rows = block.render(width);
				if (width === 0) expect(rows).toEqual([]);
				for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				if (width >= 30) expect(text(block, width)).toContain("Job");
			}
		}
	});

	it.each([renderSubagentResult, renderJobsResult])("handles empty, unknown, partial and error results", (render) => {
		const result = { content: [], details: {} };
		expect(text(render(result, { expanded: false, isPartial: true }, theme, context()))).toContain("Waiting");
		expect(text(render(result, { expanded: false, isPartial: false }, theme, context()))).toContain("output");
		expect(
			text(render(output({ unexpected: true }), { expanded: false, isPartial: false }, theme, context())),
		).toContain("Unrecognized");
		const error = { content: [{ type: "text" as const, text: "Permission denied" }], details: {} };
		expect(
			text(render(error, { expanded: false, isPartial: false }, theme, context({}, { isError: true }))),
		).toContain("Permission denied");
		expect(
			text(render({ ...error, isError: true }, { expanded: false, isPartial: false }, theme, context())),
		).toContain("error");
	});

	it("wires native tools and automatic message renderers without broad tool interception", async () => {
		expect(createJobsToolDefinition("/").renderCall).toBe(renderJobsCall);
		expect(createJobsToolDefinition("/").renderResult).toBe(renderJobsResult);
		const subagents = createSubagentToolDefinition(
			() => {
				throw new Error("Not used by presentation");
			},
			"/",
			() => {},
		);
		expect(subagents.renderCall).toBe(renderSubagentCall);
		expect(subagents.renderResult).toBe(renderSubagentResult);
		const runtime = createExtensionRuntime();
		const bus = createEventBus();
		const agentsExtension = await loadExtensionFromFactory(createSubagentExtension("/"), "/", bus, runtime);
		const jobsExtension = await loadExtensionFromFactory(createJobsExtension(), "/", bus, runtime);
		expect(agentsExtension.messageRenderers.get("subagent-result")).toBe(renderSubagentMessage);
		expect(jobsExtension.messageRenderers.get("background-job")).toBe(renderJobMessage);
		expect(agentsExtension.toolRenderers ?? []).toHaveLength(0);
		expect(jobsExtension.toolRenderers ?? []).toHaveLength(0);
	});

	it.each([renderSubagentCall, renderJobsCall])("updates existing call icons after preset invalidation", (render) => {
		setIconPreset("unicode");
		const block = render({ action: "inspect", id }, theme, context());
		const before = text(block);
		setIconPreset("nerd");
		block.invalidate();
		const after = text(block);
		expect(after).not.toBe(before);
		expect(after).toContain(render === renderSubagentCall ? icon("agent") : icon("job"));
	});
});

describe("automatic completion presentation", () => {
	const agentContent = `Sub-agent ${id} (reviewer): Review renderer\nRun 1: completed.\nChild usage: input 10, output 20.\nIndependent history: /tmp/agent.jsonl\n\nFound a rendering bug.\n${"Original evidence ".repeat(100)}`;
	const jobContent = `Background job ${id} (${JSON.stringify("Renderer checks")}): failed. Full output: /tmp/job.log`;

	it.each([false, true])("pads job and agent messages like built-in blocks (expanded=%s)", (expanded) => {
		for (const outputPad of [0, 1, 3]) {
			for (const [render, content] of [
				[renderSubagentMessage, agentContent],
				[renderJobMessage, jobContent],
			] as const) {
				const notice = message(content, "notice");
				const original = JSON.stringify(notice);
				const block = render(notice, { ...messageOptions(expanded), outputPad }, theme)!;
				const lines = block.render(120);
				expect(stripVTControlCharacters(lines[0]).trim()).toBe("");
				expect(stripVTControlCharacters(lines.at(-1)!).trim()).toBe("");
				expect(stripVTControlCharacters(lines[1]).startsWith(" ".repeat(outputPad))).toBe(true);
				for (const width of [0, 1, 2, 8, 30])
					for (const line of block.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(JSON.stringify(notice)).toBe(original);
			}
		}
	});

	it("shows agent state, task and bounded answer preview, preserving full content expanded", () => {
		const notice = message(agentContent, "subagent-result", { id, run: 1, status: "completed" });
		const before = JSON.stringify(notice);
		const collapsed = renderSubagentMessage(notice, messageOptions(), theme)!;
		expect(text(collapsed)).toContain("Sub-agent 12345678 · Completed · reviewer: Review renderer");
		expect(text(collapsed)).toContain("Found a rendering bug.");
		const lines = text(collapsed)
			.split("\n")
			.map((line) => line.trim());
		expect(lines[1]).toBe("");
		expect(lines[2]).toBe("Found a rendering bug.");
		expect(lines.at(-1)).toBe("alt+e to expand");
		expect(collapsed.render(30)).toHaveLength(7);
		expect(text(collapsed)).not.toContain("Independent history");
		expect(text(renderSubagentMessage(notice, { ...messageOptions(true), outputPad: 0 }, theme)!, 10000)).toContain(
			agentContent.trimEnd(),
		);
		expect(text(renderSubagentMessage(notice, messageOptions(true), theme)!)).toContain('"run": 1');
		expect(JSON.stringify(notice)).toBe(before);
	});

	it("keeps automatic failure details visible", () => {
		const content = `Sub-agent ${id} (worker): Fix bug\nRun 1: failed.\nChild usage: input 0, output 0.\nError: Provider unavailable\n\nNo answer`;
		const rendered = text(renderSubagentMessage(message(content, "subagent-result"), messageOptions(), theme)!);
		expect(rendered).toContain("Failed");
		expect(rendered).toContain("Error: Provider unavailable");
	});

	it("shows job state, name and output location without claiming completion", () => {
		const notice = message(jobContent, "background-job", { jobId: id, state: "failed" });
		const before = JSON.stringify(notice);
		const rendered = text(renderJobMessage(notice, messageOptions(), theme)!);
		expect(rendered).toContain("Job 12345678 · Failed · Renderer checks");
		expect(rendered).toContain("Full output: /tmp/job.log");
		expect(rendered.split("\n").map((line) => line.trim())).toEqual([
			`${icon("job")}  Job 12345678 · Failed · Renderer checks`,
			"",
			"Full output: /tmp/job.log",
			"alt+e to expand",
		]);
		expect(rendered).not.toContain("Completed");
		expect(text(renderJobMessage(notice, messageOptions(true), theme)!)).toContain(jobContent);
		expect(JSON.stringify(notice)).toBe(before);
	});

	it.each([renderSubagentMessage, renderJobMessage])(
		"handles empty or unfamiliar notices and refreshes icons",
		(render) => {
			expect(text(render(message("", "notice"), messageOptions(), theme)!)).toContain("Unknown");
			expect(text(render(message("Unexpected evidence", "notice"), messageOptions(), theme)!)).toContain(
				"Unexpected evidence",
			);
			setIconPreset("unicode");
			const component = render(
				message(render === renderSubagentMessage ? agentContent : jobContent, "notice"),
				messageOptions(),
				theme,
			)!;
			const before = text(component);
			setIconPreset("nerd");
			component.invalidate();
			expect(text(component)).not.toBe(before);
		},
	);
});
