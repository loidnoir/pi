import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import askExtension from "../src/extensions/ask/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { icon, setIconPreset } from "../src/modes/interactive/icons.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const html =
	'<form><p>Choose carefully.</p><fieldset><legend>Target</legend><label><input name="target" type="radio" value="internal-preview" checked>Preview</label><label><input name="target" type="radio" value="internal-prod">Production</label></fieldset><label>Instances<input name="instances" type="number" value="2" min="0" max="4"></label></form>';

beforeEach(() => {
	initTheme("dark");
	setIconPreset("unicode");
});
afterEach(() => {
	vi.restoreAllMocks();
	setIconPreset("unicode");
});

async function row(args: unknown = { html }) {
	const extension = await loadExtensionFromFactory(askExtension, "/tmp", createEventBus(), createExtensionRuntime());
	return new ToolExecutionComponent(
		"ask",
		"ask-render",
		args,
		{},
		extension.tools.get("ask")!.definition,
		{ requestRender() {} },
		"/tmp",
	);
}

function text(component: ToolExecutionComponent, width = 100): string {
	const lines = component.render(width);
	expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	return stripAnsi(lines.join("\n"));
}

describe("ask transcript rendering", () => {
	it("keeps unfinished calls title-only, then groups submitted labels and exact values with every question", async () => {
		const component = await row();
		expect(text(component).trim()).toBe("? ask");
		component.updateResult({
			content: [{ type: "text", text: '{"target":"internal-prod","instances":0}' }],
			details: { kind: "submitted", answers: { target: "internal-prod", instances: 0 } },
			isError: false,
		});
		const submitted = text(component);
		expect(submitted).toContain("Submitted");
		expect(submitted).not.toContain("Pending");
		expect(submitted).toContain("Production (value: internal-prod)");
		expect(submitted).not.toContain("<form>");
		expect(submitted).not.toContain('{"target":');
		expect(submitted).toMatch(/Answer: Production[\s\S]*Instances[\s\S]*Answer: 0/);
		expect(submitted.match(/Target/g)).toHaveLength(1);
		expect(submitted).not.toContain("Choose carefully");
	});

	it("expands ordered Markdown, image descriptions and suggestions without submitting defaults or loading media", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		const component = await row({
			html: '<form><h2>Deployment context</h2><p>Compare <strong>cost</strong> first.</p><label>Count<input name="count" type="number" value="0" required min="0" max="8" step="2"></label><img src="https://example.com/private.png" alt="Architecture overview"><label>Notes<textarea name="notes" minlength="2" maxlength="40" placeholder="Explain why">suggested note</textarea></label><p>Review before submitting.</p></form>',
		});
		expect(text(component)).not.toContain("Deployment context");
		component.updateResult({ content: [], details: { kind: "cancelled" }, isError: false });
		component.setExpanded(true);
		const expanded = text(component);
		expect(expanded).toContain("Deployment context");
		expect(expanded).toContain("Compare cost first");
		expect(expanded).toMatch(/Count[\s\S]*Image: Architecture overview[\s\S]*Notes/);
		expect(expanded).toContain("Review before submitting");
		expect(expanded).toContain("required · number · min: 0 · max: 8 · step: 2");
		expect(expanded).toContain("min length: 2 · max length: 40");
		expect(expanded).toContain("Placeholder: Explain why");
		expect(expanded).toContain("Default (suggestion only): 0");
		expect(expanded).toContain("Default (suggestion only): suggested note");
		expect(expanded).not.toContain("Answer:");
		expect(expanded).not.toContain("private.png");
		expect(fetch).not.toHaveBeenCalled();
		component.updateResult({
			content: [{ type: "text", text: '{"count":2,"notes":"actual note"}' }],
			details: { kind: "submitted", answers: { count: 2, notes: "actual note" } },
			isError: false,
		});
		expect(text(component)).toContain("Answer: actual note");
		expect(text(component)).toContain("Default (suggestion only): suggested note");
		component.setExpanded(false);
		expect(text(component)).not.toContain("Default");
	});

	it("preserves multiple and custom answers, zero, multiline text, empty answers and optional omissions", async () => {
		const component = await row({
			html: '<form><label>Regions<select name="regions" multiple><option value="internal-east">East</option><option value="internal-west">West</option></select></label><label>Zero<input name="zero" type="number"></label><label>Notes<textarea name="notes"></textarea></label><label>Empty<input name="empty"></label><label>Omitted<input name="omitted" type="number"></label><fieldset><legend>Consent</legend><label><input name="consent" type="checkbox" value="internal-yes">I agree</label></fieldset><label>Prototype<input name="__proto__"></label><label>Constructor<input name="constructor"></label></form>',
		});
		component.updateResult({
			content: [{ type: "text", text: "unused model JSON" }],
			details: {
				kind: "submitted",
				answers: {
					regions: ["internal-east", "internal-west", "Custom region"],
					zero: 0,
					notes: "  first\nsecond  ",
					empty: "",
					consent: "internal-yes",
				},
			},
			isError: false,
		});
		const submitted = text(component);
		expect(submitted).toMatch(
			/Answer:\s*\n\s*- East \(value: internal-east\)\s*\n\s*- West \(value: internal-west\)\s*\n\s*- Custom region/,
		);
		expect(submitted).toContain("Answer: 0");
		expect(submitted).toContain("Answer:   first");
		expect(submitted).toContain("second");
		expect(submitted).toContain("Answer: (empty)");
		expect(submitted.match(/Answer: \(skipped\)/g)).toHaveLength(3);
		expect(submitted).toContain("Answer: I agree");
		expect(submitted).toContain("I agree (value: internal-yes)");
		expect(submitted).toMatch(
			/Consent\s*\n\s*Choices:\s*\n\s*- I agree\s*\n\s*Answer: I agree \(value: internal-yes\)/,
		);
		component.updateResult({
			content: [],
			details: {
				kind: "submitted",
				answers: JSON.parse('{"__proto__":"own prototype","constructor":"own constructor"}'),
			},
			isError: false,
		});
		expect(text(component)).toContain("Answer: own prototype");
		expect(text(component)).toContain("Answer: own constructor");
	});

	it("distinguishes cancellation and execution errors from submission without accepting suggested answers", async () => {
		const component = await row();
		component.updateResult({ content: [], details: { kind: "cancelled" }, isError: false });
		const cancelled = text(component);
		expect(cancelled).toContain("Cancelled — no answers submitted");
		expect(cancelled).not.toContain("Pending");
		expect(cancelled).not.toContain("Answer:");
		component.updateResult({
			content: [{ type: "text", text: "Form failed: validation unavailable" }],
			details: { kind: "submitted", answers: { target: "internal-preview" } },
			isError: true,
		});
		const error = text(component);
		expect(error).toContain("Error — no answers submitted");
		expect(error).toContain("Form failed: validation unavailable");
		expect(error).not.toContain("Answer:");
	});

	it("handles absent, partial and invalid arguments and unavailable result details without raw dumps", async () => {
		const component = await row({});
		expect(text(component).trim()).toBe("? ask");
		component.updateResult({ content: [], isError: false });
		expect(text(component)).toContain("Waiting for form HTML");
		component.updateArgs({ html: "<form><input" });
		expect(text(component)).toContain("Form preview unavailable");
		component.updateArgs({ html: '<form><script>bad()</script><input name="answer"></form>' });
		component.setArgsComplete();
		expect(text(component)).toContain("Use semantic HTML only");
		expect(text(component)).not.toContain("bad()");
		component.updateArgs({ html });
		expect(text(component)).toContain("Target");
		component.updateResult({ content: [{ type: "text", text: '{"target":"internal-preview"}' }], isError: false });
		expect(text(component)).toContain("Result unavailable");
		expect(text(component)).not.toContain("internal-preview");
		expect(text(component)).not.toContain("Answer:");
		component.updateArgs({ html: 42 });
		component.updateResult({
			content: [],
			details: { kind: "submitted", answers: { note: "Preserved answer" } },
			isError: false,
		});
		expect(text(component)).toContain("note — Answer: Preserved answer");
	});

	it("exports a title-only call and complete grouped results without a stale pending preview", async () => {
		const extension = await loadExtensionFromFactory(
			askExtension,
			"/tmp",
			createEventBus(),
			createExtensionRuntime(),
		);
		const renderer = createToolHtmlRenderer({
			getToolRenderers: (name) => extension.tools.get(name)?.definition,
			theme,
			cwd: "/tmp",
		});
		const call = renderer.renderCall("export-ask", "ask", { html });
		expect(call).toBeDefined();
		expect(call).toContain("ask");
		expect(call).not.toMatch(/Pending|Target|Preview|Instances/);
		const result = renderer.renderResult(
			"export-ask",
			"ask",
			[],
			{ kind: "submitted", answers: { target: "internal-prod", instances: 0 } },
			false,
		);
		for (const output of [result?.collapsed, result?.expanded]) {
			expect(output).toBeDefined();
			expect(output).toContain("Submitted");
			expect(output?.match(/Target/g)).toHaveLength(1);
			expect(output).toMatch(/Target[\s\S]*Production \(value: internal-prod\)[\s\S]*Instances[\s\S]*Answer: 0/);
			expect(output).not.toContain("Pending");
		}
		expect(result?.expanded).toContain("Choose carefully");
	});

	it("preserves selection boundaries, duplicate option labels and literal custom values that collide with option values", async () => {
		const component = await row({
			html: '<form><label>Regions<select name="regions" multiple><option>East</option><option>West</option><option>East · West</option></select></label><label>Target<select name="target"><option value="internal-prod">Production</option><option value="internal-backup">Production</option></select></label><label>Literal<input name="literal"></label></form>',
		});
		const submit = (regions: string[]) =>
			component.updateResult({
				content: [],
				details: { kind: "submitted", answers: { regions, target: "internal-prod", literal: "East" } },
				isError: false,
			});
		submit(["East · West"]);
		const literal = text(component);
		expect(literal).toMatch(/Answer:\s*\n\s*- East · West/);
		expect(literal).toMatch(/Choices:\s*\n\s*- East\s*\n\s*- West\s*\n\s*- East · West/);
		expect(literal).toMatch(
			/Choices:\s*\n\s*- Production \(value: internal-prod\)\s*\n\s*- Production \(value: internal-backup\)/,
		);
		expect(literal).toContain("Answer: Production (value: internal-prod)");
		expect(literal).toContain("Answer: East");
		expect(literal).not.toContain("East (value: East)");
		submit(["East", "West"]);
		const separate = text(component);
		expect(separate).toMatch(/Answer:\s*\n\s*- East\s*\n\s*- West/);
		expect(separate).not.toMatch(/Answer:\s*\n\s*- East · West/);
	});

	it("keeps multiline option text inside a single selection item", async () => {
		const component = await row({
			html: '<form><label>Regions<select name="regions" multiple><option selected>East\n- West</option><option>East</option><option>West</option></select></label></form>',
		});
		const submit = (regions: string[]) =>
			component.updateResult({
				content: [],
				details: { kind: "submitted", answers: { regions } },
				isError: false,
			});
		const answer = () =>
			text(component)
				.split("Answer:")[1]
				.split("\n")
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd();
		submit(["East\n- West"]);
		expect(answer()).toBe("\n - East\n   - West");
		expect(text(component)).toMatch(/Choices:\s*\n - East\s*\n {3}- West/);
		component.setExpanded(true);
		expect(text(component)).toMatch(/Default \(suggestion only\):\s*\n - East\s*\n {3}- West/);
		component.setExpanded(false);
		submit(["East", "West"]);
		expect(answer()).toBe("\n - East\n - West");
	});

	it("sanitizes terminal controls and refreshes wrapping, themes and icons independently of the parsed form", async () => {
		const component = await row({
			html: '<form><p>日本語 context</p><label>Long descriptive answer<input name="answer"></label></form>',
		});
		component.updateResult({
			content: [],
			details: {
				kind: "submitted",
				answers: { answer: "日本語\u001b]52;c;secret\u0007\u001b[31m answer\u009b2J\u0000\u007f\ufff9\r\nnext" },
			},
			isError: false,
		});
		const clean = text(component);
		expect(clean).toContain("Answer: 日本語 answer");
		expect(clean).toContain("next");
		expect(clean).not.toMatch(/secret|52;c|31m|2J|[\u0000\u007f\u009b\ufff9\r]/);
		const dark = component.render(100);
		initTheme("light");
		setIconPreset("nerd");
		component.invalidate();
		expect(component.render(100)).not.toEqual(dark);
		expect(text(component)).toContain(`${icon("question")} ask`);
		component.setExpanded(true);
		for (const width of [12, 25, 80]) expect(text(component, width)).toContain("context");
	});
});
