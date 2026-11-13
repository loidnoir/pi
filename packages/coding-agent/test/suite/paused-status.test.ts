import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Container, TuiMainScreen } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionUIContext, WorkingIndicatorOptions } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { FullscreenExitOutput } from "../../src/core/settings-manager.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import {
	IdleStatus,
	type StatusIndicator,
	WorkingStatusIndicator,
} from "../../src/modes/interactive/components/status-indicator.ts";
import { icon, setIconPreset } from "../../src/modes/interactive/icons.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness } from "./harness.ts";

interface StatusMethods {
	subscribeToRecovery(this: StatusContext): void;
	updateRecoveryStatusIndicator(this: StatusContext): void;
	showWorkingStatusIndicator(this: StatusContext): void;
	showStatusIndicator(this: StatusContext, indicator: StatusIndicator): void;
	clearStatusIndicator(this: StatusContext, kind?: StatusIndicator["kind"]): void;
	setEditorWorkingStatusIndicator(this: StatusContext, indicator: StatusIndicator | undefined): boolean;
	setWorkingVisible(this: StatusContext, visible: boolean): void;
	setWorkingIndicator(this: StatusContext, options?: WorkingIndicatorOptions): void;
}

interface StatusContext extends StatusMethods {
	session: AgentSession;
	settingsManager: AgentSession["settingsManager"];
	ui: TuiMainScreen;
	editor: CustomEditor;
	defaultEditor: CustomEditor;
	statusContainer: Container;
	activeStatusIndicator: StatusIndicator | undefined;
	activeWorkingIndicatorEmbedded: boolean;
	idleStatus: IdleStatus;
	workingMessage: string | undefined;
	defaultWorkingMessage: string;
	workingIndicatorOptions: WorkingIndicatorOptions | undefined;
	workingVisible: boolean;
	recoveryStatus: "pausing" | "paused" | undefined;
	unsubscribeRecovery: (() => void) | undefined;
	options: { tuiMode: "regular" };
	isInitialized: boolean;
	disposeActiveSelector(): void;
	themeController: { disableAutoSync(): void };
	clearExtensionTerminalInputListeners(): void;
	footer: { dispose(): void };
	footerDataProvider: { dispose(): void };
	unregisterSignalHandlers(): void;
	showExtensionCustom: ReturnType<typeof vi.fn>;
}

const prototype = InteractiveMode.prototype as unknown as StatusMethods & {
	stop(this: StatusContext, output: FullscreenExitOutput): void;
	createExtensionUIContext(this: StatusContext): ExtensionUIContext;
};
const fixtures: { harness: Harness; context: StatusContext }[] = [];

beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const { harness, context } of fixtures.splice(0)) {
		context.unsubscribeRecovery?.();
		context.activeStatusIndicator?.dispose();
		await harness.session.abort();
		harness.cleanup();
	}
	vi.restoreAllMocks();
	setIconPreset("unicode");
});

async function fixture(embedded = false, tools?: AgentTool[]) {
	const harness = await createHarness({
		tools,
		settings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" },
	});
	const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
	const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager(), { embedWorkingStatus: embedded });
	const context: StatusContext = {
		subscribeToRecovery: prototype.subscribeToRecovery,
		updateRecoveryStatusIndicator: prototype.updateRecoveryStatusIndicator,
		showWorkingStatusIndicator: prototype.showWorkingStatusIndicator,
		showStatusIndicator: prototype.showStatusIndicator,
		clearStatusIndicator: prototype.clearStatusIndicator,
		setEditorWorkingStatusIndicator: prototype.setEditorWorkingStatusIndicator,
		setWorkingVisible: prototype.setWorkingVisible,
		setWorkingIndicator: prototype.setWorkingIndicator,
		session: harness.session,
		settingsManager: harness.settingsManager,
		ui: tui,
		editor,
		defaultEditor: editor,
		statusContainer: new Container(),
		activeStatusIndicator: undefined,
		activeWorkingIndicatorEmbedded: false,
		idleStatus: new IdleStatus(),
		workingMessage: "Custom working message",
		defaultWorkingMessage: "Working",
		workingIndicatorOptions: { frames: ["a", "b"], intervalMs: 25 },
		workingVisible: true,
		recoveryStatus: undefined,
		unsubscribeRecovery: undefined,
		options: { tuiMode: "regular" },
		isInitialized: false,
		disposeActiveSelector() {},
		themeController: { disableAutoSync() {} },
		clearExtensionTerminalInputListeners() {},
		footer: { dispose() {} },
		footerDataProvider: { dispose() {} },
		unregisterSignalHandlers() {},
		showExtensionCustom: vi.fn().mockResolvedValue(undefined),
	};
	fixtures.push({ harness, context });
	context.subscribeToRecovery();
	return {
		harness,
		context,
		text: () => stripAnsi((embedded ? editor.render(120) : context.statusContainer.render(120)).join("\n")),
	};
}

describe("interactive held-execution status", () => {
	it.each([false, true])("shows working, draining, paused, and continued status (embedded=%s)", async (embedded) => {
		const noop: AgentTool = {
			name: "noop",
			label: "No-op",
			description: "No side effects",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const f = await fixture(embedded, [noop]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.harness.setResponses([
			async (_context, options) => {
				entered.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage(
					{ type: "toolCall", id: "noop-call", name: "noop", arguments: {} },
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("Completed normally"),
		]);
		const run = f.harness.session.prompt("Work once");
		await entered.promise;
		f.context.showWorkingStatusIndicator();
		expect(f.text()).toContain("Custom working message");
		const pausing = f.harness.session.recovery.pause();
		expect(f.text()).toContain(`${icon("pause")}  Pausing…`);
		expect(f.text()).not.toContain("Custom working message");
		release.resolve();
		await pausing;
		expect(f.text()).toContain(`${icon("pause")}  Paused`);
		expect(f.context.activeStatusIndicator).toBeInstanceOf(WorkingStatusIndicator);
		f.harness.session.recovery.resume();
		expect(f.text()).toContain("a Custom working message");
		expect(f.text()).not.toContain("Paused");
		await run;
		expect(f.harness.faux.state.callCount).toBe(2);
	});

	it("shows an idle-held session, survives working cleanup, and respects visibility", async () => {
		const f = await fixture();
		expect(f.context.activeStatusIndicator).toBeUndefined();
		await f.harness.session.recovery.pause();
		expect(f.text()).toContain(`${icon("pause")}  Paused`);
		f.context.clearStatusIndicator("working");
		expect(f.text()).toContain("Paused");
		f.context.setWorkingVisible(false);
		expect(f.context.activeStatusIndicator).toBeUndefined();
		f.context.setWorkingVisible(true);
		expect(f.text()).toContain("Paused");
		f.harness.session.recovery.resume();
		expect(f.context.activeStatusIndicator).toBeUndefined();
		expect(f.text()).not.toContain("Paused");
		expect(f.harness.faux.state.callCount).toBe(0);
	});

	it("shows saved child approval as paused before its startup dialog holds binding", async () => {
		const f = await fixture();
		f.harness.session.recovery.registerPeer({
			pause: async () => {},
			resume() {},
			pending: () => [{ id: "child", label: "Pending child" }],
			recover: async () => {},
			discard: async () => {},
		});
		const ui = prototype.createExtensionUIContext.call(f.context);
		await ui.custom(() => ({ render: () => [], invalidate() {} }));
		expect(f.text()).toContain(`${icon("pause")}  Paused`);
		expect(f.text()).not.toContain("Working");
		expect(f.harness.faux.state.callCount).toBe(0);
	});

	it("replaces recovery subscriptions on rebind and releases the final subscription on stop", async () => {
		const f = await fixture();
		const recovery = f.harness.session.recovery;
		const subscribe = recovery.subscribe.bind(recovery);
		const stops: ReturnType<typeof vi.fn>[] = [];
		vi.spyOn(recovery, "subscribe").mockImplementation((listener) => {
			const stop = vi.fn(subscribe(listener));
			stops.push(stop);
			return stop;
		});
		f.context.subscribeToRecovery();
		f.context.subscribeToRecovery();
		expect(stops[0]).toHaveBeenCalledOnce();
		await recovery.pause();
		prototype.stop.call(f.context, "transcript");
		expect(stops[1]).toHaveBeenCalledOnce();
		expect(f.context.activeStatusIndicator).toBeUndefined();
		const render = vi.spyOn(f.context.ui, "requestRender");
		recovery.modelFinished();
		expect(render).not.toHaveBeenCalled();
	});
});
