import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { CURSOR_MARKER, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PaneControls } from "../src/core/panes/host.ts";
import {
	type ModelDashboardOptions,
	type ModelDashboardOverrides,
	type ModelDashboardScope,
	ModelDashboardView,
} from "../src/core/panes/model-dashboard.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

function text(view: ModelDashboardView, width = 160, height = 40): string {
	return stripAnsi(view.render(width, height).join("\n"));
}

function choose(view: ModelDashboardView, label: string): void {
	for (let step = 0; step < 20; step++) {
		const selected = text(view)
			.split("\n")
			.find((line) => line.startsWith("→"));
		if (selected?.slice(2).trimStart().startsWith(label)) {
			view.handleInput(ENTER);
			return;
		}
		view.handleInput(DOWN);
	}
	throw new Error(`No selected row matching ${label}: ${text(view)}`);
}

describe("model dashboard", () => {
	let harness: Harness;
	let view: ModelDashboardView;
	let controls: PaneControls;
	let options: ModelDashboardOptions;
	let model: Model<string>;
	let layers: Map<string, ModelDashboardOverrides>;

	beforeAll(() => initTheme("dark"));
	beforeEach(async () => {
		setKeybindings(new KeybindingsManager());
		harness = await createHarness({
			models: [
				{ id: "alpha", reasoning: true },
				{ id: "beta", reasoning: false },
			],
		});
		// Match the selector tests: never refresh a real provider catalog.
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		model = harness.getModel("alpha")!;
		layers = new Map();
		controls = {
			invalidate: vi.fn(),
			close: vi.fn(),
			minimize: vi.fn(async () => {}),
			setTitle: vi.fn(async () => {}),
		};
		options = {
			targets: [
				{ id: "main", label: "Main thread", description: "The main conversation" },
				{ id: "btw", label: "BTW default" },
				{ id: "reviewer", label: "Sub-agent: reviewer" },
			],
			modelRuntime: harness.session.modelRuntime,
			scopedModels: [{ model: harness.getModel("beta")! }],
			projectTrusted: true,
			read: vi.fn((id: string, scope: ModelDashboardScope) => layers.get(`${id}/${scope}`) ?? {}),
			resolve: vi.fn((_id: string, _scope: ModelDashboardScope, draft: ModelDashboardOverrides) => ({
				model: draft.model ? harness.session.modelRuntime.getModel(draft.model.provider, draft.model.id) : model,
				thinkingLevel: draft.thinkingLevel ?? "medium",
				fastMode: draft.fastMode ?? false,
			})),
			save: vi.fn(async (id: string, scope: ModelDashboardScope, draft: ModelDashboardOverrides) => {
				layers.set(`${id}/${scope}`, draft);
			}),
		};
		view = new ModelDashboardView(controls, options);
	});
	afterEach(async () => {
		await view.dispose();
		harness.cleanup();
		vi.restoreAllMocks();
	});

	it("shows every supplied target using session-effective settings and read-only model metadata", () => {
		expect(text(view)).toContain("Main thread");
		expect(text(view)).toContain("BTW default");
		expect(text(view)).toContain("Sub-agent: reviewer");
		expect(options.resolve).toHaveBeenCalledWith("reviewer", "session", {});
		choose(view, "Main thread");
		expect(text(view)).toContain(`Effective: alpha [${model.provider}]`);
		expect(text(view)).toContain("Context");
		expect(text(view)).toContain("$/1M tokens: input");
		expect(text(view)).toContain("Previewing selected scope draft");
		expect(options.save).not.toHaveBeenCalled();
	});

	it("stages null, deletion and scope reset without touching stored overrides until Apply", async () => {
		const stored = { thinkingLevel: "high" as ThinkingLevel, fastMode: false };
		layers.set("btw/session", stored);
		choose(view, "BTW default");
		choose(view, "Thinking:");
		choose(view, "Inherit main");
		expect(text(view)).toContain("Thinking: inherit main");
		expect(stored.thinkingLevel).toBe("high");
		choose(view, "Apply");
		await vi.waitFor(() => expect(text(view)).toContain("Applied session settings."));
		expect(options.save).toHaveBeenLastCalledWith("btw", "session", { thinkingLevel: null, fastMode: false });
		choose(view, "Thinking:");
		choose(view, "Default / inherit");
		choose(view, "Apply");
		await vi.waitFor(() => expect(text(view)).toContain("Applied session settings."));
		expect(options.save).toHaveBeenLastCalledWith("btw", "session", { fastMode: false });
		choose(view, "Reset scope");
		expect(text(view)).toContain("unsaved draft");
		choose(view, "Apply");
		await vi.waitFor(() => expect(options.save).toHaveBeenLastCalledWith("btw", "session", {}));
	});

	it("labels main null as a startup/default reset rather than main inheritance", async () => {
		choose(view, "Main thread");
		choose(view, "Thinking:");
		choose(view, "Reset to startup/default");
		expect(text(view)).toContain("Thinking: startup/default");
		choose(view, "Apply");
		await vi.waitFor(() => expect(options.save).toHaveBeenCalledWith("main", "session", { thinkingLevel: null }));
	});

	it("discards on Escape and keeps each target and scope isolated", () => {
		choose(view, "Sub-agent: reviewer");
		choose(view, "Save scope:");
		choose(view, "Global");
		choose(view, "Thinking:");
		choose(view, "Inherit main");
		choose(view, "Save scope:");
		choose(view, "Session");
		expect(text(view)).toContain("Apply or discard this draft");
		view.handleInput(ESC);
		view.handleInput(ESC);
		expect(text(view)).toContain("Model dashboard");
		choose(view, "BTW default");
		expect(text(view)).toContain("Thinking: default");
		expect(options.save).not.toHaveBeenCalled();
	});

	it("saves the chosen layer and rejects untrusted project scope", async () => {
		choose(view, "Sub-agent: reviewer");
		choose(view, "Save scope:");
		choose(view, "Project");
		expect(text(view)).toContain("Apply saves project defaults for future child launches.");
		choose(view, "Apply");
		await vi.waitFor(() => expect(options.save).toHaveBeenCalledWith("reviewer", "project", {}));
		await view.dispose();
		view = new ModelDashboardView(controls, { ...options, projectTrusted: false });
		choose(view, "Main thread");
		choose(view, "Save scope:");
		choose(view, "Project");
		expect(text(view)).toContain("Trust this project before saving");
	});

	it.each([
		["Main thread", "Session", "Apply updates the current conversation."],
		["Main thread", "Project", "Apply updates the current conversation and saves project defaults."],
		["Main thread", "Global", "Apply updates the current conversation and saves global defaults."],
		["BTW default", "Session", "Apply changes future BTW chats in this session."],
		["BTW default", "Project", "Apply saves project defaults for future BTW chats."],
		["BTW default", "Global", "Apply saves global defaults for future BTW chats."],
		["Sub-agent: reviewer", "Session", "Apply changes future child launches in this session."],
		["Sub-agent: reviewer", "Project", "Apply saves project defaults for future child launches."],
		["Sub-agent: reviewer", "Global", "Apply saves global defaults for future child launches."],
	])("describes %s at %s scope accurately", (target, scope, effect) => {
		choose(view, target);
		choose(view, "Save scope:");
		expect(text(view)).toContain(effect);
		choose(view, scope);
		expect(text(view)).toContain(effect);
		expect(text(view)).toContain("keep their settings.");
	});

	it("lets an unavailable saved model be replaced after Apply reports the missing model", async () => {
		layers.set("main/session", { model: { provider: model.provider, id: "missing-model" } });
		vi.mocked(options.save).mockImplementation(async (_id, _scope, draft) => {
			if (draft.model && !options.modelRuntime.getModel(draft.model.provider, draft.model.id))
				throw new Error("Saved model is unavailable; choose another model.");
		});
		choose(view, "Main thread");
		expect(text(view)).toContain("Effective: No model");
		choose(view, "Apply");
		await vi.waitFor(() => expect(text(view)).toContain("Saved model is unavailable"));
		choose(view, "Model:");
		choose(view, "Choose model");
		view.handleInput(ENTER);
		expect(text(view)).toContain(`Model: ${model.provider}/beta`);
		choose(view, "Apply");
		await vi.waitFor(() => expect(text(view)).toContain("Applied session settings."));
		expect(options.save).toHaveBeenLastCalledWith("main", "session", {
			model: { provider: model.provider, id: "beta" },
		});
	});

	it("reuses model search, scoped/all switching and refresh without saving the selection", async () => {
		choose(view, "Main thread");
		choose(view, "Model:");
		choose(view, "Choose model");
		expect(text(view)).toContain("Scope:");
		expect(text(view)).toContain(CURSOR_MARKER);
		view.focused = false;
		expect(text(view)).not.toContain(CURSOR_MARKER);
		view.focused = true;
		view.handleInput("\t");
		for (const char of "alpha") view.handleInput(char);
		expect(text(view)).toContain("alpha");
		view.handleInput(ENTER);
		expect(text(view)).toContain(`Model: ${model.provider}/alpha`);
		expect(options.modelRuntime.refresh).toHaveBeenCalled();
		expect(options.save).not.toHaveBeenCalled();
		choose(view, "Apply");
		await vi.waitFor(() =>
			expect(options.save).toHaveBeenCalledWith("main", "session", {
				model: { provider: model.provider, id: "alpha" },
			}),
		);
	});

	it("shows only supported thinking levels and keeps selector cancel local", () => {
		model = harness.getModel("beta")!;
		choose(view, "Main thread");
		choose(view, "Thinking:");
		choose(view, "Choose thinking");
		expect(text(view)).toContain("off");
		expect(text(view)).not.toContain("Deep reasoning");
		view.handleInput(ESC);
		expect(text(view)).toContain("Choose thinking level");
		choose(view, "Choose thinking");
		view.handleInput(ENTER);
		expect(text(view)).toContain("Thinking: off");
		expect(options.save).not.toHaveBeenCalled();
	});

	it("limits fast selection to Codex responses and warns about higher usage", async () => {
		choose(view, "Main thread");
		choose(view, "Fast:");
		expect(text(view)).toContain("Fast inactive");
		choose(view, "Fast inactive");
		expect(text(view)).toContain("Fast requires");
		view.handleInput(ESC);
		model = { ...model, provider: "openai-codex", api: "openai-codex-responses" };
		choose(view, "Fast:");
		expect(text(view)).toContain("higher usage");
		choose(view, "On");
		choose(view, "Apply");
		await vi.waitFor(() => expect(options.save).toHaveBeenCalledWith("main", "session", { fastMode: true }));
	});

	it.each([
		{ provider: "other-provider", api: "openai-codex-responses" },
		{ provider: "openai-codex", api: "openai-responses" },
	])("shows stale fast as inactive and allows Off, not On, for $provider/$api", async (unsupported) => {
		model = { ...model, ...unsupported };
		layers.set("main/session", { fastMode: true });
		expect(text(view, 220)).toContain("fast inactive");
		expect(text(view, 220)).not.toContain("fast on");
		choose(view, "Main thread");
		expect(text(view)).toContain("fast inactive (configured on; unsupported model)");
		expect(text(view)).toContain("Fast: inactive (on)");
		choose(view, "Fast:");
		expect(text(view)).not.toMatch(/^\s*(?:→ )?On\b/m);
		choose(view, "Off");
		expect(text(view)).toContain("Fast: inactive (off)");
		choose(view, "Apply");
		await vi.waitFor(() => expect(options.save).toHaveBeenCalledWith("main", "session", { fastMode: false }));
	});

	it("uses configured navigation, Apply and minimize keys", async () => {
		setKeybindings(
			new KeybindingsManager({
				"tui.select.down": "ctrl+n",
				"tui.select.confirm": "ctrl+y",
				"app.models.save": "ctrl+r",
				"app.pane.minimize": "ctrl+g",
			}),
		);
		view.handleInput("\x0e");
		view.handleInput("\x19");
		expect(text(view)).toContain("BTW default · session");
		expect(text(view)).toContain("ctrl+r Apply");
		view.handleInput("\x13");
		expect(options.save).not.toHaveBeenCalled();
		view.handleInput("\x12");
		await vi.waitFor(() => expect(options.save).toHaveBeenCalledWith("btw", "session", {}));
		view.handleInput("\x07");
		expect(controls.minimize).toHaveBeenCalledOnce();
	});

	it("blocks duplicate saves and draft input while Apply is busy, then reports errors", async () => {
		const pending = Promise.withResolvers<void>();
		vi.mocked(options.save).mockReturnValue(pending.promise);
		choose(view, "Main thread");
		choose(view, "Apply");
		expect(text(view)).toContain("Applying…");
		view.handleInput("\x13");
		view.handleInput(ESC);
		expect(controls.close).not.toHaveBeenCalled();
		expect(options.save).toHaveBeenCalledOnce();
		pending.reject(new Error("Could not persist settings"));
		await vi.waitFor(() => expect(text(view)).toContain("Could not persist settings"));
		expect(text(view, 35, 3)).toContain("Could not persist settings");
		expect(text(view, 35, 1)).toContain("Could not persist settings");
	});

	it("clips narrow panes while keeping selection and selector search visible", () => {
		choose(view, "Main thread");
		for (const height of [1, 2, 4, 8]) {
			for (const width of [1, 8, 24]) {
				const lines = view.render(width, height);
				expect(lines.length).toBeLessThanOrEqual(height);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			}
		}
		choose(view, "Model:");
		choose(view, "Choose model");
		const small = text(view, 24, 3);
		expect(small).toContain(CURSOR_MARKER);
		expect(small).toContain("→");
		expect(view.render(0, 3)).toEqual([]);
	});

	it("notifies close once before waiting for Apply and aborts selector refresh on disposal", async () => {
		const onClose = vi.fn();
		options.onClose = onClose;
		const pending = Promise.withResolvers<void>();
		vi.mocked(options.save).mockReturnValue(pending.promise);
		choose(view, "Main thread");
		choose(view, "Apply");
		const disposal = view.dispose();
		expect(onClose).toHaveBeenCalledOnce();
		const repeatedDisposal = view.dispose();
		expect(onClose).toHaveBeenCalledOnce();
		let disposed = false;
		void disposal.then(() => {
			disposed = true;
		});
		vi.mocked(controls.invalidate).mockClear();
		await Promise.resolve();
		expect(disposed).toBe(false);
		expect(controls.close).not.toHaveBeenCalled();
		pending.reject(new Error("late"));
		await Promise.all([disposal, repeatedDisposal]);
		expect(onClose).toHaveBeenCalledOnce();
		expect(disposed).toBe(true);
		expect(controls.invalidate).not.toHaveBeenCalled();
		view = new ModelDashboardView(controls, options);
		const refresh = Promise.withResolvers<ModelsRefreshResult>();
		vi.mocked(options.modelRuntime.refresh).mockReturnValue(refresh.promise);
		choose(view, "Main thread");
		choose(view, "Model:");
		choose(view, "Choose model");
		const signal = vi.mocked(options.modelRuntime.refresh).mock.calls.at(-1)?.[0]?.signal;
		await view.dispose();
		vi.mocked(controls.invalidate).mockClear();
		await vi.waitFor(() => expect(signal?.aborted).toBe(true));
		refresh.resolve({ aborted: false, errors: new Map() });
		await Promise.resolve();
		expect(controls.invalidate).not.toHaveBeenCalled();
	});
});
