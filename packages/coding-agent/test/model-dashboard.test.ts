import type { Model } from "@earendil-works/pi-ai";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createModelDashboardOptions } from "../src/core/model-dashboard-controller.ts";
import type { PaneControls } from "../src/core/panes/host.ts";
import {
	type ModelDashboardOptions,
	type ModelDashboardOverrides,
	type ModelDashboardScope,
	ModelDashboardView,
} from "../src/core/panes/model-dashboard.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";

describe("model dashboard", () => {
	let harness: Harness;
	let view: ModelDashboardView;
	let controls: PaneControls;
	let options: ModelDashboardOptions;
	let model: Model<string>;
	let layers: Map<string, ModelDashboardOverrides>;
	let controller: AbortController;

	function keys(...input: string[]): void {
		for (const key of input) view.handleInput(key);
	}

	function text(width = 160, height = 40): string {
		return stripAnsi(view.render(width, height).join("\n"));
	}

	beforeAll(() => initTheme("dark"));
	beforeEach(async () => {
		setKeybindings(new KeybindingsManager({ "app.pane.minimize": "ctrl+g" }));
		harness = await createHarness({
			models: [
				{ id: "alpha", reasoning: true },
				{ id: "beta", reasoning: false },
			],
		});
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		model = harness.getModel("alpha")!;
		layers = new Map();
		controller = new AbortController();
		controls = {
			invalidate: vi.fn(),
			close: vi.fn(),
			minimize: vi.fn(async () => {}),
			setTitle: vi.fn(async () => {}),
		};
		options = {
			targets: [
				{ id: "main", label: "Main thread" },
				{ id: "btw", label: "BTW default" },
			],
			modelRuntime: harness.session.modelRuntime,
			scopedModels: [{ model: harness.getModel("beta")! }],
			projectTrusted: true,
			signal: controller.signal,
			onClose: vi.fn(() => controller.abort()),
			read: vi.fn((id: string, scope: ModelDashboardScope) => layers.get(`${id}/${scope}`) ?? {}),
			resolve: vi.fn((_id: string, _scope: ModelDashboardScope, draft: ModelDashboardOverrides) => ({
				model: draft.model ? harness.session.modelRuntime.getModel(draft.model.provider, draft.model.id) : model,
				thinkingLevel: draft.thinkingLevel ?? "medium",
				fastMode: draft.fastMode ?? false,
			})),
			save: vi.fn(async (id, scope, draft) => {
				layers.set(`${id}/${scope}`, draft);
			}),
		};
		view = new ModelDashboardView(controls, options);
	});
	afterEach(async () => {
		controller.abort();
		await view.dispose().catch(() => {});
		harness.cleanup();
		vi.restoreAllMocks();
	});

	it("previews inline choices and retains them across back, minimize and reopen until overview close", async () => {
		vi.mocked(controls.close).mockImplementation(() => {
			void view.dispose();
		});
		keys(DOWN, ENTER, DOWN, TAB, ESC, "\x07");
		expect(
			text()
				.split("\n")
				.find((line) => line.includes("BTW default")),
		).toContain("beta");
		expect(controls.minimize).toHaveBeenCalledOnce();
		keys(ENTER, DOWN, DOWN, TAB, ESC);
		expect(options.save).not.toHaveBeenCalled();
		expect(controls.close).not.toHaveBeenCalled();
		keys(ESC);
		await vi.waitFor(() => expect(controls.close).toHaveBeenCalledOnce());
		expect(options.save).toHaveBeenCalledExactlyOnceWith("btw", "session", {
			model: { provider: model.provider, id: "beta" },
			thinkingLevel: "off",
		});
		await view.dispose();
		expect(options.save).toHaveBeenCalledOnce();
	});

	it("saves main before dependent targets and wider scopes first, resuming only unsaved drafts after failure", async () => {
		keys(DOWN, ENTER, DOWN, TAB, ESC);
		keys(UP, ENTER, DOWN, TAB);
		keys(UP, TAB, DOWN, TAB);
		keys(UP, TAB, DOWN, TAB, ESC);
		const pending = Promise.withResolvers<void>();
		vi.mocked(options.save).mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error("Storage full"));
		keys(ESC, ESC, DOWN, TAB);
		await vi.waitFor(() => expect(options.save).toHaveBeenCalledOnce());
		expect(options.save).toHaveBeenNthCalledWith(1, "main", "global", expect.anything());
		pending.resolve();
		await vi.waitFor(() => expect(text(25, 1)).toContain("Storage full"));
		expect(controls.close).not.toHaveBeenCalled();
		keys(ESC);
		await vi.waitFor(() => expect(controls.close).toHaveBeenCalledOnce());
		expect(vi.mocked(options.save).mock.calls.map(([id, scope]) => `${id}/${scope}`)).toEqual([
			"main/global",
			"main/project",
			"main/project",
			"main/session",
			"btw/session",
		]);
	});

	it("preserves a model switched while minimized when only thinking was edited", async () => {
		layers.set("main/session", { model: { provider: model.provider, id: "alpha" } });
		keys(ENTER, DOWN, DOWN, TAB, "\x07");
		const latest = { model: { provider: model.provider, id: "beta" }, fastMode: false };
		layers.set("main/session", latest);
		expect(text()).toContain(`${model.provider}/beta`);
		keys(ESC, ESC);
		await vi.waitFor(() => expect(controls.close).toHaveBeenCalledOnce());
		expect(options.save).toHaveBeenCalledExactlyOnceWith("main", "session", { ...latest, thinkingLevel: "off" });
	});

	it("reads a half-inherited project model again after saving a wider model change", async () => {
		await view.dispose();
		controller = new AbortController();
		const files = {
			global: JSON.stringify({ defaultModel: "alpha", defaultProvider: model.provider }),
			project: JSON.stringify({ defaultProvider: model.provider }),
		};
		const settings = SettingsManager.fromStorage({
			withLock(scope, update) {
				const next = update(files[scope]);
				if (next !== undefined) files[scope] = next;
			},
		});
		const live = createModelDashboardOptions(harness.session, settings, harness.tempDir, controller.signal);
		view = new ModelDashboardView(controls, {
			...live,
			scopedModels: [{ model }, { model: harness.getModel("beta")! }],
		});
		keys(ENTER, TAB, DOWN, DOWN, TAB, UP, UP, TAB, DOWN, TAB, ESC, ESC);
		await vi.waitFor(() => expect(controls.close).toHaveBeenCalledOnce());
		expect(settings.getGlobalSettings().defaultModel).toBe("beta");
		expect(settings.getProjectSettings()).toMatchObject({
			defaultProvider: model.provider,
			defaultThinkingLevel: "off",
		});
		expect(settings.getProjectSettings().defaultModel).toBeUndefined();
		expect(harness.session.model?.id).toBe("beta");
	});

	it("previews session edits over the selection the pending wider main save will apply", () => {
		layers.set("main/session", { model: { provider: model.provider, id: "alpha" } });
		keys(ENTER, TAB, TAB, DOWN, TAB, UP, TAB, DOWN, DOWN, TAB, ESC);
		expect(
			text()
				.split("\n")
				.find((line) => line.includes("Main thread")),
		).toContain("beta");
	});

	it("keeps a more specific session edit when a wider main save also changes the live selection", async () => {
		await view.dispose();
		controller = new AbortController();
		harness.session.setThinkingLevel("medium");
		const live = createModelDashboardOptions(
			harness.session,
			harness.settingsManager,
			harness.tempDir,
			controller.signal,
		);
		view = new ModelDashboardView(controls, live);
		keys(ENTER, DOWN, DOWN, TAB, UP, UP, TAB, TAB, DOWN, DOWN, TAB, ESC, ESC);
		await vi.waitFor(() => expect(controls.close).toHaveBeenCalledOnce());
		expect(harness.settingsManager.getGlobalSettings().defaultThinkingLevel).toBe("off");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("reports a changed edited field without writing and allows a new selection", async () => {
		keys(ENTER, DOWN, DOWN, TAB, ESC);
		layers.set("main/session", { thinkingLevel: "high", fastMode: true });
		keys(ESC);
		await vi.waitFor(() => expect(text()).toContain("changed"));
		expect(options.save).not.toHaveBeenCalled();
		expect(controls.close).not.toHaveBeenCalled();
		keys(ENTER, DOWN, DOWN, TAB, ESC, ESC);
		await vi.waitFor(() => expect(controls.close).toHaveBeenCalledOnce());
		expect(options.save).toHaveBeenCalledExactlyOnceWith("main", "session", {
			thinkingLevel: "minimal",
			fastMode: true,
		});
	});

	it("cycles supported thinking, explicit inheritance and field deletion without mutating the stored layer", async () => {
		model = harness.getModel("beta")!;
		const stored = { thinkingLevel: "off", fastMode: true } as const;
		layers.set("btw/session", stored);
		keys(DOWN, ENTER, DOWN, DOWN, TAB);
		expect(text()).toContain("inherit main");
		keys(TAB, DOWN, TAB);
		expect(text()).toContain("Fast inactive");
		expect(stored).toEqual({ thinkingLevel: "off", fastMode: true });
		keys(ESC, ESC);
		await vi.waitFor(() =>
			expect(options.save).toHaveBeenCalledExactlyOnceWith("btw", "session", { fastMode: false }),
		);
	});

	it("offers on/off for Codex and skips untrusted project scope", async () => {
		model = { ...model, provider: "openai-codex", api: "openai-codex-responses" };
		options.projectTrusted = false;
		keys(ENTER, TAB, UP, TAB);
		expect(text()).toContain("higher usage");
		expect(text()).toContain("not trusted");
		keys(ESC, ESC);
		await vi.waitFor(() =>
			expect(options.save).toHaveBeenCalledExactlyOnceWith("main", "global", { fastMode: true }),
		);
	});

	it("closes without writing when a full cycle returns to the saved model", async () => {
		const alpha = harness.getModel("alpha")!;
		const beta = harness.getModel("beta")!;
		vi.spyOn(options.modelRuntime, "getAvailableSnapshot").mockReturnValue([alpha, beta]);
		layers.set("main/session", { model: { id: beta.id, provider: beta.provider } });
		keys(ENTER, DOWN, TAB);
		expect(text()).toContain(`${alpha.provider}/${alpha.id}`);
		keys(TAB);
		expect(text()).toContain("startup/default");
		keys(TAB, TAB, ESC, ESC);
		await vi.waitFor(() => expect(controls.close).toHaveBeenCalledOnce());
		expect(options.save).not.toHaveBeenCalled();
	});

	it("refreshes an empty catalog and includes newly configured models in the cycle", async () => {
		const beta = harness.getModel("beta")!;
		const snapshot = vi.spyOn(options.modelRuntime, "getAvailableSnapshot").mockReturnValue([]);
		vi.mocked(options.modelRuntime.refresh).mockImplementationOnce(async () => {
			snapshot.mockReturnValue([beta]);
			return { errors: new Map(), aborted: false };
		});
		await view.dispose();
		controller = new AbortController();
		view = new ModelDashboardView(controls, { ...options, signal: controller.signal, scopedModels: [] });
		await vi.waitFor(() => expect(controls.invalidate).toHaveBeenCalled());
		keys(ENTER, DOWN, TAB, ESC, ESC);
		await vi.waitFor(() =>
			expect(options.save).toHaveBeenCalledExactlyOnceWith("main", "session", {
				model: { provider: beta.provider, id: beta.id },
			}),
		);
	});

	it("previews the most specific staged main layer and passes only dirty layers to inherited targets", () => {
		keys(ENTER, TAB, DOWN, TAB, UP, TAB, DOWN, TAB, ESC);
		vi.mocked(options.resolve).mockClear();
		text();
		const [main, btw] = vi.mocked(options.resolve).mock.calls;
		expect(main.slice(0, 2)).toEqual(["main", "project"]);
		expect(btw.slice(0, 2)).toEqual(["btw", "session"]);
		const pending = btw[3]!;
		expect(pending("main", "session")).toBeUndefined();
		expect(pending("btw", "session")).toBeUndefined();
		expect(pending("main", "global")).toEqual({ model: { provider: model.provider, id: "beta" } });
	});

	it("keeps the selected field reachable with configured navigation and shows warnings in clipped panes", () => {
		setKeybindings(
			new KeybindingsManager({
				"tui.select.up": "ctrl+p",
				"tui.select.confirm": "ctrl+y",
				"tui.input.tab": "ctrl+r",
			}),
		);
		options.warning = "Profile configuration errors:\n\x1b[31mmissing role\x1b[0m";
		keys("\x19", "\x10", "\x12");
		expect(text(40, 3)).toContain("Fast:");
		expect(text(48, 3)).toContain("Profile configuration errors: missing role");
		for (const line of view.render(12, 2)) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
		expect(vi.mocked(options.save)).not.toHaveBeenCalled();
	});

	it("flushes the open editor on native disposal before signalling close, without duplicate saves", async () => {
		keys(ENTER, DOWN, TAB);
		const pending = Promise.withResolvers<void>();
		vi.mocked(options.save).mockReturnValue(pending.promise);
		const disposal = Promise.all([view.dispose(), view.dispose()]);
		await vi.waitFor(() => expect(options.save).toHaveBeenCalledOnce());
		expect(controller.signal.aborted).toBe(false);
		pending.resolve();
		await disposal;
		expect(options.onClose).toHaveBeenCalledOnce();
		expect(controls.close).not.toHaveBeenCalled();
	});

	it("discards drafts on aborted disposal and never writes to the replaced session", async () => {
		keys(ENTER, DOWN, TAB);
		controller.abort();
		keys(ESC, ESC);
		await view.dispose();
		expect(options.save).not.toHaveBeenCalled();
	});

	it("stops an in-flight batch before touching another layer on runtime replacement", async () => {
		const pending = Promise.withResolvers<void>();
		vi.mocked(options.save).mockReturnValue(pending.promise);
		keys(ENTER, DOWN, TAB, ESC, DOWN, ENTER, DOWN, TAB, ESC, ESC);
		await vi.waitFor(() => expect(options.save).toHaveBeenCalledOnce());
		controller.abort();
		const disposal = view.dispose();
		pending.resolve();
		await disposal;
		expect(options.save).toHaveBeenCalledOnce();
		expect(controls.close).not.toHaveBeenCalled();
	});

	it("recovers only unsaved native-close drafts on reopening the same live session", async () => {
		const recoveryKey = {};
		options.recoveryKey = recoveryKey;
		keys(ENTER, DOWN, TAB, ESC, DOWN, ENTER, DOWN, DOWN, TAB);
		vi.mocked(options.save).mockResolvedValueOnce().mockRejectedValueOnce(new Error("Not persisted"));
		await expect(view.dispose()).rejects.toThrow("Not persisted");
		controller = new AbortController();
		view = new ModelDashboardView(controls, { ...options, recoveryKey: {}, signal: controller.signal });
		await view.dispose();
		expect(options.save).toHaveBeenCalledTimes(2);
		controller = new AbortController();
		view = new ModelDashboardView(controls, { ...options, signal: controller.signal });
		expect(text()).toContain("Not persisted");
		keys(ESC);
		await vi.waitFor(() => expect(controls.close).toHaveBeenCalledOnce());
		expect(vi.mocked(options.save).mock.calls.map(([id]) => id)).toEqual(["main", "btw", "btw"]);
	});

	it("reports an interrupted close failure to the native host instead of retrying", async () => {
		const pending = Promise.withResolvers<void>();
		vi.mocked(options.save).mockReturnValue(pending.promise);
		keys(ENTER, DOWN, TAB, ESC, ESC);
		await vi.waitFor(() => expect(options.save).toHaveBeenCalledOnce());
		const disposal = view.dispose();
		pending.reject(new Error("Not persisted"));
		await expect(disposal).rejects.toThrow("Not persisted");
		expect(options.save).toHaveBeenCalledOnce();
		expect(options.onClose).toHaveBeenCalledOnce();
	});
});
