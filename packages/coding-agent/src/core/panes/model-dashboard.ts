// Draft-based model settings dashboard shared by the Rex and TUI pane hosts.
import { isDeepStrictEqual } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
	type Focusable,
	getKeybindings,
	getSelectPageIndex,
	type SelectItem,
	SelectList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { refreshModelCatalogs } from "../../modes/interactive/model-catalog-refresh.ts";
import { getSelectListTheme, theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { supportsFastMode } from "../model-preferences.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { PaneControls, PaneView } from "./host.ts";
import { dashboardHeader, dashboardSettingRow, dashboardTargetRow } from "./model-dashboard-layout.ts";

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
	warning?: string;
	signal?: AbortSignal;
	recoveryKey?: object;
	onClose?(): void;
	read(targetId: string, scope: ModelDashboardScope): ModelDashboardOverrides;
	resolve(
		targetId: string,
		scope: ModelDashboardScope,
		overrides: ModelDashboardOverrides,
		pending?: (targetId: string, scope: ModelDashboardScope) => ModelDashboardOverrides | undefined,
	): ModelDashboardResolved;
	save(targetId: string, scope: ModelDashboardScope, overrides: ModelDashboardOverrides): Promise<void>;
}

const scopes = ["session", "project", "global"] as const;
const settings = ["model", "thinkingLevel", "fastMode"] as const;
const fields = ["scope", ...settings] as const;
interface Draft {
	original: ModelDashboardOverrides;
	changes: ModelDashboardOverrides;
}

const recoveries = new WeakMap<object, { drafts: Map<string, Draft>; error: string }>();

export class ModelDashboardView implements PaneView, Focusable {
	focused = true;
	private readonly controls: PaneControls;
	private readonly options: ModelDashboardOptions;
	private readonly drafts: Map<string, Draft>;
	private readonly selectedScopes = new Map<string, ModelDashboardScope>();
	private readonly refreshController = new AbortController();
	private target: ModelDashboardTarget | undefined;
	private selected = 0;
	private overviewSelected = 0;
	private pageSize = 8;
	private saving: Promise<void> | undefined;
	private disposal: Promise<void> | undefined;
	private error: string | undefined;
	private catalogWarning: string | undefined;

	constructor(controls: PaneControls, options: ModelDashboardOptions) {
		this.controls = controls;
		this.options = options;
		const key = options.signal?.aborted ? undefined : options.recoveryKey;
		const recovery = key && recoveries.get(key);
		this.drafts = recovery?.drafts ?? new Map();
		this.error = recovery?.error;
		if (key) recoveries.delete(key);
		if (!options.modelRuntime.getAvailableSnapshot().length && !options.signal?.aborted) void this.refreshCatalog();
	}

	private async refreshCatalog(): Promise<void> {
		const signal = AbortSignal.any([
			this.refreshController.signal,
			AbortSignal.timeout(15_000),
			...(this.options.signal ? [this.options.signal] : []),
		]);
		try {
			const result = await refreshModelCatalogs(this.options.modelRuntime, signal);
			this.catalogWarning = result.errors.size
				? `Could not refresh ${[...result.errors.keys()].join(", ")}; showing cached models.`
				: this.options.modelRuntime.getError();
		} catch (error) {
			this.catalogWarning = error instanceof Error ? error.message : String(error);
		}
		this.invalidate();
	}

	private get scope(): ModelDashboardScope {
		return (this.target && this.selectedScopes.get(this.target.id)) ?? "session";
	}

	handleInput(data: string): void {
		if (this.disposal || this.options.signal?.aborted) return;
		const kb = getKeybindings();
		try {
			if (kb.matches(data, "app.pane.minimize")) {
				void this.controls.minimize().catch((error: unknown) => this.fail(error));
			} else if (this.saving) return;
			else if (kb.matches(data, "tui.select.cancel")) {
				if (this.target) {
					this.target = undefined;
					this.selected = this.overviewSelected;
					this.error = undefined;
				} else void this.close();
			} else if (this.target && kb.matches(data, "tui.input.tab")) {
				this.error = undefined;
				this.cycle(this.target);
			} else if (!this.target && kb.matches(data, "tui.select.confirm")) {
				this.target = this.options.targets[this.selected];
				this.overviewSelected = this.selected;
				this.selected = 0;
				this.error = undefined;
			} else {
				const count = this.target ? fields.length : this.options.targets.length;
				if (!count) return;
				if (kb.matches(data, "tui.select.up")) this.selected = (this.selected + count - 1) % count;
				else if (kb.matches(data, "tui.select.down")) this.selected = (this.selected + 1) % count;
				else this.selected = getSelectPageIndex(kb, data, this.selected, count, this.pageSize) ?? this.selected;
			}
		} catch (error) {
			this.fail(error);
		}
		this.invalidate();
	}

	render(width: number, height: number): string[] {
		if (width <= 0 || height <= 0) return [];
		const message = this.error ?? (this.saving ? "Saving…" : (this.options.warning ?? this.catalogWarning));
		const notice = message && theme.fg(this.error ? "error" : "warning", clean(message));
		if (height === 1 && notice) return [truncateToWidth(notice, width)];
		try {
			const resolved = this.target ? this.preview(this.target.id, this.scope) : undefined;
			const header = dashboardHeader(this.target, resolved);
			const fastHint =
				this.target && fields[this.selected] === "fastMode"
					? supportsFastMode(resolved?.model)
						? "Codex priority tier · higher usage"
						: "Fast inactive: unsupported model"
					: undefined;
			const footer = [
				...(notice ? [notice] : []),
				...(this.target && !this.options.projectTrusted
					? [theme.fg("warning", "Project scope unavailable: project is not trusted.")]
					: []),
				...(fastHint ? [theme.fg("warning", fastHint)] : []),
				theme.fg(
					"muted",
					`${keyText("tui.select.up")}/${keyText("tui.select.down")} move · ${this.target ? `${keyText("tui.input.tab")} change` : `${keyText("tui.select.confirm")} edit`} · ${keyText("tui.select.cancel")} ${this.target ? "back" : "save & close"} · ${keyText("app.pane.minimize")} minimize`,
				),
			];
			// Keep a selected row reachable even when metadata must disappear on a small pane.
			const bottom = footer.slice(0, Math.max(0, height - 1));
			const top = header.slice(0, Math.max(0, height - bottom.length - 1));
			this.pageSize = Math.max(1, height - top.length - bottom.length - 1);
			const list = new SelectList(this.rows(), this.pageSize, getSelectListTheme());
			list.setSelectedIndex(this.selected);
			const rows = list.render(Math.max(20, width));
			return [...top, ...rows.slice(0, height - top.length - bottom.length), ...bottom].map((line) =>
				truncateToWidth(line, width),
			);
		} catch (error) {
			return [
				truncateToWidth(theme.fg("error", clean(error instanceof Error ? error.message : String(error))), width),
			];
		}
	}

	dispose(): Promise<void> {
		if (!this.disposal) {
			const { signal, onClose } = this.options;
			const saving = this.saving ?? (signal?.aborted ? undefined : this.flush());
			this.disposal = Promise.resolve(saving)
				.catch((error: unknown) => {
					if (signal?.aborted) return;
					if (this.options.recoveryKey)
						recoveries.set(this.options.recoveryKey, {
							drafts: this.drafts,
							error: error instanceof Error ? error.message : String(error),
						});
					throw error;
				})
				.finally(onClose);
			this.refreshController.abort();
		}
		return this.disposal;
	}

	private pending = (id: string, scope: ModelDashboardScope): ModelDashboardOverrides | undefined => {
		const draft = this.drafts.get(`${scope}:${id}`);
		return draft && mergeEdits(this.previewBase(id, scope), draft.changes);
	};

	private previewBase(id: string, scope: ModelDashboardScope): ModelDashboardOverrides {
		if (id === "main" && scope === "session") {
			for (const wider of ["project", "global"] as const) {
				if (this.drafts.has(`${wider}:${id}`)) return sessionSelection(this.preview(id, wider));
			}
		}
		return this.options.read(id, scope);
	}

	private preview(id: string, scope: ModelDashboardScope): ModelDashboardResolved {
		return this.options.resolve(id, scope, this.pending(id, scope) ?? this.previewBase(id, scope), this.pending);
	}

	private rows(): SelectItem[] {
		const target = this.target;
		if (!target)
			return this.options.targets.map((item, index) => {
				const scope =
					item.id === "main" ? (scopes.find((s) => this.drafts.has(`${s}:${item.id}`)) ?? "session") : "session";
				return dashboardTargetRow(item, this.preview(item.id, scope), index === this.options.targets.length - 1);
			});
		const scope = this.scope;
		const values = this.pending(target.id, scope) ?? this.previewBase(target.id, scope);
		return fields.map((field, index) => {
			const label = field === "scope" ? scope : fieldLabel(target.id, values[field]);
			return dashboardSettingRow(field, label, index === fields.length - 1);
		});
	}

	private cycle(target: ModelDashboardTarget): void {
		const field = fields[this.selected];
		const scope = this.scope;
		if (field === "scope") {
			this.selectedScopes.set(target.id, next(scope, this.options.projectTrusted ? scopes : ["session", "global"]));
			return;
		}
		const key = `${scope}:${target.id}`;
		const base = this.previewBase(target.id, scope);
		const draft = this.drafts.get(key) ?? { original: {}, changes: {} };
		const values = mergeEdits(base, draft.changes);
		if (field === "model") {
			const models = new Map<string, NonNullable<ModelDashboardOverrides["model"]>>();
			for (const { provider, id } of [
				...this.options.scopedModels.map((m) => m.model),
				...this.options.modelRuntime.getAvailableSnapshot(),
			])
				models.set(`${provider}\0${id}`, { provider, id });
			values.model = next(values.model, [...models.values(), null, undefined]);
		} else {
			const { model } = this.preview(target.id, scope);
			if (field === "thinkingLevel")
				values.thinkingLevel = next(values.thinkingLevel, [
					...(model ? getSupportedThinkingLevels(model) : []),
					null,
					undefined,
				]);
			else
				values.fastMode = next(values.fastMode, [
					...(supportsFastMode(model) ? [true, false] : [false]),
					null,
					undefined,
				]);
		}
		if (isDeepStrictEqual(values[field], base[field])) {
			delete draft.original[field];
			delete draft.changes[field];
		} else {
			draft.original = { ...draft.original, [field]: this.options.read(target.id, scope)[field] };
			draft.changes = { ...draft.changes, [field]: values[field] };
		}
		if (Object.keys(draft.changes).length) this.drafts.set(key, draft);
		else this.drafts.delete(key);
	}

	private async close(): Promise<void> {
		this.error = undefined;
		try {
			await this.flush();
			if (!this.disposal && !this.options.signal?.aborted) this.controls.close();
		} catch (error) {
			this.fail(error);
		} finally {
			this.saving = undefined;
			this.invalidate();
		}
	}

	private flush(): Promise<void> {
		this.saving ??= Promise.resolve().then(async () => {
			const targets = [...this.options.targets].sort((a, b) => Number(b.id === "main") - Number(a.id === "main"));
			for (const { id } of targets) {
				for (const scope of ["global", "project", "session"] as const) {
					if (this.options.signal?.aborted) return;
					const key = `${scope}:${id}`;
					const draft = this.drafts.get(key);
					if (!draft) continue;
					const values = this.checkedValues(id, scope, draft);
					const session = id === "main" && scope !== "session" ? this.drafts.get("session:main") : undefined;
					if (session) this.checkedValues(id, "session", session);
					const applied = session && this.options.resolve(id, scope, values);
					try {
						await this.options.save(id, scope, values);
						this.drafts.delete(key);
					} finally {
						if (session && applied && !this.options.signal?.aborted) {
							const live = this.options.read(id, "session");
							const expected = sessionSelection(applied);
							for (const field of settings) {
								if (field in session.changes && isDeepStrictEqual(live[field], expected[field]))
									session.original = { ...session.original, [field]: live[field] };
							}
						}
					}
				}
			}
		});
		return this.saving;
	}

	private checkedValues(id: string, scope: ModelDashboardScope, draft: Draft): ModelDashboardOverrides {
		const latest = this.options.read(id, scope);
		for (const field of settings) {
			if (
				field in draft.changes &&
				!isDeepStrictEqual(latest[field], draft.original[field]) &&
				!isDeepStrictEqual(latest[field], draft.changes[field])
			)
				throw new Error(
					`${id} (${scope}): ${field} changed since editing. Cycle this field to choose its value again.`,
				);
		}
		return mergeEdits(latest, draft.changes);
	}

	private fail(error: unknown): void {
		this.error = error instanceof Error ? error.message : String(error);
		this.invalidate();
	}

	private invalidate(): void {
		if (!this.disposal && !this.options.signal?.aborted) this.controls.invalidate();
	}
}

function sessionSelection({ model, thinkingLevel, fastMode }: ModelDashboardResolved): ModelDashboardOverrides {
	return { model: model && { provider: model.provider, id: model.id }, thinkingLevel, fastMode };
}

function mergeEdits(latest: ModelDashboardOverrides, changes: ModelDashboardOverrides): ModelDashboardOverrides {
	const merged = { ...latest, ...changes };
	for (const field of settings) if (merged[field] === undefined) delete merged[field];
	return merged;
}

function fieldLabel(id: string, value: ModelDashboardOverrides[keyof ModelDashboardOverrides]): string {
	if (value === undefined) return "default (inherit lower scope/profile)";
	if (value === null) return id === "main" ? "startup/default" : "inherit main";
	if (typeof value === "boolean") return value ? "on" : "off";
	if (typeof value === "string") return value;
	return `${value.provider}/${value.id}`;
}

function next<T>(value: T, choices: readonly T[]): T {
	return choices[(choices.findIndex((item) => isDeepStrictEqual(item, value)) + 1) % choices.length];
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/[\r\n\t]/gu, " ");
}
