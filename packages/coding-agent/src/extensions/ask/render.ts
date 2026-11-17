import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import {
	type FormAnswers,
	type FormField,
	initialFormValues,
	parseQuestionForm,
	type QuestionForm,
} from "../../core/ask/form.ts";
import type { FormResult } from "../../core/ask/view.ts";
import type { ToolRenderContext, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import { iconPrefix } from "../../modes/interactive/icons.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

type Preview = { html: string; form?: QuestionForm; error?: string };
type AskRenderState = { askPreview?: Preview };
type AskRenderContext = ToolRenderContext<AskRenderState, unknown>;

export function renderAskCall(_args: unknown, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", theme.bold(`${iconPrefix("question")}ask`)), 0, 0);
}

export function renderAskResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AskRenderContext,
): Container {
	const container = new Container();
	if (options.isPartial) return container;
	const form = preview(context.args, context.state);
	if (context.isError) {
		container.addChild(new Text(theme.fg("error", "Error — no answers submitted"), 0, 0));
		for (const block of result.content)
			if (block.type === "text") container.addChild(new Text(theme.fg("error", cleanText(block.text)), 0, 0));
		renderForm(container, form, options.expanded, theme);
		return container;
	}
	const outcome = readOutcome(result.details);
	container.addChild(
		new Text(
			theme.fg(
				outcome?.kind === "submitted" ? "success" : "warning",
				outcome?.kind === "submitted"
					? `${iconPrefix("submit")}Submitted`
					: outcome?.kind === "cancelled"
						? `${iconPrefix("checkboxCancelled")}Cancelled — no answers submitted`
						: "Result unavailable — no submitted answers recorded",
			),
			0,
			0,
		),
	);
	const answers = outcome?.kind === "submitted" ? outcome.answers : undefined;
	renderForm(container, form, options.expanded, theme, answers);
	if (!form.form && answers) {
		for (const [name, answer] of Object.entries(answers))
			container.addChild(new Text(`${cleanText(name)} — Answer: ${formatAnswer(answer)}`, 0, 0));
	}
	return container;
}

function preview(args: unknown, state: AskRenderState): Preview {
	const html = args && typeof args === "object" && "html" in args ? args.html : undefined;
	if (typeof html !== "string" || !html.trim()) return { html: "", error: "Waiting for form HTML" };
	if (state.askPreview?.html === html) return state.askPreview;
	try {
		state.askPreview = { html, form: parseQuestionForm(html) };
	} catch (error) {
		state.askPreview = { html, error: error instanceof Error ? error.message : String(error) };
	}
	return state.askPreview;
}

function renderForm(
	container: Container,
	preview: Preview,
	expanded: boolean,
	theme: Theme,
	answers?: FormAnswers,
): void {
	const form = preview.form;
	if (!form) {
		container.addChild(
			new Text(theme.fg("muted", `Form preview unavailable: ${cleanText(preview.error ?? "")}`), 0, 0),
		);
		return;
	}
	const defaults = expanded ? initialFormValues(form) : undefined;
	const renderField = (index: number) => {
		const field = form.fields[index];
		container.addChild(new Text(theme.fg("accent", theme.bold(`${index + 1}. ${cleanText(field.label)}`)), 0, 0));
		const choice = field.kind === "radio" || field.kind === "checkbox" || field.kind === "select";
		const choiceLabels = field.options.map((option) => {
			const label = cleanText(option.label);
			return field.options.some((other) => other.value !== option.value && cleanText(other.label) === label)
				? `${label} (value: ${cleanText(option.value)})`
				: label;
		});
		if (choice) {
			const choices = [...choiceLabels];
			if (field.kind !== "checkbox" || field.options.length > 1) choices.push("Other (type your own)");
			container.addChild(
				new Text(theme.fg("muted", `Choices:${choices.length ? formatItems(choices) : " (none)"}`), 0, 0),
			);
		}
		if (answers) {
			const answer = Object.hasOwn(answers, field.name) ? answers[field.name] : undefined;
			container.addChild(
				new Text(
					theme.fg(
						answer === undefined ? "muted" : "toolOutput",
						answer === undefined ? "Answer: (skipped)" : `Answer: ${formatAnswer(answer, field)}`,
					),
					0,
					0,
				),
			);
		}
		if (!expanded) return;
		const constraints = [field.required ? "required" : "optional", field.kind];
		if (field.multiple && !(field.kind === "checkbox" && field.options.length === 1))
			constraints.push("multiple selections");
		for (const [label, value] of [
			["min", field.min],
			["max", field.max],
			["step", field.step],
			["min length", field.minLength],
			["max length", field.maxLength],
			["pattern", field.pattern],
		] as const)
			if (value !== undefined) constraints.push(`${label}: ${cleanText(String(value))}`);
		container.addChild(new Text(theme.fg("dim", constraints.join(" · ")), 0, 0));
		if (field.placeholder)
			container.addChild(new Text(theme.fg("dim", `Placeholder: ${cleanText(field.placeholder)}`), 0, 0));
		const value = defaults![index];
		const defaultAnswers = choice
			? choiceLabels.filter((_label, index) => value.selected.has(index))
			: value.text
				? [cleanText(value.text)]
				: [];
		if (defaultAnswers.length)
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						`Default (suggestion only):${choice ? formatItems(defaultAnswers) : ` ${defaultAnswers[0]}`}`,
					),
					0,
					0,
				),
			);
	};
	if (!expanded) {
		for (let index = 0; index < form.fields.length; index++) renderField(index);
		return;
	}
	for (const block of form.blocks) {
		if (block.kind === "field") renderField(block.index);
		else if (block.kind === "markdown")
			container.addChild(new Markdown(cleanText(block.text), 0, 0, getMarkdownTheme()));
		else container.addChild(new Text(theme.fg("muted", `Image: ${cleanText(block.alt) || "Image"}`), 0, 0));
	}
}

function formatAnswer(answer: string | number | string[], field?: FormField): string {
	const multiple = Array.isArray(answer);
	const values = multiple ? answer : [answer];
	if (!values.length) return "(empty)";
	const labels = values.map((value) => {
		const raw = cleanText(String(value));
		const option = field?.options.find((option) => option.value === value);
		const label = option ? cleanText(option.label) : raw;
		return option && label !== raw ? `${label} (value: ${raw})` : raw || "(empty)";
	});
	return multiple ? formatItems(labels) : labels[0];
}

function formatItems(items: string[]): string {
	return items.map((item) => `\n- ${item.replaceAll("\n", "\n  ")}`).join("");
}

function readOutcome(details: unknown): FormResult | undefined {
	if (!details || typeof details !== "object" || !("kind" in details)) return undefined;
	if (details.kind === "cancelled") return { kind: "cancelled" };
	if (details.kind !== "submitted" || !("answers" in details)) return undefined;
	const answers = details.answers;
	if (!answers || typeof answers !== "object" || Array.isArray(answers)) return undefined;
	if (
		!Object.values(answers).every(
			(value: unknown) =>
				typeof value === "string" ||
				(typeof value === "number" && Number.isFinite(value)) ||
				(Array.isArray(value) && value.every((item: unknown) => typeof item === "string")),
		)
	)
		return undefined;
	return { kind: "submitted", answers: answers as FormAnswers };
}

function cleanText(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/[\r\u007f-\u009f]/g, "");
}
