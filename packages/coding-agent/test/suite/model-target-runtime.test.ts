// Exercises frozen model, effort, and priority selections for saved side chats and native children.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { getSessionFastMode, setSessionModelPreferences } from "../../src/core/model-preferences.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { openSideSession, type SideSessionRuntime } from "../../src/core/side-session.ts";
import { SideSessionStore } from "../../src/core/side-session-store.ts";
import type { AgentDefinition } from "../../src/core/subagents/definitions.ts";
import { SubagentManager } from "../../src/core/subagents/manager.ts";
import { readSubagentRecord } from "../../src/core/subagents/state.ts";
import { createHarness, type Harness } from "./harness.ts";

const fixtures: Array<{
	harness: Harness;
	directory: string;
	managers: SubagentManager[];
	sides: SideSessionRuntime[];
}> = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await Promise.all(fixture.managers.map((manager) => manager.close()));
		await Promise.all(fixture.sides.map((side) => side.close()));
		fixture.harness.cleanup();
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

async function setup(settings: Settings = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-model-target-runtime-"));
	const parent = SessionManager.create(directory, join(directory, "sessions"));
	let context: ExtensionContext | undefined;
	const harness = await createHarness({
		agentDir: directory,
		sessionManager: parent,
		models: [
			{ id: "main", reasoning: true },
			{ id: "target", reasoning: true },
			{ id: "later", reasoning: true },
		],
		settings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", ...settings },
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					context = ctx;
				});
			},
		],
	});
	const owned = { harness, directory, managers: [] as SubagentManager[], sides: [] as SideSessionRuntime[] };
	fixtures.push(owned);
	await harness.session.bindExtensions({});
	if (!context) throw new Error("Missing extension context");
	const ctx = context;
	harness.session.setThinkingLevel("low");
	const store = new SideSessionStore(ctx, directory, () => harness.settingsManager.getSettings());
	const createManager = () => {
		const manager = new SubagentManager({
			parent,
			agentDir: directory,
			modelRuntime: harness.session.modelRuntime,
			getSettings: () => harness.settingsManager.getSettings(),
			getModel: () => harness.session.model,
			getThinkingLevel: () => harness.session.thinkingLevel,
			getAllowedTools: () => [],
			getSystemPrompt: () => "Test parent instructions",
		});
		owned.managers.push(manager);
		return manager;
	};
	const open = (chat: ReturnType<SideSessionStore["create"]>) => {
		const side = openSideSession(ctx, chat);
		owned.sides.push(side);
		return side;
	};
	const role: AgentDefinition = {
		name: "worker",
		description: "Test role",
		systemPrompt: "Do only the assigned task",
		source: "builtin",
		model: `${harness.getModel().provider}/main`,
		thinkingLevel: "medium",
	};
	const codex: Model<string> = { ...harness.getModel(), provider: "openai-codex", api: "openai-codex-responses" };
	return { harness, directory, parent, ctx, store, createManager, open, role, codex };
}

describe("model-target runtime snapshots", () => {
	it("saves BTW model, thinking, and fast defaults at creation, before opening or submitting", async () => {
		const f = await setup({ defaultFastMode: true });
		const target = f.harness.getModel("target")!;
		f.harness.settingsManager.applyOverrides({
			modelTargets: {
				btw: {
					model: { provider: target.provider, id: target.id },
					thinkingLevel: "high",
				},
			},
		});
		const chat = f.store.create("Frozen side question");
		expect(chat.sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({ type: "model_change", modelId: "target" }),
		);
		expect(chat.sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({ type: "thinking_level_change", thinkingLevel: "high" }),
		);
		expect(getSessionFastMode(chat.sessionManager)).toBe(true);
		f.harness.settingsManager.applyOverrides({
			defaultFastMode: false,
			modelTargets: { btw: { model: null, thinkingLevel: null, fastMode: false } },
		});
		await f.harness.session.setModel(f.harness.getModel("later")!);
		const side = f.open(chat);
		expect(side.agent.state.model.id).toBe("target");
		expect(side.agent.state.thinkingLevel).toBe("high");
		f.harness.setResponses([
			async (_context, options) => {
				expect(await options?.onPayload?.({ input: [] }, f.codex)).toMatchObject({ service_tier: "priority" });
				return fauxAssistantMessage("Saved side response");
			},
		]);
		await side.agent.prompt("Frozen side question");
	});

	it("uses branch target overrides for new BTW chats without changing older chats", async () => {
		const f = await setup({ defaultFastMode: true });
		const first = f.store.create("Original defaults");
		const target = f.harness.getModel("target")!;
		setSessionModelPreferences(f.parent, "btw", {
			model: { provider: target.provider, id: target.id },
			thinkingLevel: "high",
			fastMode: false,
		});
		const second = f.store.create("Branch defaults");
		expect(f.open(first).agent.state.model.id).toBe("main");
		expect(f.open(second).agent.state.model.id).toBe("target");
		expect(getSessionFastMode(first.sessionManager)).toBe(true);
		expect(getSessionFastMode(second.sessionManager)).toBe(false);
	});

	it("keeps fast OFF for older BTW histories with no priority entry", async () => {
		const f = await setup({ defaultFastMode: true });
		const chat = f.store.create("Legacy side question");
		const entries = readFileSync(chat.historyPath!, "utf8")
			.trimEnd()
			.split("\n")
			.filter((line) => {
				const entry: { type: string; customType?: string } = JSON.parse(line);
				return entry.customType !== "chatgpt-fast-mode";
			});
		writeFileSync(chat.historyPath!, `${entries.join("\n")}\n`);
		const restored = new SideSessionStore(f.ctx, f.directory, () => f.harness.settingsManager.getSettings()).open(
			chat.id,
		);
		const side = f.open(restored);
		f.harness.setResponses([
			async (_context, options) => {
				expect(await options?.onPayload?.({ input: [] }, f.codex)).toEqual({ input: [] });
				return fauxAssistantMessage("Legacy side response");
			},
		]);
		await side.agent.prompt("Legacy side question");
	});

	it("freezes submitted children and resumed selections while naming calls remain unaffected", async () => {
		const f = await setup({ defaultFastMode: true });
		const target = f.harness.getModel("target")!;
		setSessionModelPreferences(f.parent, "role:worker", {
			model: { provider: target.provider, id: target.id },
			thinkingLevel: "high",
			fastMode: true,
		});
		const manager = f.createManager();
		await manager.pause();
		const child = manager.start(f.role, "Submitted task");
		const recordDirectory = dirname(child.historyPath!);
		expect(readSubagentRecord(recordDirectory, child.id, f.parent.getSessionId())).toMatchObject({
			model: { provider: target.provider, id: target.id },
			thinkingLevel: "high",
			fastMode: true,
		});
		setSessionModelPreferences(f.parent, "role:worker", { model: null, thinkingLevel: null, fastMode: false });
		await f.harness.session.setModel(f.harness.getModel("later")!);
		let labels = 0;
		let requests = 0;
		f.harness.setResponses(
			Array.from({ length: 8 }, () => async (_context, options, _state, model) => {
				expect(model.id).toBe("target");
				if (options?.sessionId?.startsWith("label:")) {
					labels++;
					expect(options.onPayload).toBeUndefined();
					return fauxAssistantMessage("Frozen task label");
				}
				requests++;
				expect(options?.reasoning).toBe("high");
				expect(await options?.onPayload?.({ input: [] }, f.codex)).toMatchObject({ service_tier: "priority" });
				return fauxAssistantMessage("Frozen task answer");
			}),
		);
		manager.continuePaused();
		expect((await manager.wait(child.id)).agent.status).toBe("completed");
		manager.resume(child.id, "Continue frozen task");
		expect((await manager.wait(child.id)).agent.status).toBe("completed");
		expect(requests).toBe(2);
		expect(labels).toBe(2);
	});

	it.each(["resume", "recover"] as const)(
		"keeps missing legacy child fast state OFF during %s despite new parent defaults",
		async (operation) => {
			const f = await setup({ defaultFastMode: true });
			const manager = f.createManager();
			await manager.pause();
			const child = manager.start(f.role, "Legacy task");
			await manager.close();
			const recordDirectory = dirname(child.historyPath!);
			const record = readSubagentRecord(recordDirectory, child.id, f.parent.getSessionId());
			delete record.fastMode;
			writeFileSync(join(recordDirectory, "record.json"), JSON.stringify(record));
			const restored = f.createManager();
			let requests = 0;
			f.harness.setResponses(
				Array.from({ length: 4 }, () => async (_context, options) => {
					if (options?.sessionId?.startsWith("label:")) return fauxAssistantMessage("Legacy task label");
					requests++;
					expect(await options?.onPayload?.({ input: [] }, f.codex)).toEqual({ input: [] });
					return fauxAssistantMessage("Legacy task answer");
				}),
			);
			if (operation === "resume") restored.resume(child.id, "Continue");
			else restored.recover(child.id);
			expect((await restored.wait(child.id)).agent.status).toBe("completed");
			expect(requests).toBe(1);
		},
	);
});
