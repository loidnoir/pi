// Draft-based model settings dashboard shared by the Rex and TUI pane hosts.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { CURSOR_MARKER, type Focusable, getKeybindings, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { ModelSelectorComponent } from "../../modes/interactive/components/model-selector.ts";
import { ThinkingSelectorComponent } from "../../modes/interactive/components/thinking-selector.ts";
import { getSelectListTheme, theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { PaneControls, PaneView } from "./host.ts";

export type ModelDashboardScope = "session" | "project" | "global";

export interface ModelDashboardTarget {
	id: string;
	label: string;
	description?: string;
}

export interface ModelDashboardOverrides {
	model?: { provider: string; id: string } | null;
	thinkingLevel?: ThinkingLevel | null;
	fastMode?: boolean | null;
}

export interface ModelDashboardResolved {
	model: Model<string> | undefined;
	thinkingLevel: ThinkingLevel;
	fastMode: boolean;
}

export interface ModelDashboardOptions {
	targets: readonly ModelDashboardTarget[];
	modelRuntime: ModelRuntime;
	scopedModels: readonly ScopedModel[];
	projectTrusted: boolean;
	/** Abort controller work before disposal waits for an in-flight save. */
	onClose?(): void;
	read(targetId: string, scope: ModelDashboardScope): ModelDashboardOverrides;
	resolve(targetId: string, scope: ModelDashboardScope, overrides: ModelDashboardOverrides): ModelDashboardResolved;
	save(targetId: string, scope: ModelDashboardScope, overrides: ModelDashboardOverrides): Promise<void>;
}

type Field = keyof ModelDashboardOverrides;
type Screen = { kind: "overview" } | { kind: "editor" } | { kind: "choices"; field: Field | "scope" };
type Selector =
	| { kind: "model"; component: ModelSelectorComponent }
	| { kind: "thinking"; component: ThinkingSelectorComponent };
interface Row {
	value: string;
	label: string;
	description?: string;
}

/** Edit model routing drafts without mutating runtime settings until Apply succeeds. */
export class ModelDashboardView implements PaneView, Focusable {
	private readonly controls: PaneControls;
	private readonly options: ModelDashboardOptions;
	private screen: Screen = { kind: "overview" };
	private target: ModelDashboardTarget | undefined;
	private scope: ModelDashboardScope = "session";
	private draft: ModelDashboardOverrides = {};
	private original: ModelDashboardOverrides = {};
	private selector: Selector | undefined;
	private list: SelectList | undefined;
	private selected = 0;
	private overviewSelected = 0;
	private editorSelected = 0;
	private pageSize = 8;
	private busy = false;
	private pendingSave: Promise<void> | undefined;
	private disposed = false;
	private error: string | undefined;
	private status: string | undefined;
	private _focused = true;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.selector) this.selector.component.focused = value;
	}

	constructor(controls: PaneControls, options: ModelDashboardOptions) {
		this.controls = controls;
		this.options = options;
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = getKeybindings();
		try {
			if (kb.matches(data, "app.pane.minimize")) {
				void this.controls.minimize().catch((error: unknown) => this.fail(error));
			} else if (this.busy) {
				// Saving cannot be cancelled: the controller may already have persisted the draft.
				return;
			} else if (this.selector) {
				this.selector.component.handleInput(data);
			} else if (kb.matches(data, "tui.select.cancel")) {
				this.back();
			} else if (this.screen.kind === "editor" && kb.matches(data, "app.models.save")) {
				void this.apply();
			} else {
				this.buildList();
				this.list?.handleInput(data);
			}
		} catch (error) {
			this.fail(error);
		}
		this.invalidate();
	}

	render(width: number, height: number): string[] {
		if (width <= 0 || height <= 0) return [];
		if (height === 1 && (this.error || this.busy))
			return [truncateToWidth(theme.fg(this.error ? "error" : "warning", clean(this.error ?? "Applying…")), width)];
		try {
			if (this.selector) return this.renderSelector(width, height);
			const header = this.header();
			const footer = [
				...(this.error ? [theme.fg("error", clean(this.error))] : []),
				...(this.busy ? [theme.fg("warning", "Applying…")] : []),
				...(!this.error && !this.busy && this.status ? [theme.fg("success", this.status)] : []),
				theme.fg("muted", this.hint()),
			];
			// Keep a selected row reachable even when metadata must disappear on a small pane.
			const bottom = footer.slice(0, Math.max(0, height - 1));
			const top = header.slice(0, Math.max(0, height - bottom.length - 1));
			this.pageSize = Math.max(1, height - top.length - bottom.length - 1);
			this.buildList();
			const rows = this.list!.render(Math.max(20, width));
			return [...top, ...rows.slice(0, height - top.length - bottom.length), ...bottom]
				.slice(0, height)
				.map((line) => truncateToWidth(line, width));
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			return [theme.fg("error", clean(this.error)), theme.fg("muted", this.hint())]
				.slice(0, height)
				.map((line) => truncateToWidth(line, width));
		}
	}

	async dispose(): Promise<void> {
		if (!this.disposed) {
			this.disposed = true;
			this.options.onClose?.();
			this.closeSelector();
		}
		// The host must retain the runtime until persistence/authentication has settled.
		await this.pendingSave?.catch(() => {});
	}

	private header(): string[] {
		if (this.screen.kind === "overview")
			return [
				theme.fg("accent", "Model dashboard"),
				theme.fg("muted", "Effective settings · select a target to edit"),
			];
		const resolved = this.preview();
		const model = resolved.model;
		return [
			theme.fg("accent", `${clean(this.target!.label)} · ${this.scope}${this.dirty() ? " · unsaved draft" : ""}`),
			...(this.target!.description ? [clean(this.target!.description)] : []),
			`Effective: ${model ? `${clean(model.id)} [${clean(model.provider)}]` : "No model"} · thinking ${resolved.thinkingLevel} · fast ${fastStatus(resolved)}`,
			...(model
				? [
						theme.fg(
							"muted",
							`Context ${model.contextWindow.toLocaleString()} tokens · $/1M tokens: input ${model.cost.input}, output ${model.cost.output}, cache read ${model.cost.cacheRead}, write ${model.cost.cacheWrite}`,
						),
					]
				: []),
			theme.fg("muted", "Previewing selected scope draft · default inherits lower scope/profile."),
			theme.fg("muted", this.scopeEffect(this.scope)),
			theme.fg(
				"muted",
				this.target?.id === "main"
					? "Existing BTW chats and children keep their settings."
					: "Existing conversations, BTW chats and children keep their settings.",
			),
			...(!this.options.projectTrusted
				? [theme.fg("warning", "Project scope unavailable: project is not trusted.")]
				: []),
		];
	}

	private scopeEffect(scope: ModelDashboardScope): string {
		if (this.target?.id === "main")
			return scope === "session"
				? "Apply updates the current conversation."
				: `Apply updates the current conversation and saves ${scope} defaults.`;
		const launches = this.target?.id === "btw" ? "future BTW chats" : "future child launches";
		return scope === "session"
			? `Apply changes ${launches} in this session.`
			: `Apply saves ${scope} defaults for ${launches}.`;
	}

	private hint(): string {
		return `${keyText("tui.select.up")}/${keyText("tui.select.down")} move · ${keyText("tui.select.confirm")} select · ${this.screen.kind === "editor" ? `${keyText("app.models.save")} Apply · ` : ""}${keyText("tui.select.cancel")} ${this.screen.kind === "overview" ? "close" : this.screen.kind === "editor" ? "discard/back" : "back"} · ${keyText("app.pane.minimize")} minimize`;
	}

	private rows(): Row[] {
		if (this.screen.kind === "overview")
			return this.options.targets.map((target) => {
				const resolved = this.options.resolve(target.id, "session", this.options.read(target.id, "session"));
				return {
					value: target.id,
					label: clean(target.label),
					description: `${resolved.model ? `${clean(resolved.model.provider)}/${clean(resolved.model.id)}` : "No model"} · ${resolved.thinkingLevel} · fast ${fastStatus(resolved)}`,
				};
			});
		if (this.screen.kind === "editor") {
			const supportedFast = supportsFast(this.preview().model);
			return [
				{ value: "scope", label: `Save scope: ${this.scope}` },
				{ value: "model", label: `Model: ${this.fieldLabel("model")}` },
				{ value: "thinkingLevel", label: `Thinking: ${this.fieldLabel("thinkingLevel")}` },
				{
					value: "fastMode",
					label: `Fast: ${supportedFast ? this.fieldLabel("fastMode") : `inactive (${this.fieldLabel("fastMode")})`}`,
					description: supportedFast ? "Codex only · higher usage" : "Unsupported model · Off clears saved flag",
				},
				{ value: "reset", label: "Reset scope", description: "Clear all fields in this draft; Apply to save" },
				{ value: "apply", label: "Apply", description: this.scopeEffect(this.scope) },
			];
		}
		if (this.screen.field === "scope")
			return [
				{ value: "session", label: "Session", description: this.scopeEffect("session") },
				{
					value: "project",
					label: "Project",
					description: this.options.projectTrusted
						? this.scopeEffect("project")
						: "Unavailable: project not trusted",
				},
				{ value: "global", label: "Global", description: this.scopeEffect("global") },
			];
		const field = this.screen.field;
		const model = this.preview().model;
		const supportedFast = supportsFast(model);
		return [
			...(field === "fastMode"
				? supportedFast
					? [
							{ value: "on", label: "On", description: "Faster Codex responses · higher usage" },
							{ value: "off", label: "Off" },
						]
					: [
							{
								value: "unsupported",
								label: "Fast inactive",
								description: "Requires openai-codex / openai-codex-responses",
							},
							{ value: "off", label: "Off", description: "Clear an enabled fast setting" },
						]
				: [{ value: "choose", label: field === "model" ? "Choose model…" : "Choose thinking level…" }]),
			{ value: "default", label: "Default / inherit lower scope", description: "Remove this field override" },
			{
				value: "main",
				label: this.target?.id === "main" ? "Reset to startup/default" : "Inherit main",
				description:
					this.target?.id === "main" ? "Reset this field at the selected scope" : "Follow the main thread",
			},
		];
	}

	private buildList(): void {
		const rows = this.rows();
		this.list = new SelectList(rows, this.pageSize, getSelectListTheme(), {
			minPrimaryColumnWidth: 20,
			maxPrimaryColumnWidth: 44,
		});
		this.list.setSelectedIndex(this.selected);
		this.list.onSelectionChange = (item) => {
			this.selected = rows.findIndex((row) => row.value === item.value);
		};
		this.list.onSelect = (item) => this.select(item.value);
	}

	private select(value: string): void {
		this.error = undefined;
		this.status = undefined;
		if (this.screen.kind === "overview") {
			this.target = this.options.targets.find((target) => target.id === value);
			if (!this.target) return;
			this.loadScope("session");
			this.overviewSelected = this.selected;
			this.screen = { kind: "editor" };
			this.selected = 0;
		} else if (this.screen.kind === "editor") {
			if (value === "apply") void this.apply();
			else if (value === "reset") this.draft = {};
			else {
				this.editorSelected = this.selected;
				// Values come exclusively from the editor's fixed rows.
				this.screen = { kind: "choices", field: value as Field | "scope" };
				this.selected = 0;
			}
		} else if (this.screen.field === "scope") {
			if (this.dirty()) throw new Error("Apply or discard this draft before changing scope.");
			if (value === "project" && !this.options.projectTrusted)
				throw new Error("Trust this project before saving project settings.");
			// Values come exclusively from the scope rows.
			this.loadScope(value as ModelDashboardScope);
			this.back();
		} else {
			const field = this.screen.field;
			if (value === "choose") this.openSelector(field);
			else if (value === "unsupported") throw new Error("Fast requires openai-codex / openai-codex-responses.");
			else {
				if (value === "default") delete this.draft[field];
				else if (value === "main") this.draft[field] = null;
				else this.draft.fastMode = value === "on";
				this.back();
			}
		}
	}

	private fieldLabel(field: Field): string {
		const value = this.draft[field];
		if (value === undefined) return "default (inherit lower scope/profile)";
		if (value === null) return this.target?.id === "main" ? "startup/default" : "inherit main";
		if (field === "model") return `${clean(this.draft.model!.provider)}/${clean(this.draft.model!.id)}`;
		if (field === "fastMode") return value ? "on" : "off";
		return String(value);
	}

	private loadScope(scope: ModelDashboardScope): void {
		const overrides = this.options.read(this.target!.id, scope);
		this.scope = scope;
		this.original = { ...overrides };
		this.draft = { ...overrides };
	}

	private preview(): ModelDashboardResolved {
		return this.options.resolve(this.target!.id, this.scope, this.draft);
	}

	private dirty(): boolean {
		return JSON.stringify(this.draft) !== JSON.stringify(this.original);
	}

	private back(): void {
		this.error = undefined;
		if (this.screen.kind === "overview") this.controls.close();
		else if (this.screen.kind === "choices") {
			this.screen = { kind: "editor" };
			this.selected = this.editorSelected;
		} else {
			this.draft = {};
			this.target = undefined;
			this.screen = { kind: "overview" };
			this.selected = this.overviewSelected;
		}
	}

	private openSelector(field: Field): void {
		const resolved = this.preview();
		const cancel = () => {
			this.closeSelector();
			this.invalidate();
		};
		if (field === "model") {
			this.selector = {
				kind: "model",
				component: new ModelSelectorComponent(
					{ requestRender: () => this.invalidate() },
					resolved.model,
					this.options.modelRuntime,
					this.options.scopedModels,
					(model) => {
						this.draft.model = { provider: model.provider, id: model.id };
						this.closeSelector();
						this.back();
						this.invalidate();
					},
					cancel,
				),
			};
		} else {
			if (!resolved.model) throw new Error("Choose a model before choosing a thinking level.");
			this.selector = {
				kind: "thinking",
				component: new ThinkingSelectorComponent(
					resolved.thinkingLevel,
					getSupportedThinkingLevels(resolved.model),
					(level) => {
						this.draft.thinkingLevel = level;
						this.closeSelector();
						this.back();
						this.invalidate();
					},
					cancel,
				),
			};
		}
		this.focused = this._focused;
	}

	private closeSelector(): void {
		if (this.selector) this.selector.component.focused = false;
		if (this.selector?.kind === "model") this.selector.component.dispose();
		this.selector = undefined;
	}

	private renderSelector(width: number, height: number): string[] {
		const lines = this.selector!.component.render(Math.max(20, width));
		if (lines.length <= height) return lines.map((line) => truncateToWidth(line, width));
		// Native selectors own search and selection. Pin their input while scrolling decoration out.
		const input = lines.findIndex((line) => line.includes(CURSOR_MARKER) || stripAnsi(line).startsWith("> "));
		const remaining = lines.filter(
			(line, index) => index !== input && stripAnsi(line).trim() && !/^[─━]+$/.test(stripAnsi(line)),
		);
		const selected = Math.max(
			0,
			remaining.findIndex((line) => stripAnsi(line).startsWith("→")),
		);
		const available = Math.max(0, height - (input >= 0 && height > 1 ? 1 : 0));
		const start = Math.max(0, Math.min(selected - Math.floor(available / 2), remaining.length - available));
		return [...(input >= 0 && height > 1 ? [lines[input]] : []), ...remaining.slice(start, start + available)].map(
			(line) => truncateToWidth(line, width),
		);
	}

	private async apply(): Promise<void> {
		if (this.busy || this.disposed) return;
		this.error = undefined;
		try {
			if (this.scope === "project" && !this.options.projectTrusted)
				throw new Error("Trust this project before saving project settings.");
			this.preview();
			this.busy = true;
			this.pendingSave = this.options.save(this.target!.id, this.scope, { ...this.draft });
			this.invalidate();
			await this.pendingSave;
			if (this.disposed) return;
			this.original = { ...this.draft };
			this.status = `Applied ${this.scope} settings.`;
		} catch (error) {
			this.fail(error);
		} finally {
			this.pendingSave = undefined;
			this.busy = false;
			this.invalidate();
		}
	}

	private fail(error: unknown): void {
		if (this.disposed) return;
		this.error = error instanceof Error ? error.message : String(error);
		this.invalidate();
	}

	private invalidate(): void {
		if (!this.disposed) this.controls.invalidate();
	}
}

function supportsFast(model: Model<string> | undefined): boolean {
	return model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

function fastStatus(resolved: ModelDashboardResolved): string {
	if (!supportsFast(resolved.model))
		return resolved.fastMode ? "inactive (configured on; unsupported model)" : "inactive (unsupported model)";
	return resolved.fastMode ? "on" : "off";
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/[\r\n]/g, " ");
}
