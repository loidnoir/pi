import { createAssistantMessageEventStream, fauxAssistantMessage, type UserMessage } from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { Agent, runAgentLoop, type StreamFn } from "../src/index.ts";

function respond(beforeResponse: () => void = () => {}): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			beforeResponse();
			stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Handled") });
		});
		return stream;
	};
}

function user(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

describe("Agent queue commits", () => {
	it.each(["mid-run", "queued continuation"] as const)(
		"acknowledges an already appended %s input when a message_end observer rejects",
		async (source) => {
			const selected = user("Selected input");
			const remaining = user("Remaining input");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let queued = source === "queued continuation";
			let rejected = false;
			const agent = new Agent({
				streamFn: respond(() => {
					if (queued) return;
					queued = true;
					agent.steer(selected);
					agent.steer(remaining);
				}),
			});
			if (source === "queued continuation") {
				agent.state.messages = [fauxAssistantMessage("Prior response")];
				agent.steer(selected);
				agent.steer(remaining);
			}
			agent.subscribe(async (event) => {
				if (event.type !== "message_end" || event.message !== selected || rejected) return;
				rejected = true;
				entered.resolve();
				await release.promise;
				throw new Error("Selected observer rejected");
			});
			const running = source === "queued continuation" ? agent.continue() : agent.prompt("Start");
			await entered.promise;
			let idle = false;
			const waiting = agent.waitForIdle().then(() => {
				idle = true;
			});
			expect(idle).toBe(false);
			release.resolve();
			await running;
			await waiting;
			expect(agent.state.messages.filter((message) => message === selected)).toHaveLength(1);
			expect(agent.state.messages.at(-1)).toMatchObject({
				stopReason: "error",
				errorMessage: "Selected observer rejected",
			});
			expect(agent.peekQueuedMessages()).toEqual([remaining]);
			await agent.continue();
			expect(agent.state.messages.filter((message) => message === selected)).toHaveLength(1);
			expect(agent.state.messages.filter((message) => message === remaining)).toHaveLength(1);
			expect(agent.hasQueuedMessages()).toBe(false);
		},
	);

	it("does not acknowledge an input when its event sink rejects before committing it", async () => {
		const input = user("Uncommitted input");
		const agent = new Agent({ streamFn: respond() });
		const failure = new Error("Sink rejected before commit");
		let committed = 0;
		await expect(
			runAgentLoop(
				[input],
				{ messages: [] },
				{
					model: agent.state.model,
					convertToLlm: agent.convertToLlm,
					onInputMessageCommitted: () => {
						committed++;
					},
				},
				(event) => {
					if (event.type === "message_end" && event.message === input) throw failure;
				},
				undefined,
				respond(),
			),
		).rejects.toBe(failure);
		expect(committed).toBe(0);
	});

	it("does not acknowledge a separate queued enqueue when the starting prompt shares its payload", async () => {
		const message = user("Shared payload");
		const agent = new Agent({ streamFn: respond() });
		agent.steer(message);
		await agent.prompt(message);
		expect(agent.state.messages.filter((value) => value === message)).toHaveLength(2);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it.each(["starting prompt", "selected enqueue"] as const)(
		"retains a new enqueue from message_end of a %s sharing its payload",
		async (source) => {
			const message = user("Re-enqueued payload");
			let requeued = false;
			const agent = new Agent({ streamFn: respond() });
			agent.subscribe((event) => {
				if (event.type !== "message_end" || event.message !== message || requeued) return;
				requeued = true;
				if (source === "selected enqueue") agent.clearSteeringQueue();
				agent.steer(message);
			});
			if (source === "selected enqueue") agent.steer(message);
			await (source === "starting prompt" ? agent.prompt(message) : agent.prompt("Start"));
			expect(agent.state.messages.filter((value) => value === message)).toHaveLength(2);
			expect(agent.hasQueuedMessages()).toBe(false);
		},
	);

	it("acknowledges the selected follow-up, not a later steering enqueue sharing its payload", async () => {
		const message = user("Shared queues");
		let requests = 0;
		let queued = false;
		const agent = new Agent({
			initialState: { messages: [fauxAssistantMessage("Prior response")] },
			streamFn: respond(() => {
				requests++;
			}),
		});
		agent.followUp(message);
		agent.subscribe((event) => {
			if (event.type !== "turn_start" || queued) return;
			queued = true;
			agent.steer(message);
		});
		await agent.continue();
		expect(requests).toBe(1);
		expect(agent.state.messages.filter((value) => value === message)).toHaveLength(2);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("acknowledges the original queued system message after rewriting its tool declarations", async () => {
		const agent = new Agent({ streamFn: respond() });
		agent.steer({
			role: "system",
			content: "Queued instruction",
			toolsAdded: [{ name: "unavailable", description: "Not executable", parameters: obj({}) }],
			timestamp: 1,
		});
		await agent.prompt("Start");
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(agent.state.messages.filter((message) => message.role === "system")).toEqual([
			{ role: "system", content: "Queued instruction", timestamp: 1 },
		]);
	});

	it("commits only the delivered prefix of an all-mode batch when delivery is aborted", async () => {
		const first = user("First");
		const second = user("Second");
		const followUp = user("Follow-up");
		let queued = false;
		const agent = new Agent({
			steeringMode: "all",
			streamFn: respond(() => {
				if (queued) return;
				queued = true;
				agent.steer(first);
				agent.steer(second);
				agent.followUp(followUp);
			}),
		});
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message === first) agent.abort();
		});
		await agent.prompt("Start");
		expect(agent.peekQueuedMessages()).toEqual([second]);
		expect(agent.state.messages.filter((message) => message === first)).toHaveLength(1);
		expect(agent.state.messages).not.toContain(second);
		await agent.continue();
		for (const input of [first, second, followUp]) {
			expect(agent.state.messages.filter((message) => message === input)).toHaveLength(1);
		}
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("retains a selected follow-up when next-turn preparation throws", async () => {
		const followUp = user("Follow-up");
		let queued = false;
		const agent = new Agent({
			prepareNextTurn: () => {
				throw new Error("Preparation failed");
			},
			streamFn: respond(() => {
				if (queued) return;
				queued = true;
				agent.followUp(followUp);
			}),
		});
		await agent.prompt("Start");
		expect(agent.peekQueuedMessages()).toEqual([followUp]);
		expect(agent.state.messages).not.toContain(followUp);
		agent.prepareNextTurn = undefined;
		await agent.continue();
		expect(agent.state.messages.filter((message) => message === followUp)).toHaveLength(1);
		expect(agent.hasQueuedMessages()).toBe(false);
	});
});
