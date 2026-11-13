// Renders semantic question forms above the prompt, with explicit review and submission.
import {
	CURSOR_MARKER,
	type DefaultTextStyle,
	Editor,
	type Focusable,
	Image,
	Input,
	Markdown,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { icon } from "../../modes/interactive/icons.ts";
import { getEditorTheme, getMarkdownTheme, theme } from "../../modes/interactive/theme/theme.ts";
import type { Keybinding, KeybindingsManager } from "../keybindings.ts";
import {
	type FormAnswers,
	type FormBlock,
	type FormValue,
	initialFormValues,
	type QuestionForm,
	validateForm,
} from "./form.ts";
import { loadFormImage } from "./media.ts";

export type FormResult = { kind: "submitted"; answers: FormAnswers } | { kind: "cancelled" };
type ImageState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; image: Image };
type FormControl =
	| { kind: "input"; input: Input }
	| { kind: "textarea"; editor: FormTextEditor }
	| { kind: "choices"; other: Input };

/** Owns one blocking question form; it never times out or submits implicit defaults. */
export class QuestionFormView implements Focusable {
	readonly capturesViewportInput = true;
	private readonly form: QuestionForm;
	private readonly tui: TUI;
	private readonly keys: KeybindingsManager;
	private readonly done: (result: FormResult) => void;
	private readonly values: FormValue[];
	private readonly controls: FormControl[];
	private readonly images = new Map<FormBlock, ImageState>();
	private readonly mediaController = new AbortController();
	private readonly signal: AbortSignal;
	private readonly onAbort: () => void;
	private page = 0;
	private choice = 0;
	private offset = 0;
	private height = 1;
	private renderedBodyHeight = 0;
	private bodyStart = 1;
	private actionRows: { start: number; end: number } | undefined;
	private total = 0;
	private choiceRows = new Map<number, { start: number; end: number }>();
	private followChoice = false;
	private followInput = false;
	private inputRow = 0;
	private imageRows: { start: number; end: number; alt: string }[] = [];
	private error = "";
	private validating = false;
	private closed = false;
	private _focused = false;

	constructor(
		form: QuestionForm,
		tui: TUI,
		keys: KeybindingsManager,
		cwd: string,
		signal: AbortSignal,
		done: (result: FormResult) => void,
	) {
		this.form = form;
		this.tui = tui;
		this.keys = keys;
		this.done = done;
		this.signal = signal;
		this.values = initialFormValues(form);
		this.controls = form.fields.map((field, index): FormControl => {
			if (field.kind === "textarea") {
				const editor = new FormTextEditor(tui, getEditorTheme());
				editor.disableSubmit = true;
				editor.setText(field.value);
				return { kind: "textarea", editor };
			}
			if (field.kind === "radio" || field.kind === "checkbox" || field.kind === "select") {
				return { kind: "choices", other: new Input({ placeholder: "Your answer" }) };
			}
			const input = new Input({ placeholder: field.placeholder });
			input.setValue(this.values[index].text);
			return { kind: "input", input };
		});
		this.onAbort = () => this.finish({ kind: "cancelled" });
		signal.addEventListener("abort", this.onAbort, { once: true });
		for (const block of form.blocks) {
			if (block.kind !== "image") continue;
			this.images.set(block, { kind: "loading" });
			void loadFormImage(block.source, cwd, this.mediaController.signal).then(
				(image) => {
					if (this.closed) return;
					this.images.set(block, {
						kind: "ready",
						image: new Image(
							image.data,
							image.mimeType,
							{ fallbackColor: (text) => theme.fg("muted", text) },
							{ maxHeightCells: 6, filename: block.alt },
						),
					});
					this.tui.requestRender();
				},
				(error: unknown) => {
					if (this.closed) return;
					this.images.set(block, {
						kind: "error",
						message: error instanceof Error ? error.message : String(error),
					});
					this.tui.requestRender();
				},
			);
		}
		if (signal.aborted) this.onAbort();
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.focusControl();
	}

	invalidate(): void {
		for (const control of this.controls) if (control.kind === "textarea") control.editor.invalidate();
		for (const state of this.images.values()) if (state.kind === "ready") state.image.invalidate();
	}

	dispose(): void {
		this.signal.removeEventListener("abort", this.onAbort);
		this.mediaController.abort();
		if (!this.closed) this.finish({ kind: "cancelled" });
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (
			this.keys.matches(data, "tui.select.cancel") ||
			this.keys.matches(data, "app.interrupt") ||
			this.keys.matches(data, "app.clear")
		) {
			this.finish({ kind: "cancelled" });
			return;
		}
		if (this.validating) return;
		if (this.keys.matches(data, "app.ask.submit")) {
			void this.submit();
			return;
		}
		if (this.keys.matches(data, "tui.input.tab")) {
			this.movePage(1);
			return;
		}
		if (this.keys.matches(data, "app.ask.previous")) {
			this.movePage(-1);
			return;
		}
		const pageDelta = this.keys.matches(data, "tui.select.pageUp")
			? -this.height
			: this.keys.matches(data, "tui.select.pageDown")
				? this.height
				: 0;
		if (pageDelta) {
			this.offset = Math.max(0, Math.min(this.total - this.height, this.offset + pageDelta));
			this.tui.requestRender();
			return;
		}
		const field = this.form.fields[this.page];
		const control = this.controls[this.page];
		if (!field) {
			if (this.keys.matches(data, "tui.select.confirm")) void this.submit();
			return;
		}
		if (control.kind === "choices") {
			const delta = this.keys.matches(data, "tui.select.up")
				? -1
				: this.keys.matches(data, "tui.select.down")
					? 1
					: 0;
			if (delta) {
				this.choice = Math.max(
					0,
					Math.min(field.options.length - 1 + Number(this.hasOther()), this.choice + delta),
				);
				this.followChoice = true;
			} else if (this.keys.matches(data, "tui.select.confirm")) {
				if (this.choice < field.options.length) {
					if (!field.multiple) {
						this.values[this.page].selected.clear();
						this.values[this.page].selected.add(this.choice);
						this.values[this.page].useOther = false;
					}
					this.movePage(1);
					return;
				}
				if (!this.values[this.page].useOther) this.toggleChoice();
				else {
					this.movePage(1);
					return;
				}
			} else if (this.choice === field.options.length && this.values[this.page].useOther) {
				control.other.handleInput(data);
				this.followInput = true;
			} else if (this.keys.matches(data, "app.ask.toggle")) this.toggleChoice();
		} else if (
			this.keys.matches(data, "tui.select.confirm") &&
			!(control.kind === "textarea" && this.keys.matches(data, "tui.input.newLine"))
		) {
			this.movePage(1);
			return;
		} else if (control.kind === "input") {
			control.input.handleInput(data);
			this.followInput = true;
		} else {
			control.editor.handleInput(data);
			this.followInput = true;
		}
		this.focusControl();
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.offset = Math.max(
				0,
				Math.min(Math.max(0, this.total - this.height), this.offset + (event.wheelDelta ?? 0)),
			);
			return { handled: true };
		}
		if (this.closed || this.validating || event.type !== "click" || event.button !== "left") return undefined;
		if (event.y === 0) {
			this.movePage(event.x < event.width / 2 ? -1 : 1);
			return { handled: true };
		}
		if (this.actionRows && event.y >= this.actionRows.start && event.y < this.actionRows.end) {
			if (this.page === this.form.fields.length) void this.submit();
			else this.movePage(1);
			return { handled: true };
		}
		if (event.y < this.bodyStart || event.y >= this.bodyStart + this.renderedBodyHeight) return undefined;
		const row = event.y - this.bodyStart + this.offset;
		for (const [choice, rows] of this.choiceRows) {
			if (row >= rows.start && row < rows.end) {
				this.choice = choice;
				this.toggleChoice();
				this.focusControl();
				return { handled: true };
			}
		}
		return undefined;
	}

	render(width: number, maxHeight = this.tui.terminal.rows - 6): string[] {
		maxHeight = Math.max(1, maxHeight);
		const spacious = maxHeight >= 12;
		const body: string[] = [];
		this.choiceRows.clear();
		this.imageRows = [];
		if (this.page < this.form.fields.length) this.renderQuestion(body, width, spacious);
		else this.renderReview(body, width, spacious);
		this.total = body.length;
		const headerGap = spacious ? [""] : [];
		const footerBudget = Math.max(0, maxHeight - headerGap.length - 2);
		let footer = this.renderActions(width, footerBudget, spacious, false);
		this.height = Math.max(1, maxHeight - 1 - headerGap.length - footer.lines.length);
		if (body.length > this.height) {
			footer = this.renderActions(width, footerBudget, spacious, true);
			this.height = Math.max(1, maxHeight - 1 - headerGap.length - footer.lines.length);
		}
		if (this.followChoice) {
			const rows = this.choiceRows.get(this.choice);
			if (rows) this.revealRows(rows.start, rows.end);
			this.followChoice = false;
		}
		if (this.followInput) {
			this.revealRows(this.inputRow, this.inputRow + 1);
			this.followInput = false;
		}
		this.offset = Math.max(0, Math.min(Math.max(0, body.length - this.height), this.offset));
		const progress = `${this.page + 1}/${this.form.fields.length}`;
		const next = this.page === this.form.fields.length ? "Review" : width < 48 ? progress : `Question ${progress}`;
		const scroll =
			body.length > this.height
				? ` · ${this.offset + 1}–${Math.min(body.length, this.offset + this.height)}/${body.length}`
				: "";
		const header = theme.fg("accent", `‹ ${icon("question")} Ask · ${next}${scroll} ›`);
		const visible = body.slice(this.offset, this.offset + this.height);
		this.bodyStart = 1 + headerGap.length;
		this.renderedBodyHeight = visible.length;
		this.actionRows = footer.action
			? {
					start: this.bodyStart + visible.length + footer.action.start,
					end: this.bodyStart + visible.length + footer.action.end,
				}
			: undefined;
		for (const image of this.imageRows) {
			if (image.start >= this.offset && image.end <= this.offset + this.height) continue;
			const start = Math.max(image.start, this.offset);
			const end = Math.min(image.end, this.offset + this.height);
			for (let row = start; row < end; row++)
				visible[row - this.offset] =
					row === start ? truncateToWidth(`[${image.alt}: scroll to view image]`, width) : "";
		}
		return [truncateToWidth(header, width), ...headerGap, ...visible, ...footer.lines].slice(0, maxHeight);
	}

	private renderQuestion(body: string[], width: number, spacious: boolean): void {
		const field = this.form.fields[this.page];
		let previous = -1;
		const current = this.form.blocks.findIndex((block) => block.kind === "field" && block.index === this.page);
		for (let index = current - 1; index >= 0; index--)
			if (this.form.blocks[index].kind === "field") {
				previous = index;
				break;
			}
		for (const block of this.form.blocks.slice(previous + 1, current)) {
			if (spacious && body.length) body.push("");
			this.renderBlock(block, body, width);
		}
		if (spacious && body.length) body.push("");
		body.push(...this.wrapLabel(theme.bold(`${field.label}${field.required ? " *" : ""}`), width));
		if (spacious) body.push("");
		const control = this.controls[this.page];
		if (control.kind === "choices") {
			for (let index = 0; index < field.options.length + Number(this.hasOther()); index++) {
				if (spacious && index > 0) body.push("");
				const start = body.length;
				const selected =
					index === field.options.length
						? this.values[this.page].useOther
						: this.values[this.page].selected.has(index);
				const focused = index === this.choice;
				const marker = field.multiple
					? icon(selected ? "checkboxChecked" : "checkboxUnchecked")
					: icon(selected ? "radioChecked" : "radioUnchecked");
				const prefix = `${theme.fg("accent", focused ? "› " : "  ")}${theme.fg(selected ? "success" : "dim", marker)} `;
				const label = field.options[index]?.label ?? "Other (type your own)";
				body.push(
					...this.wrapMarkdown(
						label,
						width,
						prefix,
						focused ? { color: (text) => theme.fg("accent", text), bold: true } : undefined,
					),
				);
				this.choiceRows.set(index, { start, end: body.length });
			}
			if (this.values[this.page].useOther) this.renderControl(control.other, body, width, 2);
		} else this.renderControl(control.kind === "input" ? control.input : control.editor, body, width, 2);
	}

	private renderReview(body: string[], width: number, spacious: boolean): void {
		this.syncValues();
		for (let index = 0; index < this.form.fields.length; index++) {
			if (spacious && index > 0) body.push("");
			const field = this.form.fields[index];
			const value = this.values[index];
			const answers =
				this.controls[index].kind === "choices"
					? [
							...field.options.flatMap((option, optionIndex) =>
								value.selected.has(optionIndex) ? [option.label] : [],
							),
							...(value.useOther ? [value.other] : []),
						]
					: [value.text];
			body.push(...this.wrapMarkdown(`**${field.label}:**`, width));
			for (const answer of answers.length ? answers : [""])
				body.push(...this.wrapMarkdown(answer || theme.fg("muted", "(not answered)"), width, "  "));
		}
		const lastField = this.form.blocks.findLastIndex((block) => block.kind === "field");
		for (const block of this.form.blocks.slice(lastField + 1)) {
			if (spacious && body.length) body.push("");
			this.renderBlock(block, body, width);
		}
	}

	private renderControl(control: Input | FormTextEditor, body: string[], width: number, indent: number): void {
		const prefix = " ".repeat(Math.min(indent, Math.max(0, width - 1)));
		const lines = control.render(Math.max(1, width - prefix.length));
		const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
		this.inputRow = body.length + Math.max(0, cursor);
		body.push(...lines.map((line) => prefix + line));
	}

	private wrapLabel(text: string, width: number, prefix = ""): string[] {
		const first = truncateToWidth(prefix, Math.max(0, width - 1), "");
		const indent = " ".repeat(visibleWidth(first));
		return wrapTextWithAnsi(text, Math.max(1, width - indent.length)).map((line, index) =>
			truncateToWidth(`${index === 0 ? first : indent}${line}`, width, ""),
		);
	}

	private wrapMarkdown(text: string, width: number, prefix = "", style?: DefaultTextStyle): string[] {
		const first = truncateToWidth(prefix, Math.max(0, width - 1), "");
		const indent = " ".repeat(visibleWidth(first));
		return new Markdown(text, 0, 0, getMarkdownTheme(), style)
			.render(Math.max(1, width - indent.length))
			.map((line, index) => truncateToWidth(`${index === 0 ? first : indent}${line}`, width, ""));
	}

	private renderActions(
		width: number,
		budget: number,
		spacious: boolean,
		scrollable: boolean,
	): { lines: string[]; action?: { start: number; end: number } } {
		if (!budget) return { lines: [] };
		const lines: string[] = [];
		if (spacious && budget >= 5) lines.push("");
		if (budget >= 3) lines.push(theme.fg("borderMuted", "─".repeat(width)));
		const status = this.error || (this.validating ? "Validating…" : "");
		if (status)
			lines.push(
				...this.wrapLabel(theme.fg(this.error ? "error" : "muted", status), width).slice(
					0,
					Math.min(2, budget - lines.length - 1),
				),
			);
		const review = this.page === this.form.fields.length;
		const next = this.page === this.form.fields.length - 1 ? "Review answers" : "Next question";
		const button = review ? `[ ${icon("submit")} Submit answers ]` : `[ ${next} ]`;
		const start = lines.length;
		lines.push(
			...this.wrapLabel(theme.bold(theme.fg("accent", button)), width).slice(0, Math.min(2, budget - start)),
		);
		const end = lines.length;
		const field = this.form.fields[this.page];
		const other = field && this.controls[this.page].kind === "choices" && this.choice === field.options.length;
		const advance = this.page === this.form.fields.length - 1 ? "review" : "next";
		const confirm = review
			? "submit"
			: other && !this.values[this.page].useOther
				? "edit Other"
				: field.multiple || other || this.controls[this.page].kind !== "choices"
					? advance
					: `choose & ${advance}`;
		const key = (binding: Keybinding) => this.keys.getKeys(binding).join("/");
		const hints = [`${key("tui.select.confirm")} ${confirm}`, `${key("tui.select.cancel")} cancel`];
		if (!review) hints.push(`${key("tui.input.tab")} ${advance}`);
		if (field && this.controls[this.page].kind === "choices") {
			hints.push(`${key("tui.select.up")}/${key("tui.select.down")} move`);
			if (!other || !this.values[this.page].useOther) hints.push(`${key("app.ask.toggle")} toggle`);
		} else if (field?.kind === "textarea") hints.push(`${key("tui.input.newLine")} newline`);
		hints.push(`${key("app.ask.previous")} back`);
		if (scrollable) hints.push(`${key("tui.select.pageUp")}/${key("tui.select.pageDown")} scroll`);
		hints.push(`${key("app.ask.submit")} submit`);
		const hintRows = spacious ? Math.min(4, Math.floor(this.tui.terminal.rows / 4)) : 1;
		lines.push(
			...this.wrapLabel(theme.fg("muted", hints.join(" · ")), width).slice(
				0,
				Math.min(hintRows, budget - lines.length),
			),
		);
		return { lines, action: { start, end } };
	}

	private revealRows(start: number, end: number): void {
		if (start < this.offset || end - start >= this.height) this.offset = start;
		else if (end > this.offset + this.height) this.offset = end - this.height;
	}

	private renderBlock(block: FormBlock, lines: string[], width: number): void {
		if (block.kind === "markdown") lines.push(...new Markdown(block.text, 0, 0, getMarkdownTheme()).render(width));
		if (block.kind !== "image") return;
		const state = this.images.get(block)!;
		lines.push(truncateToWidth(block.alt, width));
		if (state.kind === "ready") {
			const start = lines.length;
			lines.push(...state.image.render(width));
			this.imageRows.push({ start, end: lines.length, alt: block.alt });
		} else
			lines.push(
				truncateToWidth(state.kind === "loading" ? "Loading image…" : `Image unavailable: ${state.message}`, width),
			);
	}

	private hasOther(): boolean {
		const field = this.form.fields[this.page];
		return (
			field.kind === "radio" || (field.kind === "checkbox" && field.options.length > 1) || field.kind === "select"
		);
	}

	private toggleChoice(): void {
		const field = this.form.fields[this.page];
		const value = this.values[this.page];
		if (this.choice === field.options.length) {
			value.useOther = !value.useOther;
			if (value.useOther) this.followInput = true;
			if (!field.multiple && value.useOther) value.selected.clear();
		} else {
			const selected = value.selected.has(this.choice);
			if (!field.multiple) {
				value.selected.clear();
				value.useOther = false;
			}
			if (selected) value.selected.delete(this.choice);
			else value.selected.add(this.choice);
		}
	}

	private movePage(delta: number): void {
		this.syncValues();
		this.page = Math.max(0, Math.min(this.form.fields.length, this.page + delta));
		this.choice = this.values[this.page]?.selected.values().next().value ?? 0;
		this.offset = 0;
		this.followChoice = false;
		this.followInput = false;
		this.error = "";
		this.focusControl();
		this.tui.requestRender();
	}

	private focusControl(): void {
		for (let index = 0; index < this.controls.length; index++) {
			const control = this.controls[index];
			const focused = this._focused && this.page === index;
			if (control.kind === "input") control.input.focused = focused;
			else if (control.kind === "textarea") control.editor.focused = focused;
			else
				control.other.focused =
					focused && this.choice === this.form.fields[index].options.length && this.values[index].useOther;
		}
	}

	private syncValues(): void {
		for (let index = 0; index < this.controls.length; index++) {
			const control = this.controls[index];
			if (control.kind === "input") this.values[index].text = control.input.getValue();
			else if (control.kind === "textarea") this.values[index].text = control.editor.getExpandedText();
			else this.values[index].other = control.other.getValue();
		}
	}

	private async submit(): Promise<void> {
		if (this.closed || this.validating) return;
		this.syncValues();
		this.validating = true;
		this.tui.requestRender();
		try {
			const result = await validateForm(this.form, this.values, this.mediaController.signal);
			if (this.closed) return;
			if (result.kind === "valid") this.finish({ kind: "submitted", answers: result.answers });
			else {
				this.page = result.field;
				this.choice = this.values[this.page].selected.values().next().value ?? 0;
				this.offset = 0;
				this.error = result.message;
				this.focusControl();
			}
		} catch (error) {
			if (!this.closed) this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.validating = false;
			if (!this.closed) this.tui.requestRender();
		}
	}

	private finish(result: FormResult): void {
		if (this.closed) return;
		this.closed = true;
		this.signal.removeEventListener("abort", this.onAbort);
		this.mediaController.abort();
		this.done(result);
	}
}

class FormTextEditor extends Editor {
	protected override shouldCollapsePaste(): boolean {
		return false;
	}
	protected override getMaxVisibleLines(): number {
		return 5;
	}
}
