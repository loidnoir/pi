// Pane-local side chat with native messages, selectors, and a bottom-anchored multiline prompt.
import type { Agent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { contentText, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	Editor,
	type EditorHost,
	type Focusable,
	getKeybindings,
	Loader,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { ModelSelectorComponent } from "../../modes/interactive/components/model-selector.ts";
import { ThinkingSelectorComponent } from "../../modes/interactive/components/thinking-selector.ts";
import { getEditorTheme, theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { estimateContextTokens } from "../compaction/compaction.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { ChatTranscript } from "./chat-transcript.ts";
import type { PaneControls, PaneView } from "./host.ts";

export interface SideChatRuntimeControls {
	setModel(model: Model<string>): void;
	setThinkingLevel(level: ThinkingLevel): void;
	getAvailableThinkingLevels(): ThinkingLevel[];
}

export interface SideChatViewOptions {
	cwd?: string;
	/** First side-owned message; inherited main context is never displayed. */
	firstMessage?: number;
	saved?: boolean;
	/** A missing original parent permits history viewing, but not contextual continuation. */
	continuationError?: string;
	runtime?: SideChatRuntimeControls;
	modelRuntime?: ModelRuntime;
	scopedModels?: readonly ScopedModel[];
	close?(): Promise<void>;
}

type Selector =
	| { kind: "model"; component: ModelSelectorComponent }
	| { kind: "thinking"; component: ThinkingSelectorComponent };

/** Display side-owned turns while retaining inherited context only in the agent. */
export class SideChatView implements PaneView, Focusable {
	readonly agent: Agent;
	private readonly controls: PaneControls;
	private readonly options: SideChatViewOptions;
	private readonly firstMessage: number;
	private readonly editorHost: EditorHost;
	private readonly editor: SideChatEditor;
	private readonly transcript: ChatTranscript;
	private readonly unsubscribe: () => void;
	private selector: Selector | undefined;
	private disposed = false;
	private expandedTools = false;
	private hideThinkingBlock = false;
	private promptPending = false;
	private initialQuestionPending = false;
	private working: Loader | undefined;
	private workingMessage = "";
	private readonly activeTools = new Map<string, string>();
	private scroll = 0;
	private error: string | undefined;
	private _focused = true;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value && !this.selector && !this.options.continuationError;
		if (this.selector) this.selector.component.focused = value;
	}

	constructor(agent: Agent, controls: PaneControls, question = "", options: SideChatViewOptions = {}) {
		this.agent = agent;
		this.controls = controls;
		this.options = options;
		this.firstMessage = options.firstMessage ?? agent.state.messages.length;
		this.transcript = new ChatTranscript({
			cwd: options.cwd ?? process.cwd(),
			invalidate: () => controls.invalidate(),
		});
		this.editorHost = {
			requestRender: () => {
				if (!this.disposed) controls.invalidate();
			},
			terminal: { rows: 24 },
		};
		this.editor = new SideChatEditor(this.editorHost, getEditorTheme(), { paddingX: 1 });
		this.editor.focused = !options.continuationError;
		this.editor.onSubmit = (value) => {
			this.editor.addToHistory(value);
			this.ask(value);
		};
		this.unsubscribe = agent.subscribe((event) => {
			if (this.disposed) return;
			if (event.type === "tool_execution_start") this.activeTools.set(event.toolCallId, clean(event.toolName));
			else if (event.type === "tool_execution_end") this.activeTools.delete(event.toolCallId);
			this.syncWorking();
			if (event.type === "agent_end") {
				// agent_end listeners run before isStreaming clears; observe settlement without blocking that event.
				void agent.waitForIdle().then(() => {
					this.syncWorking();
					if (!this.disposed) controls.invalidate();
				});
			}
			controls.invalidate();
		});
		this.initialQuestionPending = Boolean(question);
		this.syncWorking();
		if (question)
			queueMicrotask(() => {
				this.initialQuestionPending = false;
				if (!this.disposed) this.ask(question);
				this.syncWorking();
			});
	}

	/** Ask or queue a follow-up without adding messages to the main thread. */
	ask(question: string): void {
		if (this.disposed || !question.trim()) return;
		const command = question.trim();
		if (command === "/close" || command === "/quit") {
			this.controls.close();
			return;
		}
		if (this.options.continuationError) {
			this.error = this.options.continuationError;
			this.controls.invalidate();
			return;
		}
		const match = /^\/(model|thinking|effort)(?:\s+([\s\S]*))?$/.exec(command);
		if (match) {
			if (match[1] === "model") this.showModelSelector(match[2]?.trim());
			else if (!match[2]?.trim()) this.showThinkingSelector();
			else this.selectThinkingLevel(match[2].trim());
			this.controls.invalidate();
			return;
		}
		this.error = undefined;
		this.scroll = 0;
		if (this.agent.state.isStreaming) {
			try {
				this.agent.followUp({ role: "user", content: question, timestamp: Date.now() });
			} catch (error) {
				this.error = error instanceof Error ? error.message : String(error);
			}
		} else {
			this.promptPending = true;
			this.syncWorking();
			void this.agent
				.prompt(question)
				.catch((error: unknown) => {
					this.error = error instanceof Error ? error.message : String(error);
				})
				.finally(() => {
					this.promptPending = false;
					this.syncWorking();
					if (!this.disposed) this.controls.invalidate();
				});
		}
		this.controls.invalidate();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.pane.minimize")) {
			void this.controls.minimize().catch((error: unknown) => {
				this.error = String(error);
				this.controls.invalidate();
			});
		} else if (this.selector) {
			this.selector.component.handleInput(data);
		} else if (kb.matches(data, "app.interrupt") || kb.matches(data, "tui.select.cancel")) {
			if (this.agent.state.isStreaming) this.agent.abort();
			else this.controls.close();
		} else if (kb.matches(data, "app.tools.expand")) {
			this.expandedTools = !this.expandedTools;
			this.transcript.setExpanded(this.expandedTools);
		} else if (kb.matches(data, "app.thinking.toggle")) {
			this.hideThinkingBlock = !this.hideThinkingBlock;
			this.transcript.setHideThinkingBlock(this.hideThinkingBlock);
		} else if (kb.matches(data, "tui.select.pageUp")) this.scroll += 10;
		else if (kb.matches(data, "tui.select.pageDown")) this.scroll = Math.max(0, this.scroll - 10);
		else if (this.options.continuationError) {
			/* History-only views have no editable prompt or request controls. */
		} else if (kb.matches(data, "app.model.select")) this.showModelSelector();
		else if (kb.matches(data, "app.model.cycleForward")) this.cycleModel("forward");
		else if (kb.matches(data, "app.model.cycleBackward")) this.cycleModel("backward");
		else if (kb.matches(data, "app.thinking.cycle")) this.cycleThinkingLevel();
		else if (kb.matches(data, "app.exit") && !this.editor.getText()) this.controls.close();
		else this.editor.handleInput(data);
		this.controls.invalidate();
	}

	render(width: number, height: number): string[] {
		if (height <= 0 || width <= 0) return [];
		this.syncWorking();
		const workingLine = this.renderWorking(width);
		if (this.selector) {
			const lines = this.selector.component.render(width);
			return [
				...lines.slice(0, height - (workingLine === undefined ? 0 : 1)),
				...(workingLine === undefined ? [] : [workingLine]),
			].map((line) => truncateToWidth(line, width));
		}
		const streaming = this.agent.state.streamingMessage;
		this.transcript.setMessages(
			this.agent.state.messages.slice(this.firstMessage),
			streaming?.role === "assistant" ? streaming : undefined,
		);
		const transcript = this.transcript.render(width);
		for (const queued of this.agent.peekQueuedMessages()) {
			if (queued.role === "user")
				transcript.push(theme.fg("muted", `Queued: ${clean(contentText(queued.content)).replace(/\n/g, " ")}`));
		}
		const error = this.error ?? this.agent.state.errorMessage ?? this.options.continuationError;
		if (error) transcript.push("", theme.fg("error", clean(error)), "");
		const state = this.agent.state;
		const context = estimateContextTokens(state.messages).tokens;
		const window = state.model.contextWindow;
		const usage =
			window > 0
				? `${((context / window) * 100).toFixed(1)}% · ${context.toLocaleString()}/${window.toLocaleString()} tokens`
				: `${context.toLocaleString()} tokens`;
		const controlLine = `${keyText("tui.select.cancel")} ${state.isStreaming ? "cancel" : "close"} · ${keyText("app.tools.expand")} tools · ${keyText("app.pane.minimize")} minimize`;
		let bottom: string[];
		if (this.options.continuationError) bottom = [theme.fg("muted", controlLine)];
		else {
			this.editorHost.terminal = { rows: height };
			this.editor.maxVisibleLines = Math.max(1, Math.min(Math.max(5, Math.floor(height * 0.3)), height - 7));
			bottom = [
				workingLine ?? "",
				// Native wrapping needs room for one wide glyph; the pane clips these rows below.
				...this.editor.render(Math.max(4, width)),
				theme.fg(
					"muted",
					`${clean(state.model.id)} [${clean(state.model.provider)}] · effort ${state.thinkingLevel}`,
				),
				theme.fg(
					"muted",
					`Context ${usage} · ${keyText("app.model.select")} model · ${keyText("app.thinking.cycle")} effort`,
				),
				theme.fg("muted", `${state.isStreaming ? "Answering · follow-ups queue · " : ""}${controlLine}`),
			];
		}
		// On tiny panes, working state takes priority over verbose metadata below the prompt.
		if (workingLine !== undefined && bottom.length > height) bottom = bottom.slice(0, height);
		const header =
			height > bottom.length
				? [
						theme.fg(
							"muted",
							`Read-only tools · ${this.options.saved ? "saved separately" : "in memory"} · fixed main context`,
						),
					]
				: [];
		const available = Math.max(0, height - header.length - bottom.length);
		this.scroll = Math.min(this.scroll, Math.max(0, transcript.length - available));
		const end = Math.max(0, transcript.length - this.scroll);
		const visible = available > 0 ? transcript.slice(Math.max(0, end - available), end) : [];
		return [...header, ...visible, ...Array<string>(available - visible.length).fill(""), ...bottom]
			.slice(-height)
			.map((line) => truncateToWidth(line, width));
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.syncWorking();
		this.closeSelector();
		this.unsubscribe();
		this.agent.abort();
		await this.agent.waitForIdle();
		try {
			await this.options.close?.();
		} finally {
			this.agent.clearAllQueues();
			this.agent.state.messages = [];
			this.transcript.dispose();
			this.editor.setText("");
		}
	}

	private syncWorking(): void {
		if (
			this.disposed ||
			this.options.continuationError ||
			!(this.initialQuestionPending || this.promptPending || this.agent.state.isStreaming)
		) {
			this.working?.stop();
			this.working = undefined;
			this.workingMessage = "";
			this.activeTools.clear();
			return;
		}
		const streaming = this.agent.state.streamingMessage;
		const lastContent =
			streaming?.role === "assistant"
				? streaming.content.findLast((part) => part.type === "thinking" || part.type === "text")
				: undefined;
		const message = this.activeTools.size
			? `Running ${[...this.activeTools.values()].join(", ")}...`
			: lastContent?.type === "thinking"
				? "Thinking..."
				: lastContent?.type === "text"
					? "Answering..."
					: "Working...";
		if (!this.working) {
			this.working = new Loader(
				this.editorHost,
				(frame) => theme.fg("accent", frame),
				(label) => theme.fg("accent", theme.bold(label)),
				message,
			);
			this.working.setPaddingX(0);
		} else if (message !== this.workingMessage) this.working.setMessage(message);
		this.workingMessage = message;
	}

	private renderWorking(width: number): string | undefined {
		if (!this.working) return undefined;
		// Loader owns the animation; keep its first content row and let even one column show the spinner.
		return truncateToWidth(this.working.render(Math.max(16, width))[1] ?? "", width, "");
	}

	private canSelect(): boolean {
		if (this.initialQuestionPending || this.promptPending || this.agent.state.isStreaming) {
			this.error = "Wait for the current answer before changing the side-chat model or effort.";
			return false;
		}
		if (!this.options.runtime) {
			this.error = "Local model and effort controls are unavailable for this side chat.";
			return false;
		}
		this.error = undefined;
		return true;
	}

	private showModelSelector(search?: string): void {
		if (!this.canSelect()) return;
		if (!this.options.modelRuntime) {
			this.error = "The model catalog is unavailable for this side chat.";
			return;
		}
		this.selector = {
			kind: "model",
			component: new ModelSelectorComponent(
				{
					requestRender: () => {
						if (!this.disposed) this.controls.invalidate();
					},
				},
				this.agent.state.model,
				this.options.modelRuntime,
				this.options.scopedModels ?? [],
				(model) => {
					this.closeSelector();
					this.selectModel(model);
					this.controls.invalidate();
				},
				() => {
					this.closeSelector();
					this.controls.invalidate();
				},
				search,
			),
		};
		this.focused = this._focused;
	}

	private showThinkingSelector(): void {
		if (!this.canSelect()) return;
		this.selector = {
			kind: "thinking",
			component: new ThinkingSelectorComponent(
				this.agent.state.thinkingLevel,
				this.options.runtime!.getAvailableThinkingLevels(),
				(level) => {
					this.closeSelector();
					this.selectThinkingLevel(level);
					this.controls.invalidate();
				},
				() => {
					this.closeSelector();
					this.controls.invalidate();
				},
			),
		};
		this.focused = this._focused;
	}

	private closeSelector(): void {
		if (this.selector?.kind === "model") this.selector.component.dispose();
		this.selector = undefined;
		this.focused = this._focused;
	}

	private selectModel(model: Model<string>): void {
		if (!this.canSelect()) return;
		try {
			this.options.runtime!.setModel(model);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	private selectThinkingLevel(text: string): void {
		if (!this.canSelect()) return;
		const levels = this.options.runtime!.getAvailableThinkingLevels();
		const level = levels.find((value) => value === text.toLowerCase());
		if (!level) {
			this.error = `Available effort levels: ${levels.join(", ")}`;
			return;
		}
		try {
			this.options.runtime!.setThinkingLevel(level);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	private cycleThinkingLevel(): void {
		if (!this.canSelect()) return;
		const levels = this.options.runtime!.getAvailableThinkingLevels();
		if (!levels.length) {
			this.error = "This model has no selectable effort levels.";
			return;
		}
		const index = levels.indexOf(this.agent.state.thinkingLevel);
		this.selectThinkingLevel(levels[(index + 1) % levels.length]);
	}

	private cycleModel(direction: "forward" | "backward"): void {
		if (!this.canSelect()) return;
		const models = this.options.scopedModels?.length
			? this.options.scopedModels.map((scoped) => scoped.model)
			: (this.options.modelRuntime?.getAvailableSnapshot() ?? []);
		if (!models.length) {
			this.error = "No configured models are available for this side chat.";
			return;
		}
		const current = models.findIndex((model) => modelsAreEqual(model, this.agent.state.model));
		const next =
			direction === "forward"
				? (current + 1) % models.length
				: current < 0
					? models.length - 1
					: (current + models.length - 1) % models.length;
		this.selectModel(models[next]);
	}
}

class SideChatEditor extends Editor<EditorHost> {
	maxVisibleLines = 5;
	protected override getMaxVisibleLines(_terminalRows: number): number {
		return this.maxVisibleLines;
	}
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
}
