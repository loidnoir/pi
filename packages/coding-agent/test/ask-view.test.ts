import { stripVTControlCharacters } from "node:util";
import {
	CURSOR_MARKER,
	Image,
	setKeybindings,
	TuiMainScreen,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { PNG } from "pngjs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { parseQuestionForm } from "../src/core/ask/form.ts";
import { type FormResult, QuestionFormView } from "../src/core/ask/view.ts";
import { type KeybindingsConfig, KeybindingsManager } from "../src/core/keybindings.ts";
import { icon, setIconPreset } from "../src/modes/interactive/icons.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const views: QuestionFormView[] = [];
const html = `<form><p>Choose where the changes will run.</p>
<fieldset><legend>Deployment target</legend>
<label><input type="radio" name="target" value="preview" checked>Preview</label>
<label><input type="radio" name="target" value="prod">Production</label>
</fieldset></form>`;

beforeAll(() => initTheme("dark"));
afterEach(() => {
	for (const view of views.splice(0)) view.dispose();
	setIconPreset("unicode");
	vi.restoreAllMocks();
});

function fixture(source = html, bindings: KeybindingsConfig = {}) {
	const keys = new KeybindingsManager(bindings);
	setKeybindings(keys);
	const tui = new TuiMainScreen(new VirtualTerminal(80, 40));
	const done = vi.fn<(result: FormResult) => void>();
	const controller = new AbortController();
	const view = new QuestionFormView(parseQuestionForm(source), tui, keys, "/tmp", controller.signal, done);
	view.focused = true;
	views.push(view);
	return { view, done, controller };
}

function plain(lines: string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")).trimEnd());
}

function mouse(y: number, width = 80, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 4,
		y,
		screenX: 4,
		screenY: y,
		width,
		height: 40,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}

describe("question form presentation", () => {
	it("separates the header, question, choices and review action at normal height", () => {
		const { view, done } = fixture();
		const rendered = view.render(80, 30);
		const lines = plain(rendered);
		const question = lines.indexOf("Deployment target");
		const preview = lines.findIndex((line) => line.includes("Preview"));
		const production = lines.findIndex((line) => line.includes("Production"));
		const other = lines.findIndex((line) => line.includes("Other (type your own)"));
		const divider = lines.findIndex((line) => /^─+$/.test(line));
		expect(lines[1]).toBe("");
		expect(lines[question - 1]).toBe("");
		expect(lines[question + 1]).toBe("");
		expect(lines[preview + 1]).toBe("");
		expect(production).toBe(preview + 2);
		expect(other).toBe(production + 2);
		expect(lines[divider - 1]).toBe("");
		expect(lines[divider + 1]).toBe("[ Review answers ]");
		expect(lines.join("\n")).toContain("enter choose & review");
		expect(lines.join("\n")).not.toContain("Answers are not submitted yet");
		expect(rendered[preview]).toContain(theme.fg("success", icon("radioChecked")));
		expect(rendered[production]).toContain(theme.fg("dim", icon("radioUnchecked")));
		expect(done).not.toHaveBeenCalled();
	});

	it("distinguishes next-question navigation from actual submission", () => {
		const { view, done } = fixture(html.replace("</form>", '<label>Notes<input name="notes"></label></form>'));
		expect(plain(view.render(80, 30)).join("\n")).toContain("[ Next question ]");
		view.handleInput("\r");
		expect(plain(view.render(80, 30)).join("\n")).toContain("[ Review answers ]");
		view.handleInput("\r");
		const review = plain(view.render(80, 30)).join("\n");
		expect(review).toContain("Submit answers");
		expect(review).toContain("enter submit");
		expect(review).not.toContain("toggle");
		expect(done).not.toHaveBeenCalled();
	});

	it("uses compact rows on short terminals and always respects maxHeight", () => {
		const { view } = fixture();
		const lines = plain(view.render(80, 8));
		expect(lines).toHaveLength(8);
		expect(lines).not.toContain("");
		expect(lines).toContain("[ Review answers ]");
		view.handleInput("\x1b[B");
		view.handleInput("\x1b[B");
		expect(plain(view.render(80, 8)).some((line) => line.startsWith("›") && line.includes("Other"))).toBe(true);
		for (const height of [1, 2, 3, 4, 5, 8, 12, 18]) {
			const rendered = view.render(20, height);
			expect(rendered.length).toBeLessThanOrEqual(height);
			expect(rendered.every((line) => visibleWidth(line) <= 20)).toBe(true);
		}
	});

	it.each(["unicode", "nerd"] as const)(
		"keeps Markdown, Unicode wrapping and hanging indents with %s icons",
		(preset) => {
			setIconPreset(preset);
			const { view } = fixture(`<form><fieldset><legend>A longer question that must wrap</legend>
<label><input type="radio" name="target" value="a" checked>Use **bold** and *emphasis* with \`api.ts\`, 日本語 👩‍💻 é safely</label>
</fieldset></form>`);
			const rendered = view.render(28, 40);
			const lines = plain(rendered);
			const first = lines.findIndex((line) => line.includes("Use bold"));
			const last = lines.findIndex((line) => line.includes("safely"));
			const indent = " ".repeat(3 + visibleWidth(icon("radioChecked")));
			expect(first).toBeGreaterThan(0);
			expect(last).toBeGreaterThan(first);
			for (const line of lines.slice(first + 1, last + 1)) expect(line.startsWith(indent)).toBe(true);
			const text = lines.map((line) => line.trim()).join(" ");
			expect(text).toContain("must wrap");
			expect(text).toContain("日本語");
			expect(text).toContain("👩‍💻 é");
			expect(lines.join("\n")).not.toContain("**");
			expect(lines.join("\n")).not.toContain("`api.ts`");
			expect(rendered.join("\n")).toContain(theme.fg("mdCode", "api.ts"));
			expect(rendered.join("\n")).toContain(theme.italic(theme.fg("accent", "emphasis")));
			expect(rendered.every((line) => visibleWidth(line) <= 28)).toBe(true);
			view.handleInput("\t");
			const review = view.render(28, 40);
			expect(plain(review).join("\n")).not.toContain("`api.ts`");
			expect(review.join("\n")).toContain(theme.fg("mdCode", "api.ts"));
			expect(review.every((line) => visibleWidth(line) <= 28)).toBe(true);
		},
	);

	it("hits wrapped choice lines, ignores gaps, and submits only from the separated review button", async () => {
		const { view, done } = fixture(`<form><fieldset><legend>Checks</legend>
<label><input type="checkbox" name="checks" value="safe">Review the **changes** carefully and deploy safely</label>
<label><input type="checkbox" name="checks" value="skip">Skip checks</label>
</fieldset></form>`);
		let lines = plain(view.render(30, 30));
		const continuation = lines.findIndex((line) => line.includes("safely"));
		expect(view.handleMouse(mouse(continuation, 30))).toEqual({ handled: true });
		lines = plain(view.render(30, 30));
		expect(lines.some((line) => line.includes(icon("checkboxChecked")))).toBe(true);
		expect(view.handleMouse(mouse(continuation + 1, 30))).toBeUndefined();
		const next = lines.indexOf("[ Review answers ]");
		expect(view.handleMouse(mouse(next, 30))).toEqual({ handled: true });
		expect(done).not.toHaveBeenCalled();
		lines = plain(view.render(18, 30));
		const divider = lines.findIndex((line) => /^─+$/.test(line));
		expect(view.handleMouse(mouse(divider - 1, 18))).toBeUndefined();
		expect(view.handleMouse(mouse(divider, 18))).toBeUndefined();
		const submit = lines.findIndex((line) => line.includes("Submit"));
		expect(lines[submit + 1]).toContain("]");
		expect(view.handleMouse(mouse(submit + 1, 18))).toEqual({ handled: true });
		await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ kind: "submitted", answers: { checks: ["safe"] } }));
	});

	it("keeps a scrolled choice aligned with the pointer and review scroll independent of submission", () => {
		const context = Array.from({ length: 20 }, (_, index) => `Context line ${index}.`).join("<br>");
		const options = Array.from(
			{ length: 8 },
			(_, index) => `<label><input type="radio" name="pick" value="${index}">Option ${index}</label>`,
		).join("");
		const { view, done } = fixture(
			`<form><p>${context}</p><fieldset><legend>Pick one</legend>${options}</fieldset><p>${context}</p></form>`,
		);
		const initial = plain(view.render(50, 8));
		view.handleInput("\x1b[6~");
		expect(plain(view.render(50, 8))).not.toEqual(initial);
		view.handleMouse(mouse(1, 50, { type: "wheel", button: "none", wheelDelta: 3 }));
		expect(plain(view.render(50, 8))[1]).not.toBe(initial[1]);
		for (let index = 0; index < 7; index++) view.handleInput("\x1b[B");
		const choices = plain(view.render(50, 8));
		const chosen = choices.findIndex((line) => line.includes("Option 7"));
		expect(chosen).toBeGreaterThan(0);
		expect(view.handleMouse(mouse(chosen, 50))).toEqual({ handled: true });
		view.handleInput("\t");
		const review = plain(view.render(50, 8));
		expect(review.join("\n")).toContain("Option 7");
		expect(review.join("\n")).toContain("Submit answers");
		view.handleInput("\x1b[6~");
		const scrolled = plain(view.render(50, 8));
		expect(scrolled).not.toEqual(review);
		expect(scrolled.join("\n")).toContain("Submit answers");
		expect(done).not.toHaveBeenCalled();
		view.handleInput("\x1b[Z");
		expect(plain(view.render(50, 8))).toEqual(initial);
	});

	it("follows the editable Other answer after spacing and preserves the submitted text", async () => {
		const { view, done } = fixture('<form><label><input type="radio" name="pick" value="a">Option A</label></form>');
		view.render(32, 8);
		view.handleInput("\x1b[B");
		view.render(32, 8);
		view.handleInput("\r");
		expect(view.render(32, 8).some((line) => line.includes(CURSOR_MARKER))).toBe(true);
		view.handleInput("\x1b[200~custom 日本語 answer\x1b[201~");
		view.handleInput("\r");
		expect(plain(view.render(32, 18)).join("\n")).toContain("custom 日本語 answer");
		expect(done).not.toHaveBeenCalled();
		view.handleInput("\r");
		await vi.waitFor(() =>
			expect(done).toHaveBeenCalledWith({ kind: "submitted", answers: { pick: "custom 日本語 answer" } }),
		);
	});

	it("uses configured contextual hints and renders Markdown in free-text review answers", () => {
		const { view } = fixture(
			'<form><label>Notes<input name="notes" value="Use **care** with `api.ts`"></label></form>',
			{
				"tui.select.confirm": "f3",
				"tui.input.tab": "f4",
				"app.ask.previous": "f5",
				"app.ask.submit": "f6",
				"tui.select.cancel": "f7",
			},
		);
		let rendered = view.render(80, 30);
		expect(plain(rendered).join("\n")).toContain("f3 review · f7 cancel · f4 review · f5 back · f6 submit");
		view.handleInput("\x1bOR");
		rendered = view.render(80, 30);
		expect(plain(rendered).join("\n")).toContain("Use care with api.ts");
		expect(rendered.join("\n")).toContain(theme.fg("mdCode", "api.ts"));
		expect(plain(rendered).join("\n")).toContain("f3 submit");
	});

	it("keeps validation errors and cancellation available in the action area", async () => {
		const { view, done, controller } = fixture('<form><label>Answer<input name="answer" required></label></form>');
		view.handleInput("\t");
		view.render(40, 8);
		view.handleInput("\r");
		await vi.waitFor(() => expect(plain(view.render(40, 8)).join("\n")).toContain("an answer is required"));
		expect(view.render(40, 8).length).toBeLessThanOrEqual(8);
		expect(done).not.toHaveBeenCalled();
		controller.abort();
		expect(done).toHaveBeenCalledWith({ kind: "cancelled" });
	});

	it("replaces clipped images but shows the complete image when the viewport grows", async () => {
		const image = new PNG({ width: 1, height: 1 });
		image.data.fill(255);
		const data = PNG.sync.write(image).toString("base64");
		const renderImage = vi
			.spyOn(Image.prototype, "render")
			.mockReturnValue(["image top", "image middle", "image bottom"]);
		const { view } = fixture(
			`<form><img src="data:image/png;base64,${data}" alt="Diagram"><input name="answer"></form>`,
		);
		await vi.waitFor(() => expect(plain(view.render(60, 6)).join("\n")).toContain("[Diagram: scroll to view image]"));
		expect(renderImage).toHaveBeenCalled();
		const expanded = plain(view.render(60, 24)).join("\n");
		expect(expanded).toContain("image top\nimage middle\nimage bottom");
		expect(expanded).not.toContain("scroll to view image");
	});
});
