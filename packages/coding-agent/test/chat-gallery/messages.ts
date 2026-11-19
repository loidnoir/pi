import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { type Component, Text, type TUI } from "@earendil-works/pi-tui";
import { renderJobMessage } from "../../src/core/jobs/render.ts";
import { renderSubagentMessage } from "../../src/core/subagents/render.ts";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../../src/modes/interactive/components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../../src/modes/interactive/components/compaction-summary-message.ts";
import { CustomEntryComponent } from "../../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../../src/modes/interactive/components/custom-message.ts";
import { SkillInvocationMessageComponent } from "../../src/modes/interactive/components/skill-invocation-message.ts";
import { UserMessageComponent } from "../../src/modes/interactive/components/user-message.ts";

const timestamp = Date.UTC(2025, 0, 1);

export function messageBlocks(tui: TUI, expanded: boolean): Array<[string, Component]> {
	const attachment = new UserMessageComponent([
		{ type: "text", text: "Compare this screenshot with the preview:" },
		{
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNo+A8AAgIBgG5WixMAAAAASUVORK5CYII=",
		},
	]);
	const reasoning = fauxAssistantMessage(
		[fauxThinking("Compare the **label** and image order."), fauxText("The label precedes the image.")],
		{ timestamp },
	);
	const streaming = new AssistantMessageComponent();
	streaming.updateContent(
		fauxAssistantMessage("Here is the layout so far:\n\n```ts\nconst width =", { timestamp }),
		true,
	);
	const skill = new SkillInvocationMessageComponent({
		name: "review-preview",
		location: "/fixtures/review-preview/SKILL.md",
		content: "Compare the preview at **two widths** and report any clipped text.",
		userMessage: undefined,
	});
	const entry = new CustomEntryComponent(
		{
			type: "custom",
			customType: "checkpoint",
			id: "preview-checkpoint",
			parentId: null,
			timestamp: new Date(timestamp).toISOString(),
			data: "Preview reviewed at both widths.",
		},
		(checkpoint, options, theme) =>
			new Text(
				theme.fg("customMessageLabel", `[${checkpoint.customType}]`) +
					(options.expanded ? ` ${checkpoint.data}` : ""),
				1,
				0,
			),
	);
	const custom = new CustomMessageComponent({
		role: "custom",
		customType: "review-note",
		content: "The **narrow preview** is ready to review.",
		display: true,
		timestamp,
	});
	const jobId = "f731c20e-aeac-45bf-8168-bcc268fdbcba";
	const job = new CustomMessageComponent(
		{
			role: "custom",
			customType: "background-job",
			content: `Background job ${jobId} ("Preview checks"): completed. Full output: /fixtures/preview.log`,
			details: { jobId, state: "completed" },
			display: true,
			timestamp,
		},
		renderJobMessage,
	);
	const agentId = "e47db150-36b1-4fdb-ba58-69f059d53205";
	const subagent = new CustomMessageComponent(
		{
			role: "custom",
			customType: "subagent-result",
			content: `Sub-agent ${agentId} (reviewer): Check the caption\nRun 1: completed.\nChild usage: input 120, output 18.\n\nThe caption fits at both widths.`,
			details: {
				id: agentId,
				run: 1,
				status: "completed",
				usage: { input: 120, output: 18, cacheRead: 0, cacheWrite: 0, cost: 0 },
			},
			display: true,
			timestamp,
		},
		renderSubagentMessage,
	);
	const branch = new BranchSummaryMessageComponent({
		role: "branchSummary",
		fromId: "preview-checkpoint",
		summary: "Compared the stacked and inline layouts. Kept the **stacked** layout for narrow screens.",
		timestamp,
	});
	const compaction = new CompactionSummaryMessageComponent({
		role: "compactionSummary",
		summary: "The preview layout is settled. Next: check the image caption at both widths.",
		tokensBefore: 12400,
		timestamp,
	});
	const bash = new BashExecutionComponent("seq 1 24", tui);
	bash.appendOutput(Array.from({ length: 24 }, (_, i) => String(i + 1)).join("\n"));
	bash.setComplete(0, false);
	const failedBash = new BashExecutionComponent("cat missing.txt", tui, true);
	failedBash.appendOutput("cat: missing.txt: No such file or directory");
	failedBash.setComplete(1, false);
	for (const component of [attachment, skill, entry, custom, job, subagent, branch, compaction, bash, failedBash]) {
		component.setExpanded(expanded);
	}
	return [
		["User", new UserMessageComponent("Review the **preview** and its `caption`.")],
		["User attachment", attachment],
		[
			"Assistant markdown",
			new AssistantMessageComponent(
				fauxAssistantMessage(
					[
						"## Preview",
						"> Keep the caption beside the image when space permits.",
						"- **Layout:** stacked\n- **Caption:** visible",
						"| Width | Layout |\n| --- | --- |\n| 48 | Stacked |\n| 80 | Inline |",
						"---",
						"See the [design notes](https://example.com/preview) for the `width` setting.",
						"```ts\nconst width = 80;\n```",
					].join("\n\n"),
					{
						timestamp,
					},
				),
			),
		],
		["Assistant streaming", streaming],
		["Assistant thinking", new AssistantMessageComponent(reasoning)],
		["Assistant hidden thinking", new AssistantMessageComponent(reasoning, true)],
		[
			"Assistant error",
			new AssistantMessageComponent(
				fauxAssistantMessage([], { stopReason: "error", errorMessage: "Preview service unavailable", timestamp }),
			),
		],
		[
			"Assistant aborted",
			new AssistantMessageComponent(
				fauxAssistantMessage("Checking the caption…", { stopReason: "aborted", timestamp }),
			),
		],
		[
			"Assistant truncated",
			new AssistantMessageComponent(
				fauxAssistantMessage("At the narrower width", { stopReason: "length", timestamp }),
			),
		],
		["Skill invocation", skill],
		["Custom entry", entry],
		["Custom message", custom],
		["Background job", job],
		["Subagent result", subagent],
		["Branch summary", branch],
		["Compaction summary", compaction],
		["Bash execution", bash],
		["Bash error (excluded from context)", failedBash],
	];
}
