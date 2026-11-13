import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { type Component, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { JobManager } from "../../src/core/jobs/manager.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getSubagentActivity } from "../../src/core/subagents/activity.ts";
import { createRecoveryExtension } from "../../src/extensions/recovery/index.ts";
import { createSubagentExtension } from "../../src/extensions/subagents/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const panels: (Component & { dispose?(): void })[] = [];
const keys = new KeybindingsManager();

beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const panel of panels.splice(0)) panel.dispose?.();
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) {
		await harness.session.abort();
		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
});

async function fixture(child = false) {
	const sessionManager = SessionManager.inMemory();
	if (child) sessionManager.appendCustomEntry("pi.subagent", { parentSessionId: "parent", role: "worker" });
	const harness = await createHarness({
		sessionManager,
		extensionFactories: [createSubagentExtension(), createRecoveryExtension()],
		settings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" },
	});
	harnesses.push(harness);
	const jobs = vi.spyOn(JobManager.prototype, "list").mockResolvedValue([]);
	const confirm = vi.fn(async () => false);
	const setStatus = vi.fn<ExtensionUIContext["setStatus"]>();
	const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
	const ready = Promise.withResolvers<Component>();
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({
			confirm,
			setStatus,
			custom: async <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
				const answer = Promise.withResolvers<T>();
				const panel = await factory(tui, theme, keys, (result) => answer.resolve(result as T));
				panels.push(panel);
				ready.resolve(panel);
				try {
					return await answer.promise;
				} finally {
					panel.dispose?.();
				}
			},
		}),
	});
	return { harness, jobs, confirm, setStatus, ready: ready.promise };
}

describe("native pause menu integration", () => {
	it.each([false, true])(
		"registers read-only activity for the exact session and removes it on replacement (child=%s)",
		async (child) => {
			const { harness } = await fixture(child);
			const activity = getSubagentActivity(harness.sessionManager)!;
			expect(Object.keys(activity).sort()).toEqual(["list", "subscribe"]);
			expect(activity.list()).toEqual([]);
			expect(getSubagentActivity(SessionManager.inMemory())).toBeUndefined();
			await harness.session.extensionRunner!.emit({ type: "session_shutdown", reason: "resume" });
			expect(getSubagentActivity(harness.sessionManager)).toBeUndefined();
			expect(harness.faux.state.callCount).toBe(0);
		},
	);

	it("requests pause immediately during a model response and allows Continue without extra requests", async () => {
		const { harness, jobs, ready } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("Current response completed once");
			},
		]);
		const run = harness.session.prompt("Work");
		await started.promise;
		const command = harness.session.prompt("/pause");
		const panel = await ready;
		expect(harness.session.recovery.isPaused).toBe(true);
		expect(stripAnsi(panel.render(120).join("\n"))).toContain("1 active model response");
		expect(jobs).toHaveBeenCalledWith(harness.tempDir);
		panel.handleInput?.("\r");
		await command;
		expect(harness.session.recovery.isPaused).toBe(false);
		release.resolve();
		await run;
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("reads real child transitions through the bridge while pause is advisory", async () => {
		const { harness, ready, setStatus } = await fixture();
		const parentId = harness.sessionManager.getSessionId();
		harness.session.agent.sessionId = parentId;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let mainCalls = 0;
		const response: FauxResponseFactory = async (_context, options) => {
			if (options?.sessionId?.startsWith("label:")) return fauxAssistantMessage("Child task");
			if (options?.sessionId === parentId)
				return ++mainCalls === 1
					? fauxAssistantMessage(
							{
								type: "toolCall",
								id: "child-start",
								name: "subagent",
								arguments: { action: "start", task: "Wait for evidence", async: true },
							},
							{ stopReason: "toolUse" },
						)
					: fauxAssistantMessage("Child launched");
			started.resolve();
			options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return fauxAssistantMessage("Child evidence saved");
		};
		harness.setResponses(Array.from({ length: 8 }, () => response));
		const run = harness.session.prompt("Delegate the evidence check");
		await started.promise;
		await run;
		const activity = getSubagentActivity(harness.sessionManager)!;
		expect(activity.list()).toEqual(["running"]);
		expect(setStatus).toHaveBeenCalledWith("subagents", "1 active sub-agent");
		const calls = harness.faux.state.callCount;
		const command = harness.session.prompt("/pause");
		const panel = await ready;
		expect(stripAnsi(panel.render(120).join("\n"))).toContain("1 running sub-agent");
		release.resolve();
		await vi.waitFor(() => expect(activity.list()).not.toContain("running"));
		expect(stripAnsi(panel.render(120).join("\n"))).toContain("0 running sub-agents");
		expect(setStatus.mock.calls.filter(([key]) => key === "subagents").at(-1)).toEqual(["subagents", undefined]);
		panel.handleInput?.("\u001b");
		await command;
		expect(harness.session.recovery.isPaused).toBe(true);
		expect(harness.faux.state.callCount).toBe(calls);
	});

	it.each([false, true])(
		"still requires explicit unknown-outcome confirmation before recovery (approved=%s)",
		async (approved) => {
			const { harness, confirm, ready } = await fixture();
			const recovery = harness.session.recovery;
			const info = recovery.info();
			vi.spyOn(recovery, "needsRecovery", "get").mockReturnValue(true);
			vi.spyOn(recovery, "info").mockReturnValue({
				...info,
				status: "interrupted",
				tools: [{ id: "write-id", name: "write", outcome: "unknown" }],
			});
			const recover = vi.spyOn(recovery, "recover").mockResolvedValue();
			const resume = vi.spyOn(recovery, "resume");
			confirm.mockResolvedValue(approved);
			const command = harness.session.prompt("/pause");
			const panel = await ready;
			panel.handleInput?.("\u001b[A");
			panel.handleInput?.("\r");
			await command;
			expect(confirm).toHaveBeenCalledWith(
				"Unknown tool outcomes",
				expect.stringContaining("will not be replayed automatically"),
				undefined,
			);
			expect(recover).toHaveBeenCalledTimes(approved ? 1 : 0);
			expect(resume).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(0);
		},
	);

	it("keeps discard explicit and confirms that completed side effects are not undone", async () => {
		const { harness, confirm, ready } = await fixture();
		const recovery = harness.session.recovery;
		vi.spyOn(recovery, "needsRecovery", "get").mockReturnValue(true);
		const discard = vi.spyOn(recovery, "discard").mockResolvedValue();
		confirm.mockResolvedValue(true);
		const command = harness.session.prompt("/pause");
		const panel = await ready;
		panel.handleInput?.("\u001b[B");
		panel.handleInput?.("\r");
		await command;
		expect(confirm).toHaveBeenCalledWith(
			"Discard pending work?",
			expect.stringContaining("Already completed side effects are not undone"),
			undefined,
		);
		expect(discard).toHaveBeenCalledOnce();
		expect(harness.faux.state.callCount).toBe(0);
	});
});
