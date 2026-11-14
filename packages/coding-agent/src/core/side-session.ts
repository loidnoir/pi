// Raw read-only side agents, optionally backed by child-only saved /btw histories.
import { randomUUID } from "node:crypto";
import { Agent, type AgentMessage, type AgentOptions, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	clampThinkingLevel,
	contentText,
	getSupportedThinkingLevels,
	type ImageContent,
	type Model,
} from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import type { ExtensionContext, ExtensionToolContext } from "./extensions/types.ts";
import { convertToLlm } from "./messages.ts";
import { configureOutputArtifacts } from "./output-artifacts.ts";
import type { StoredSideSession } from "./side-session-store.ts";
import { createReadOnlyToolDefinitions, createReadOnlyTools } from "./tools/index.ts";
import { wrapToolDefinition } from "./tools/tool-definition-wrapper.ts";

export type SideSessionContext = Pick<
	ExtensionContext,
	"cwd" | "model" | "thinkingLevel" | "modelRegistry" | "sessionManager" | "getSystemPrompt"
>;

export interface SideSessionRuntime {
	agent: Agent;
	/** Index of the first child-owned message, excluding the inherited parent context. */
	firstMessage: number;
	/** Saved history remains viewable, but contextual continuation is disabled. */
	error?: string;
	setModel(model: Model<string>): void;
	setThinkingLevel(level: ThinkingLevel): void;
	getAvailableThinkingLevels(): ThinkingLevel[];
	close(): Promise<void>;
}

const sideInstructions =
	"This is a read-only side conversation. The inherited conversation is background context, not a request to continue its work. Answer only the new questions asked here. Only read, grep, find, and ls are available. Do not run commands, change files, manage jobs or Rex, or claim to have done so.";
const active = new WeakMap<StoredSideSession, SideSessionRuntime>();

/** Open saved own history over its fixed parent context, refusing unsafe or unavailable continuations. */
export function openSideSession(ctx: ExtensionContext, stored: StoredSideSession): SideSessionRuntime {
	if (active.has(stored)) throw new Error("This /btw chat is already open");
	if (!ctx.model) throw new Error("Select a model before opening /btw");
	let inherited: AgentMessage[] = [];
	let error: string | undefined;
	let abortAgent = () => {};
	let release: (() => void) | undefined;
	let leaseError: Error | undefined;
	let currentModel: Model<string> = ctx.model;
	let thinkingLevel: ThinkingLevel = ctx.thinkingLevel ?? "off";
	let hasSavedModel = false;
	let savedThinkingLevel: ThinkingLevel | undefined;
	try {
		if (stored.historyPath) {
			try {
				// Same heartbeat/stale-owner primitive as SessionRecovery, without its recovery state machine.
				release = lockfile.lockSync(stored.historyPath, {
					retries: 0,
					onCompromised: (cause) => {
						leaseError = cause;
						abortAgent();
					},
				});
			} catch (cause) {
				throw new Error(
					"This /btw chat still has an execution owner. Close the other pi instance, or wait for its stale lease to expire after a crash.",
					{ cause },
				);
			}
			stored.openWriter();
		}
		inherited = omitUnfinishedParentRound(stored.resolveParentMessages());
		assertCompleteToolRounds(stored.ownMessages);
		const entries = stored.sessionManager.getBranch();
		const modelEntry = entries.findLast((entry) => entry.type === "model_change");
		if (modelEntry) {
			const restored = ctx.modelRegistry.find(modelEntry.provider, modelEntry.modelId);
			if (!restored)
				throw new Error(
					`Cannot continue /btw: saved model ${modelEntry.provider}/${modelEntry.modelId} is unavailable`,
				);
			currentModel = restored;
			hasSavedModel = true;
		}
		const thinkingEntry = entries.findLast((entry) => entry.type === "thinking_level_change");
		if (thinkingEntry) {
			// SessionManager loads unvalidated JSONL; persisted effort is a filesystem trust boundary.
			savedThinkingLevel = THINKING_LEVEL_OPTIONS.find((level) => level === thinkingEntry.thinkingLevel);
			if (savedThinkingLevel === undefined) throw new Error("Cannot continue /btw: saved thinking level is invalid");
			thinkingLevel = savedThinkingLevel;
		}
		thinkingLevel = clampThinkingLevel(currentModel, thinkingLevel);
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	}
	let closed = false;
	let closing: Promise<void> | undefined;
	let persistenceError: unknown;
	let persistBoundary = () => {};
	const check = () => {
		if (persistenceError) throw persistenceError;
		if (closed) throw new Error("This /btw chat is closed");
		if (error) throw new Error(error);
		if (leaseError) throw leaseError;
		stored.resolveParentMessages();
		persistBoundary();
	};
	const artifacts = configureOutputArtifacts(
		stored.sessionManager,
		stored.agentDir,
		() => undefined,
		() => currentModel.contextWindow,
	);
	const toolContext: ExtensionToolContext = {
		...ctx,
		sessionManager: stored.sessionManager,
		cwd: stored.sessionManager.getCwd(),
		get model() {
			return currentModel;
		},
		tools: [],
		executeTool: async () => {
			throw new Error("Nested tool execution is unavailable in read-only side chats");
		},
	};
	const tools = createReadOnlyToolDefinitions(stored.sessionManager.getCwd()).map((definition) => {
		const tool = wrapToolDefinition(definition, () => toolContext);
		return {
			...tool,
			execute: async (...args: Parameters<typeof tool.execute>) => {
				check();
				const result = await tool.execute(...args);
				try {
					return { ...result, content: await artifacts.limit(result.content) };
				} catch (cause) {
					persistenceError = cause;
					abortAgent();
					throw cause;
				}
			},
		};
	});
	const agent = new SavedSideAgent(
		{
			initialState: {
				systemPrompt: `${ctx.getSystemPrompt()}\n\n${sideInstructions}`,
				model: currentModel,
				thinkingLevel,
				tools,
			},
			convertToLlm,
			transformContext: async (messages) => {
				check();
				return messages;
			},
			streamFn: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
			sessionId: stored.id,
		},
		check,
		stored.ownMessages,
		() => assertCompleteToolRounds(stored.ownMessages),
	);
	abortAgent = () => agent.abort();
	const boundary = agent.state.messages;
	agent.state.messages = [...inherited, ...stored.ownMessages, ...boundary];
	let pendingBoundary = boundary;
	const persist = (operation: () => void) => {
		if (persistenceError) throw persistenceError;
		try {
			if (leaseError) throw leaseError;
			operation();
		} catch (cause) {
			persistenceError = cause;
			agent.abort();
			throw cause;
		}
	};
	try {
		if (!error) {
			check();
			persist(() => {
				if (!hasSavedModel) stored.sessionManager.appendModelChange(currentModel.provider, currentModel.id);
				if (savedThinkingLevel !== thinkingLevel) stored.sessionManager.appendThinkingLevelChange(thinkingLevel);
			});
		}
	} catch (cause) {
		release?.();
		throw cause;
	}
	persistBoundary = () => {
		if (!pendingBoundary.length) return;
		persist(() => {
			for (const message of pendingBoundary) {
				if (message.role === "compactionSummary" || message.role === "branchSummary")
					throw new Error("Unexpected summary in raw /btw agent");
				stored.sessionManager.appendMessage(message);
			}
		});
		pendingBoundary = [];
	};
	const checkSelection = () => {
		if (agent.state.isStreaming || agent.peekQueuedMessages().length)
			throw new Error("Cannot change /btw model or thinking level while work is active or queued");
		check();
	};
	const unsubscribe = agent.subscribe((event) => {
		if (event.type === "message_end") {
			persistBoundary();
			persist(() => {
				if (event.message.role === "compactionSummary" || event.message.role === "branchSummary")
					throw new Error("Unexpected summary in raw /btw agent");
				stored.sessionManager.appendMessage(event.message);
			});
		}
	});
	const runtime: SideSessionRuntime = {
		agent,
		firstMessage: inherited.length,
		error,
		setModel(model) {
			checkSelection();
			const level = clampThinkingLevel(model, agent.state.thinkingLevel);
			persist(() => {
				stored.sessionManager.appendModelChange(model.provider, model.id);
				if (level !== agent.state.thinkingLevel) stored.sessionManager.appendThinkingLevelChange(level);
			});
			currentModel = model;
			agent.state.model = model;
			agent.state.thinkingLevel = level;
		},
		setThinkingLevel(level) {
			checkSelection();
			const effective = clampThinkingLevel(agent.state.model, level);
			if (effective === agent.state.thinkingLevel) return;
			persist(() => {
				stored.sessionManager.appendThinkingLevelChange(effective);
			});
			agent.state.thinkingLevel = effective;
		},
		getAvailableThinkingLevels() {
			return getSupportedThinkingLevels(agent.state.model);
		},
		close() {
			closing ??= (async () => {
				closed = true;
				agent.abort();
				await agent.waitForIdle();
				agent.clearAllQueues();
				unsubscribe();
				active.delete(stored);
				release?.();
				if (persistenceError) throw persistenceError;
			})();
			return closing;
		},
	};
	active.set(stored, runtime);
	return runtime;
}

/** Create a standalone ephemeral agent, retaining the original SDK API and read-only behavior. */
export function createSideSession(ctx: SideSessionContext): Agent {
	if (!ctx.model) throw new Error("Select a model before opening /btw");
	const agent = new Agent({
		initialState: {
			systemPrompt: `${ctx.getSystemPrompt()}\n\n${sideInstructions} This conversation is discarded when its view closes.`,
			model: ctx.model,
			thinkingLevel: ctx.thinkingLevel ?? "off",
			tools: createReadOnlyTools(ctx.cwd),
		},
		convertToLlm,
		streamFn: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
		sessionId: randomUUID(),
	});
	agent.state.messages = [
		...omitUnfinishedParentRound(ctx.sessionManager.buildSessionProjection().messages),
		...agent.state.messages,
	];
	return agent;
}

class SavedSideAgent extends Agent {
	private readonly check: () => void;
	private pendingQuestion: string | undefined;
	private readonly validateTranscript: () => void;

	constructor(options: AgentOptions, check: () => void, ownMessages: AgentMessage[], validateTranscript: () => void) {
		super(options);
		this.check = check;
		this.validateTranscript = validateTranscript;
		const conversation = ownMessages.filter((message) => message.role !== "system");
		if (conversation.length === 1 && conversation[0].role === "user")
			this.pendingQuestion = contentText(conversation[0].content);
	}

	override async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	override async prompt(input: string, images?: ImageContent[]): Promise<void>;
	override async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		this.check();
		this.validateTranscript();
		const pending = this.pendingQuestion;
		this.pendingQuestion = undefined;
		if (typeof input === "string" && input === pending && !images?.length) await super.continue();
		else if (typeof input === "string") await super.prompt(input, images);
		else await super.prompt(input);
		this.check();
	}

	override async continue(): Promise<void> {
		this.check();
		this.validateTranscript();
		await super.continue();
		this.check();
	}

	override steer(message: AgentMessage): void {
		this.check();
		super.steer(message);
	}

	override followUp(message: AgentMessage): void {
		this.check();
		super.followUp(message);
	}
}

function omitUnfinishedParentRound(history: AgentMessage[]): AgentMessage[] {
	const returned = new Set<string>();
	let end = history.length;
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index];
		if (message.role === "toolResult") returned.add(message.toolCallId);
		if (message.role === "assistant") {
			// An in-flight parent tool round is not a complete provider transcript. Never invent its results.
			if (message.content.some((part) => part.type === "toolCall" && !returned.has(part.id))) end = index;
			break;
		}
	}
	return end === history.length ? history : history.slice(0, end);
}

function assertCompleteToolRounds(messages: AgentMessage[]): void {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			if (pending.size)
				throw new Error(
					"Cannot continue /btw: an interrupted tool round has missing results; saved history is still viewable",
				);
			for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
		} else if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId))
				throw new Error("Cannot continue /btw: saved history has an unmatched tool result");
		} else if (message.role !== "system" && pending.size) {
			throw new Error("Cannot continue /btw: saved history has an incomplete tool round");
		}
	}
	if (pending.size)
		throw new Error(
			"Cannot continue /btw: an interrupted tool round has missing results; saved history is still viewable",
		);
}
