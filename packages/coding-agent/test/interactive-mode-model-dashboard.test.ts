import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createModelDashboardOptions } from "../src/core/model-dashboard-controller.ts";
import type { PaneHandle, PaneOptions } from "../src/core/panes/host.ts";
import { openPane } from "../src/core/panes/host.ts";
import type { ModelDashboardOptions } from "../src/core/panes/model-dashboard.ts";
import { ModelDashboardView } from "../src/core/panes/model-dashboard.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

vi.mock("../src/core/model-dashboard-controller.ts", () => ({ createModelDashboardOptions: vi.fn() }));
vi.mock("../src/core/panes/host.ts", () => ({ openPane: vi.fn() }));
vi.mock("../src/core/panes/model-dashboard.ts", () => ({ ModelDashboardView: vi.fn() }));

type DashboardState = {
	controller: AbortController;
	opening: Promise<PaneHandle>;
	saves: Set<Promise<void>>;
};

interface DashboardMode {
	runtimeHost: { session: AgentSession; services: { agentDir: string } };
	modelDashboard: DashboardState | undefined;
	modelDashboardClosing: Promise<void> | undefined;
	modelDashboardSuspensions: number;
	isShuttingDown: boolean;
	footer: { invalidate: ReturnType<typeof vi.fn> };
	defaultEditor: {
		onAction: ReturnType<typeof vi.fn>;
		onChange?: (text: string) => void;
		onEscape?: () => void;
		onCtrlD?: () => void;
		onPasteImage?: () => void;
	};
	ui: { onDebug?: () => void };
	createExtensionUIContext: ReturnType<typeof vi.fn>;
	updateAvailableProviderCount: ReturnType<typeof vi.fn>;
	updateEditorBorderColor: ReturnType<typeof vi.fn>;
	maybeWarnAboutAnthropicSubscriptionAuth: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	showModelSelector: ReturnType<typeof vi.fn>;
	findExactModelMatch: ReturnType<typeof vi.fn>;
	setupKeyHandlers(): void;
	handleModelCommand(input?: string): Promise<void>;
	showModelDashboard(options?: Pick<PaneOptions, "backend" | "placement" | "minimized">): Promise<void>;
	closeModelDashboard(): Promise<void>;
	withModelDashboardClosed<T>(action: () => Promise<T>): Promise<T>;
}

function createMode(): DashboardMode {
	// Only the interactive integration's dependencies are supplied; no renderer or model requests run.
	const mode = Object.create(InteractiveMode.prototype) as DashboardMode;
	const session = {
		settingsManager: { getSettings: () => ({}) },
		sessionManager: { getCwd: () => "/project", getBranch: () => [] },
		setModel: vi.fn().mockResolvedValue(undefined),
	} as unknown as AgentSession;
	Object.assign(mode, {
		runtimeHost: { session, services: { agentDir: "/agent" } },
		modelDashboardSuspensions: 0,
		isShuttingDown: false,
		footer: { invalidate: vi.fn() },
		defaultEditor: { onAction: vi.fn() },
		ui: {},
		createExtensionUIContext: vi.fn().mockReturnValue({ setStatus: vi.fn() }),
		updateAvailableProviderCount: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn().mockResolvedValue(undefined),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showModelSelector: vi.fn(),
		findExactModelMatch: vi.fn().mockResolvedValue(undefined),
	});
	return mode;
}

function createPane() {
	const closed = Promise.withResolvers<void>();
	const pane: PaneHandle = {
		backend: "tui",
		placement: undefined,
		closed: closed.promise,
		close: vi.fn(async () => closed.resolve()),
		show: vi.fn().mockResolvedValue(undefined),
		minimize: vi.fn().mockResolvedValue(undefined),
	};
	return { pane, closed };
}

function dashboardOptions(save = vi.fn().mockResolvedValue(undefined)): ModelDashboardOptions {
	return {
		targets: [],
		modelRuntime: {} as ModelDashboardOptions["modelRuntime"],
		scopedModels: [],
		projectTrusted: true,
		read: () => ({}),
		resolve: () => ({ model: undefined, thinkingLevel: "medium", fastMode: false }),
		save,
	};
}

function openedOptions(): ModelDashboardOptions {
	const options = vi.mocked(openPane).mock.calls[0]![1];
	options.create({ invalidate: vi.fn(), close: vi.fn(), minimize: vi.fn(), setTitle: vi.fn() });
	return vi.mocked(ModelDashboardView).mock.calls[0]![1];
}

describe("InteractiveMode model dashboard", () => {
	beforeEach(() => {
		vi.mocked(createModelDashboardOptions).mockReturnValue(dashboardOptions());
		vi.mocked(openPane).mockResolvedValue(createPane().pane);
	});

	afterEach(() => vi.resetAllMocks());

	it("opens the dashboard for no argument without a model lookup", async () => {
		const mode = createMode();
		await mode.handleModelCommand();
		expect(openPane).toHaveBeenCalledOnce();
		expect(mode.findExactModelMatch).not.toHaveBeenCalled();
		expect(mode.showModelSelector).not.toHaveBeenCalled();
	});

	it("forwards standard pane flags", async () => {
		const mode = createMode();
		await mode.handleModelCommand("--rex --floating --minimized");
		expect(openPane).toHaveBeenCalledWith(
			{ ui: { setStatus: expect.any(Function) }, cwd: "/project", mode: "tui" },
			expect.objectContaining({ title: "Models", backend: "rex", placement: "floating", minimized: true }),
		);
		expect(createModelDashboardOptions).toHaveBeenCalledWith(
			mode.runtimeHost.session,
			mode.runtimeHost.session.settingsManager,
			"/agent",
			vi.mocked(openPane).mock.calls[0]![1].signal,
		);
		expect(mode.findExactModelMatch).not.toHaveBeenCalled();
		expect(mode.showModelSelector).not.toHaveBeenCalled();
	});

	it("uses the same dashboard action for the configurable model-selection shortcut", async () => {
		const mode = createMode();
		mode.setupKeyHandlers();
		const action = mode.defaultEditor.onAction.mock.calls.find(([name]) => name === "app.model.select")?.[1] as
			| (() => void)
			| undefined;
		expect(action).toBeDefined();
		action!();
		await mode.showModelDashboard();
		expect(openPane).toHaveBeenCalledOnce();
	});

	it("retains exact-ID quick switches and unmatched-search pickers", async () => {
		const mode = createMode();
		const model = { provider: "faux", id: "exact" };
		mode.findExactModelMatch.mockResolvedValueOnce(model);
		await mode.handleModelCommand("faux/exact");
		expect(mode.runtimeHost.session.setModel).toHaveBeenCalledWith(model, { persist: false });
		expect(mode.maybeWarnAboutAnthropicSubscriptionAuth).toHaveBeenCalledWith(model);
		await mode.handleModelCommand("--tui unmatched search");
		expect(mode.showModelSelector).toHaveBeenCalledWith("unmatched search");
		expect(openPane).not.toHaveBeenCalled();
	});

	it("reports invalid pane flags without starting a model lookup", async () => {
		const mode = createMode();
		await mode.handleModelCommand("--split --minimized");
		expect(mode.showError).toHaveBeenCalledWith("Minimized panes require --floating, not --split");
		expect(mode.findExactModelMatch).not.toHaveBeenCalled();
	});

	it("reuses a dashboard even while it is opening, and can reopen after it closes", async () => {
		const mode = createMode();
		const opening = Promise.withResolvers<PaneHandle>();
		const { pane, closed } = createPane();
		vi.mocked(openPane).mockReturnValueOnce(opening.promise);
		const first = mode.showModelDashboard();
		const second = mode.showModelDashboard();
		expect(openPane).toHaveBeenCalledOnce();
		opening.resolve(pane);
		await Promise.all([first, second]);
		expect(pane.show).toHaveBeenCalledOnce();
		closed.resolve();
		await pane.closed;
		await mode.showModelDashboard();
		expect(openPane).toHaveBeenCalledTimes(2);
	});

	it.each(["session", "project", "global"] as const)(
		"refreshes main metadata after a successful %s save",
		async (scope) => {
			const mode = createMode();
			const save = vi.fn().mockResolvedValue(undefined);
			vi.mocked(createModelDashboardOptions).mockReturnValueOnce(dashboardOptions(save));
			await mode.showModelDashboard();
			const options = openedOptions();
			const draft = { thinkingLevel: "high" as const, fastMode: true };
			await options.save("main", scope, draft);
			expect(save).toHaveBeenCalledWith("main", scope, draft);
			expect(mode.footer.invalidate).toHaveBeenCalledOnce();
			expect(mode.updateEditorBorderColor).toHaveBeenCalledOnce();
			expect(mode.maybeWarnAboutAnthropicSubscriptionAuth).toHaveBeenCalledOnce();
		},
	);

	it.each([
		{ enabled: true, supported: true, status: "fast (priority)" },
		{ enabled: true, supported: false, status: "fast (inactive)" },
		{ enabled: false, supported: true, status: undefined },
	])("refreshes fast metadata: $status", async ({ enabled, supported, status }) => {
		const mode = createMode();
		vi.spyOn(mode.runtimeHost.session.settingsManager, "getSettings").mockReturnValue({ defaultFastMode: enabled });
		Object.assign(mode.runtimeHost.session, {
			model: { provider: supported ? "openai-codex" : "other", api: "openai-codex-responses" },
		});
		await mode.showModelDashboard();
		await openedOptions().save("main", "global", {});
		const ui = mode.createExtensionUIContext.mock.results[0]!.value as { setStatus: ReturnType<typeof vi.fn> };
		expect(ui.setStatus).toHaveBeenCalledWith("fast", status);
	});

	it("refreshes metadata after failed persistence but leaves the error to the dashboard", async () => {
		const mode = createMode();
		vi.mocked(createModelDashboardOptions).mockReturnValueOnce(
			dashboardOptions(vi.fn().mockRejectedValue(new Error("Main session is busy"))),
		);
		await mode.showModelDashboard();
		await expect(openedOptions().save("main", "session", {})).rejects.toThrow("Main session is busy");
		expect(mode.footer.invalidate).toHaveBeenCalledOnce();
		expect(mode.showStatus).not.toHaveBeenCalled();
	});

	it("aborts an opening pane and waits for its close before replacing the session", async () => {
		const mode = createMode();
		const opening = Promise.withResolvers<PaneHandle>();
		vi.mocked(openPane).mockReturnValueOnce(opening.promise);
		const showing = mode.showModelDashboard();
		const signal = vi.mocked(openPane).mock.calls[0]![1].signal!;
		const replace = vi.fn().mockResolvedValue("replaced");
		const replacing = mode.withModelDashboardClosed(replace);
		expect(signal.aborted).toBe(true);
		expect(replace).not.toHaveBeenCalled();
		const { pane } = createPane();
		opening.resolve(pane);
		await showing;
		expect(await replacing).toBe("replaced");
		expect(pane.close).toHaveBeenCalledOnce();
		expect(mode.modelDashboard).toBeUndefined();
	});

	it("drains saves before replacement, rejects stale callbacks, and blocks opening during replacement", async () => {
		const mode = createMode();
		const saving = Promise.withResolvers<void>();
		const save = vi.fn().mockReturnValue(saving.promise);
		vi.mocked(createModelDashboardOptions).mockReturnValueOnce(dashboardOptions(save));
		await mode.showModelDashboard();
		const options = openedOptions();
		const applying = options.save("main", "global", {});
		const replacement = Promise.withResolvers<void>();
		const replace = vi.fn().mockReturnValue(replacement.promise);
		const replacing = mode.withModelDashboardClosed(replace);
		await mode.showModelDashboard();
		expect(replace).not.toHaveBeenCalled();
		await expect(options.save("main", "session", {})).rejects.toThrow();
		expect(save).toHaveBeenCalledOnce();
		saving.resolve();
		await applying;
		await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
		await mode.showModelDashboard();
		expect(openPane).toHaveBeenCalledOnce();
		expect(mode.footer.invalidate).not.toHaveBeenCalled();
		replacement.resolve();
		await replacing;
	});

	it("aborts the dashboard lifetime as native close starts, before a pending save or pane closes", async () => {
		const mode = createMode();
		const saving = Promise.withResolvers<void>();
		const save = vi.fn().mockReturnValue(saving.promise);
		vi.mocked(createModelDashboardOptions).mockReturnValueOnce(dashboardOptions(save));
		const { pane } = createPane();
		const closed = vi.fn();
		void pane.closed.then(closed);
		vi.mocked(openPane).mockResolvedValueOnce(pane);
		await mode.showModelDashboard();
		const options = openedOptions();
		const signal = vi.mocked(openPane).mock.calls[0]![1].signal!;
		const applying = options.save("main", "global", {});

		expect(signal.aborted).toBe(false);
		expect(options.onClose).toBeDefined();
		options.onClose!();
		expect(signal.aborted).toBe(true);
		expect(mode.modelDashboard!.saves.size).toBe(1);
		expect(closed).not.toHaveBeenCalled();
		await expect(options.save("main", "session", {})).rejects.toThrow();
		expect(save).toHaveBeenCalledOnce();

		saving.resolve();
		await applying;
		expect(mode.footer.invalidate).not.toHaveBeenCalled();
		expect(mode.showStatus).not.toHaveBeenCalled();
		expect(closed).not.toHaveBeenCalled();
		await mode.closeModelDashboard();
	});

	it("cleans failed openings so another invocation can retry", async () => {
		const mode = createMode();
		vi.mocked(openPane).mockRejectedValueOnce(new Error("Cannot open pane"));
		await mode.showModelDashboard();
		expect(mode.showError).toHaveBeenCalledWith("Cannot open pane");
		await mode.showModelDashboard();
		expect(openPane).toHaveBeenCalledTimes(2);
	});
});
