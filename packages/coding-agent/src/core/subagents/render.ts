// Display native delegation controls and completion notices without changing their model-visible payloads.
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { icon } from "../../modes/interactive/icons.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { MessageRenderer, ToolRenderContext, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	ActionBlock,
	actionBlock,
	compactPreview,
	expandedResultText,
	resultText,
	stateColor,
	stateLabel,
} from "../jobs/action-block.ts";

const argsSchema = Type.Object({
	action: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	task: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const argsValidator = Compile(argsSchema);
const agentSchema = Type.Object({
	id: Type.String(),
	role: Type.String(),
	label: Type.String(),
	status: Type.String(),
	preview: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
});
const resultSchema = Type.Object({
	agent: Type.Optional(agentSchema),
	agents: Type.Optional(
		Type.Array(
			Type.Union([agentSchema, Type.Object({ name: Type.String(), description: Type.Optional(Type.String()) })]),
		),
	),
	errors: Type.Optional(Type.Array(Type.Object({ path: Type.String(), error: Type.String() }))),
	total: Type.Optional(Type.Number()),
	nextSkip: Type.Optional(Type.Number()),
	deleted: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	text: Type.Optional(Type.String()),
	truncated: Type.Optional(Type.Boolean()),
	offset: Type.Optional(Type.Number()),
	nextOffset: Type.Optional(Type.Number()),
	totalCharacters: Type.Optional(Type.Number()),
	notice: Type.Optional(Type.String()),
});
const resultValidator = Compile(resultSchema);

/** The subset of persisted native tool output used for display; original text remains authoritative. */
export type SubagentRenderResult = Static<typeof resultSchema>;

/** Render all native actions, including arguments still arriving from the provider. */
export function renderSubagentCall(
	args: unknown,
	theme: Theme,
	context: ToolRenderContext<unknown, unknown>,
): ActionBlock {
	// Renderer trust boundary: streamed arguments have not passed the tool's parameter schema yet.
	const input: Static<typeof argsSchema> = argsValidator.Check(args) ? args : {};
	const labels: Record<string, string> = {
		roles: "List agent roles",
		start: "Start sub-agent",
		list: "List sub-agents",
		inspect: "Inspect sub-agent",
		history: "Read agent history",
		result: "Read agent result",
		wait: "Wait for sub-agent",
		message: "Message sub-agent",
		resume: "Resume sub-agent",
		cancel: "Cancel sub-agent",
		delete: "Delete sub-agent",
	};
	return actionBlock(context, () => ({
		kind: "call",
		heading:
			theme.fg(
				"toolTitle",
				theme.bold(
					`${icon(input.action === "wait" ? "clock" : "agent")}  ${labels[input.action ?? ""] ?? "Sub-agent"}`,
				),
			) +
			theme.fg(
				"accent",
				input.action === "start"
					? ` · ${compactPreview(input.agent ?? "worker")}`
					: input.id
						? ` · ${input.id.slice(0, 8)}`
						: "",
			),
		preview: input.task ? theme.fg("muted", compactPreview(input.task)) : undefined,
		expandedText: context.expanded ? JSON.stringify(args, null, 2) : undefined,
	}));
}

/** Show actual child state and bounded evidence, with the original tool output available on expansion. */
export function renderSubagentResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<unknown, unknown>,
): ActionBlock {
	const raw = resultText(result);
	const output = decodeResult(raw);
	// Renderer trust boundary: results may follow rejected or incomplete streamed arguments.
	const args: Static<typeof argsSchema> = argsValidator.Check(context.args) ? context.args : {};
	return actionBlock(context, () => {
		const summary = summarize(
			output,
			args.action ?? undefined,
			args.id ?? undefined,
			raw,
			options.isPartial,
			context.isError || result.isError === true,
		);
		return {
			kind: "result",
			heading: theme.fg(summary.color, summary.heading),
			preview: theme.fg(summary.color === "error" ? "error" : "toolOutput", compactPreview(summary.preview)),
			expandedText: options.expanded ? expandedResultText(result) : undefined,
			hint: !options.expanded && raw ? theme.fg("dim", context.keyHint("app.tools.expand", "to expand")) : undefined,
		};
	});
}

/** Present automatic child results compactly while retaining the exact delivered content and metadata. */
export const renderSubagentMessage: MessageRenderer = (message, options, theme) => {
	const raw = contentText(message.content);
	const heading = /^Sub-agent (\S+) \(([^\n]*)\): ([^\n]*)/u.exec(raw);
	const status = /^Run \d+: ([^\n]+)\.$/mu.exec(raw)?.[1] ?? "unknown";
	const error = /^Error: ([^\n]*)/mu.exec(raw)?.[1];
	const bodyStart = raw.indexOf("\n\n");
	const preview = error
		? `Error: ${error}`
		: bodyStart >= 0
			? raw.slice(bodyStart + 2)
			: heading
				? "No result text"
				: raw;
	return new ActionBlock(
		() => ({
			kind: "message",
			heading:
				theme.fg(
					"customMessageLabel",
					theme.bold(`${icon("agent")}  Sub-agent${heading ? ` ${heading[1].slice(0, 8)}` : ""}`),
				) +
				theme.fg(stateColor(status), ` · ${stateLabel(status)}`) +
				(heading ? theme.fg("muted", ` · ${compactPreview(`${heading[2]}: ${heading[3]}`)}`) : ""),
			preview: theme.fg(error ? "error" : "customMessageText", compactPreview(preview)),
			expandedText: options.expanded
				? raw + (message.details === undefined ? "" : `\n\n${JSON.stringify(message.details, null, 2)}`)
				: undefined,
			hint: !options.expanded ? theme.fg("dim", options.keyHint("app.tools.expand", "to expand")) : undefined,
		}),
		options.outputPad,
		(text) => theme.bg("customMessageBg", text),
		1,
	);
};

function decodeResult(raw: string): SubagentRenderResult | undefined {
	try {
		// Renderer trust boundary: restored tool content is JSON text, not a typed in-process result.
		const value: unknown = JSON.parse(raw);
		return resultValidator.Check(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function summarize(
	output: SubagentRenderResult | undefined,
	action: string | undefined,
	id: string | undefined,
	raw: string,
	partial: boolean,
	isError: boolean,
): { heading: string; preview: string; color: ReturnType<typeof stateColor> } {
	if (isError) return { heading: "Sub-agent error", preview: raw || "No error details", color: "error" };
	if (output?.errors?.length)
		return {
			heading: "Agent definition errors",
			color: "error",
			preview: output.errors.map((error) => `${error.path}: ${error.error}`).join("\n"),
		};
	if (output?.agent) {
		const agent = output.agent;
		return {
			heading: `${stateLabel(agent.status)} · ${agent.role} ${agent.id.slice(0, 8)} · ${agent.label}`,
			preview: agent.error
				? `Error: ${agent.error}`
				: output.text !== undefined
					? output.text || "No result text"
					: output.task || agent.preview || output.notice || "",
			color: agent.error ? "error" : stateColor(agent.status),
		};
	}
	if (output?.agents) {
		const failed = output.agents.find(
			(agent): agent is Static<typeof agentSchema> =>
				"status" in agent && (Boolean(agent.error) || stateColor(agent.status) === "error"),
		);
		return {
			heading: output.agents.length
				? `${output.total ?? output.agents.length} ${action === "roles" ? "agent roles" : "sub-agents"}${output.nextSkip === undefined ? "" : " · more available"}${failed ? " · errors" : ""}`
				: action === "roles"
					? "No agent roles"
					: "No sub-agents",
			preview: failed
				? `${failed.id.slice(0, 8)} · ${failed.status} · ${failed.label}${failed.error ? ` · Error: ${failed.error}` : ""}`
				: output.agents
						.slice(0, 3)
						.map((agent) =>
							"name" in agent
								? `${agent.name}${agent.description ? ` — ${agent.description}` : ""}`
								: `${agent.id.slice(0, 8)} · ${agent.status} · ${agent.label}`,
						)
						.join("\n"),
			color: failed ? "error" : "muted",
		};
	}
	if (output?.deleted)
		return { heading: `Deleted sub-agent ${output.deleted.slice(0, 8)}`, preview: "", color: "success" };
	if (output?.text !== undefined)
		return {
			heading: `Agent history${id ? ` ${id.slice(0, 8)}` : ""}${output.nextOffset === undefined ? "" : " · more available"}`,
			preview: output.text || "No history text",
			color: "muted",
		};
	return {
		heading: partial ? "Waiting for sub-agent…" : raw ? "Unrecognized sub-agent result" : "No sub-agent output",
		preview: output ? "Expand to inspect original output" : raw,
		color: partial ? "accent" : "warning",
	};
}
