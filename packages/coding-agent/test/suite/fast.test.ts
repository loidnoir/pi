import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
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

async function fixture() {
	const base = await createHarness();
	const codex = { ...base.getModel(), provider: "openai-codex", api: "openai-codex-responses" };
	base.session.modelRuntime.registerProvider(codex.provider, {
		api: codex.api,
		apiKey: "faux-key",
		baseUrl: "https://invalid.example",
		models: [codex],
	});
	const extensionsResult = await createTestExtensionsResult([fastExtension], base.tempDir);
	const { session } = await createAgentSession({
		cwd: base.tempDir,
		agentDir: base.tempDir,
		modelRuntime: base.session.modelRuntime,
		model: codex,
		sessionManager: base.sessionManager,
		settingsManager: base.settingsManager,
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		tools: [],
	});
	fixtures.push({ harness: base, session });
	session.subscribe((event) => base.events.push(event));
	const harness = { ...base, session };
	const statuses = new Map<string, string>();
	const notices: string[] = [];
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({
			setStatus: (key, text) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			notify: (message) => {
				notices.push(message);
			},
		}),
	});
	return {
		harness,
		codex,
		statuses,
		notices,
		// The provider invokes the SDK callback with its actual request model; the extension no longer mutates payloads.
		payload: () =>
			session.agent.onPayload?.({ model: "smoke", service_tier: "auto", input: [] }, session.agent.state.model),
	};
}

describe("native Codex fast mode", () => {
	it("requests priority only while enabled and persists transitions", async () => {
		const { harness, statuses, notices, payload } = await fixture();
		await harness.session.prompt("/fast status");
		expect(notices.at(-1)).toBe("Codex fast mode: off");
		expect(await payload()).toMatchObject({ service_tier: "auto" });
		await harness.session.prompt("/fast on");
		await harness.session.prompt("/fast status");
		expect(notices.at(-1)).toBe("Codex fast mode: on");
		expect(await payload()).toMatchObject({ model: "smoke", service_tier: "priority", input: [] });
		expect(statuses.get("fast")).toBe("fast (priority)");
		await harness.session.prompt("/fast off");
		await harness.session.prompt("/fast status");
		expect(notices.at(-1)).toBe("Codex fast mode: off");
		expect(await payload()).toMatchObject({ service_tier: "auto" });
		expect(statuses.has("fast")).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "chatgpt-fast-mode")
				.map((entry) => (entry.type === "custom" ? entry.data : undefined)),
		).toEqual([{ enabled: true }, { enabled: false }]);
		expect(harness.eventsOfType("turn_start")).toHaveLength(0);
	});

	it("restores existing session entries and follows branch navigation instead of leaking another branch's tier", async () => {
		const { harness, payload } = await fixture();
		harness.sessionManager.appendCustomEntry("chatgpt-fast-mode", { enabled: true });
		const enabledEntry = harness.sessionManager.getLeafId()!;
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		expect(await payload()).toMatchObject({ service_tier: "priority" });
		await harness.session.prompt("/fast off");
		expect(await payload()).toMatchObject({ service_tier: "auto" });
		await harness.session.navigateTree(enabledEntry, { summarize: false });
		expect(await payload()).toMatchObject({ service_tier: "priority" });
	});

	it("does not apply priority to other providers and permits disabling a remembered inactive setting", async () => {
		const { harness, codex, statuses, notices, payload } = await fixture();
		await harness.session.prompt("/fast on");
		const other = harness.getModel();
		harness.session.agent.state.model = other;
		await harness.session.extensionRunner.emit({
			type: "model_select",
			model: other,
			previousModel: codex,
			source: "set",
		});
		expect(statuses.get("fast")).toBe("fast (inactive)");
		await harness.session.prompt("/fast status");
		expect(notices.at(-1)).toBe("Codex fast mode: on (inactive on this provider)");
		expect(await payload()).toMatchObject({ service_tier: "auto" });
		await harness.session.prompt("/fast off");
		await harness.session.prompt("/fast on");
		expect(notices.at(-1)).toContain("requires a ChatGPT/Codex model");
		expect(await payload()).toMatchObject({ service_tier: "auto" });
		expect(statuses.has("fast")).toBe(false);
	});

	it("keeps separate sessions independent and rejects invalid commands without enabling priority", async () => {
		const first = await fixture();
		const second = await fixture();
		await first.harness.session.prompt("/fast on");
		await second.harness.session.prompt("/fast bogus");
		expect(await first.payload()).toMatchObject({ service_tier: "priority" });
		expect(await second.payload()).toMatchObject({ service_tier: "auto" });
		expect(second.notices.at(-1)).toContain("Usage:");
	});
});
