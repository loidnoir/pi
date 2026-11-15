// Verifies main-session priority requests use branch state and the actual request model, not extension-local state.
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import fastExtension from "../../src/extensions/fast/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const fixtures: Array<{ harness: Harness; session: AgentSession }> = [];
afterEach(() => {
	for (const { harness, session } of fixtures.splice(0)) {
		session.dispose();
		harness.cleanup();
	}
});

async function setup(defaultFastMode = false, withExtension = true) {
	const harness = await createHarness({
		settings: {
			defaultFastMode,
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		},
	});
	const extensionsResult = await createTestExtensionsResult(withExtension ? [fastExtension] : [], harness.tempDir);
	const sessionManager = SessionManager.inMemory(harness.tempDir);
	const { session } = await createAgentSession({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		model: harness.getModel(),
		sessionManager,
		settingsManager: harness.settingsManager,
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		tools: [],
	});
	fixtures.push({ harness, session });
	const statuses = new Map<string, string>();
	const notices: string[] = [];
	await session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({
			setStatus: (key, value) => {
				if (value === undefined) statuses.delete(key);
				else statuses.set(key, value);
			},
			notify: (message) => {
				notices.push(message);
			},
		}),
	});
	const codex: Model<string> = { ...harness.getModel(), provider: "openai-codex", api: "openai-codex-responses" };
	return { harness, session, sessionManager, statuses, notices, codex };
}

describe("SDK fast request consumption", () => {
	it("applies main defaults without loading a fast extension and gates on the actual wire model", async () => {
		const f = await setup(true, false);
		f.harness.setResponses([
			async (_context, options) => {
				const payload = { input: [], service_tier: "auto" };
				expect(await options?.onPayload?.(payload, f.codex)).toEqual({ input: [], service_tier: "priority" });
				expect(await options?.onPayload?.(payload, f.harness.getModel())).toBe(payload);
				expect(await options?.onPayload?.(payload, { ...f.codex, api: "openai-responses" })).toBe(payload);
				return fauxAssistantMessage("Wire model checked");
			},
		]);
		await f.session.prompt("Check physical request model");
		expect(f.session.getLastAssistantText()).toBe("Wire model checked");
	});

	it("shares /fast state with branch entries, defaults, footer, and subsequent requests", async () => {
		const f = await setup(true);
		f.session.agent.state.model = f.codex;
		await f.session.extensionRunner.emit({
			type: "model_select",
			model: f.codex,
			source: "set",
			previousModel: f.harness.getModel(),
		});
		expect(f.statuses.get("fast")).toBe("fast (priority)");
		await f.session.prompt("/fast status");
		expect(f.notices.at(-1)).toBe("Codex fast mode: on");
		await f.session.prompt("/fast off");
		const off = f.sessionManager.getLeafId()!;
		expect(f.statuses.has("fast")).toBe(false);
		expect(await f.session.agent.onPayload?.({ input: [] }, f.codex)).toEqual({ input: [] });
		await f.session.prompt("/fast on");
		expect(await f.session.agent.onPayload?.({ input: [] }, f.codex)).toMatchObject({ service_tier: "priority" });
		f.sessionManager.branch(off);
		await f.session.extensionRunner.emit({ type: "session_tree", oldLeafId: null, newLeafId: off });
		expect(f.statuses.has("fast")).toBe(false);
		expect(await f.session.agent.onPayload?.({ input: [] }, f.codex)).toEqual({ input: [] });
		f.sessionManager.appendCustomEntry("chatgpt-fast-mode", { enabled: true });
		await f.session.prompt("/fast status");
		expect(f.notices.at(-1)).toBe("Codex fast mode: on");
		expect(f.session.extensionRunner.hasHandlers("before_provider_request")).toBe(false);
	});

	it("validates payloads only when priority is active on the actual supported model", async () => {
		const f = await setup(true, false);
		await expect(f.session.agent.onPayload?.(null, f.codex)).rejects.toThrow("object request payload");
		expect(await f.session.agent.onPayload?.(null, f.harness.getModel())).toBeNull();
		f.sessionManager.appendCustomEntry("chatgpt-fast-mode", { enabled: false });
		expect(await f.session.agent.onPayload?.(null, f.codex)).toBeNull();
	});
});
