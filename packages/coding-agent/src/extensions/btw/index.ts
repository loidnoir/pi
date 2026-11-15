// Saved parent-scoped read-only side conversations and their shared Rex/TUI history browser.
import { getAgentDir } from "../../config.ts";
import type { ExtensionCommandContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { parsePaneCommand } from "../../core/panes/command.ts";
import { openPane, type PaneHandle, type PaneOptions } from "../../core/panes/host.ts";
import { SideChatView } from "../../core/panes/side-chat.ts";
import { SideChatListView } from "../../core/panes/side-chat-list.ts";
import { openSideSession } from "../../core/side-session.ts";
import { SideSessionStore, type StoredSideSession } from "../../core/side-session-store.ts";
import { iconPrefix } from "../../modes/interactive/icons.ts";

type SidePane = { pane: PaneHandle; view: SideChatView | SideChatListView };
type Presentation = Pick<PaneOptions, "backend" | "placement" | "minimized">;

/** Register saved /btw histories without adding side turns to the main conversation. */
export function createBtwExtension(agentDir = getAgentDir()): ExtensionFactory {
	return (pi) => {
		let lifetime = new AbortController();
		let store: SideSessionStore | undefined;
		const panes = new Map<string, SidePane>();
		const openings = new Map<string, Promise<SidePane>>();

		function getStore(ctx: ExtensionCommandContext): SideSessionStore {
			store ??= new SideSessionStore(ctx, agentDir, () => pi.getSettings());
			return store;
		}

		function refreshHistory(): void {
			const view = panes.get("history")?.view;
			if (view instanceof SideChatListView) view.refresh();
		}

		async function present(
			ctx: ExtensionCommandContext,
			options: Presentation,
			chat?: StoredSideSession,
			question = "",
		): Promise<SidePane> {
			const key = chat?.id ?? "history";
			const pending = openings.get(key);
			const existing = panes.get(key) ?? (pending ? await pending : undefined);
			if (existing) {
				const changeBackend =
					options.backend && options.backend !== "auto" && options.backend !== existing.pane.backend;
				const changePlacement =
					options.placement && existing.pane.backend === "rex" && options.placement !== existing.pane.placement;
				if (!changeBackend && !changePlacement) {
					if (existing.view instanceof SideChatListView) existing.view.refresh();
					await existing.pane.show();
					return existing;
				}
				await existing.pane.close();
			}
			const owner = getStore(ctx);
			const opening = (async () => {
				let view!: SideChatView | SideChatListView;
				const pane = await openPane(ctx, {
					...options,
					title: `${iconPrefix("chat")}btw${chat ? ` — ${chat.title}` : " — saved chats"}`,
					signal: lifetime.signal,
					create: (controls) => {
						if (chat) {
							const runtime = openSideSession(ctx, chat);
							const unsubscribe = runtime.agent.subscribe((event) => {
								if (event.type === "message_end") refreshHistory();
							});
							view = new SideChatView(runtime.agent, controls, question, {
								cwd: chat.sessionManager.getCwd(),
								firstMessage: runtime.firstMessage,
								saved: !!chat.historyPath,
								continuationError: runtime.error,
								runtime,
								modelRuntime: ctx.modelRegistry.runtime,
								scopedModels: ctx.scopedModels,
								close: async () => {
									unsubscribe();
									await runtime.close();
									refreshHistory();
								},
							});
						} else {
							view = new SideChatListView(controls, {
								list: (offset) => owner.list(offset),
								open: async (id) => {
									await present(ctx, options, owner.open(id));
								},
							});
						}
						return view;
					},
				});
				const result = { pane, view };
				panes.set(key, result);
				void pane.closed.then(() => {
					if (panes.get(key) === result) panes.delete(key);
				});
				return result;
			})();
			openings.set(key, opening);
			try {
				return await opening;
			} finally {
				if (openings.get(key) === opening) openings.delete(key);
			}
		}

		pi.registerCommand("btw", {
			description:
				"Browse saved side chats or start a new read-only chat: /btw [--tui|--rex] [--split|--floating] [question]",
			handler: async (args, ctx) => {
				if (args.trim() === "--help") {
					ctx.ui.notify(
						"/btw [--tui|--rex] [--split|--floating] [--minimized] [question]. Without a question, browse this main thread's saved chats, newest activity first, 20 per page. A question always creates a separate chat referencing the current main context. Reopen from history for follow-ups. Inside a chat, /model and /effort (/thinking) change only that chat's saved selection; finish or cancel active work first. Only read, grep, find and ls are available. Escape cancels an answer, then closes when idle; /close keeps saved history. With --no-session, histories stay in memory only.",
						"info",
					);
					return;
				}
				if (ctx.mode !== "tui") throw new Error("/btw requires interactive pi mode");
				const { options, text } = parsePaneCommand(args);
				if (text && !ctx.model) throw new Error("Select a model before opening /btw");
				const chat = text ? getStore(ctx).create(text) : undefined;
				if (chat) refreshHistory();
				await present(ctx, options, chat, text);
			},
		});
		pi.on("session_start", () => {
			if (lifetime.signal.aborted) lifetime = new AbortController();
		});
		pi.on("session_shutdown", async () => {
			lifetime.abort();
			await Promise.allSettled(openings.values());
			await Promise.all([...panes.values()].map(({ pane }) => pane.close()));
			panes.clear();
			store = undefined;
		});
	};
}

export default createBtwExtension();
