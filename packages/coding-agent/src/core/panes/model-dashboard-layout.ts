import type { SelectItem } from "@earendil-works/pi-tui";
import { type IconName, iconPrefix } from "../../modes/interactive/icons.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { supportsFastMode } from "../model-preferences.ts";
import type { ModelDashboardResolved, ModelDashboardTarget } from "./model-dashboard.ts";

export function dashboardHeader(
	target: ModelDashboardTarget | undefined,
	resolved: ModelDashboardResolved | undefined,
): string[] {
	if (!target) return [""];
	const model = resolved?.model;
	if (!model) return ["", `  ${branch(true)}${theme.fg("warning", "No model")}`, ""];
	return [
		"",
		`  ${treeField(false, "compact", "Context", `${model.contextWindow.toLocaleString("en-US")} tokens`)}`,
		`  ${treeField(false, "import", "Input", `$${model.cost.input} / 1M tokens`)}`,
		`  ${treeField(false, "export", "Output", `$${model.cost.output} / 1M tokens`)}`,
		`  ${treeField(false, "read", "Cache read", `$${model.cost.cacheRead} / 1M tokens`)}`,
		`  ${treeField(true, "write", "Cache write", `$${model.cost.cacheWrite} / 1M tokens`)}`,
		"",
	];
}

export function dashboardTargetRow(
	target: ModelDashboardTarget,
	resolved: ModelDashboardResolved,
	last: boolean,
): SelectItem {
	const model = resolved.model;
	const name = model ? `${clean(model.id)} [${clean(model.provider)}]` : "No model";
	const fast = supportsFastMode(model) ? (resolved.fastMode ? "on" : "off") : "inactive";
	return {
		value: target.id,
		label:
			branch(last) +
			clean(target.label) +
			theme.fg("muted", ` · ${name} · thinking ${resolved.thinkingLevel} · fast ${fast}`),
	};
}

const fields = {
	model: ["model", "Model"],
	thinkingLevel: ["thinking", "Thinking"],
	fastMode: ["fast", "Fast"],
} as const;

export function dashboardSettingRow(field: "scope" | keyof typeof fields, value: string, last: boolean): SelectItem {
	const chosen = theme.fg("accent", clean(value));
	if (field === "scope") {
		const scope = value.toLowerCase();
		const icon = scope === "global" ? "globe" : scope === "project" ? "folder" : "chat";
		return { value: field, label: treeField(last, icon, "Scope", chosen) };
	}
	const [icon, label] = fields[field];
	return { value: field, label: treeField(last, icon, label, chosen) };
}

function treeField(last: boolean, icon: IconName, label: string, value: string): string {
	return `${branch(last)}${iconPrefix(icon)}${label}: ${value}`;
}

function branch(last: boolean): string {
	return theme.fg("muted", last ? "└─ " : "├─ ");
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/[\r\n\t]/gu, " ");
}
