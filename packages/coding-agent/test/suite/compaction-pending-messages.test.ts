import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionBeforeCompactEvent } from "../../src/core/extensions/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const IMAGE: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
};

function summary(event: SessionBeforeCompactEvent) {
	return {
		compaction: {
			summary: "Preserved earlier work",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
		},
	};
}

function seed(harness: Harness): void {
	harness.sessionManager.appendMessage({ role: "user", content: "Earlier goal", timestamp: 1 });
	harness.sessionManager.appendMessage(fauxAssistantMessage("Earlier evidence".repeat(200), { timestamp: 2 }));
	harness.session.refreshContext();
}

function persisted(harness: Harness, message: AgentMessage) {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message === message);
}

describe("pending input across compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.abort();
			harness.cleanup();
		}
	});

	it.each(["mid-run", "queued continuation"] as const)(
		"does not re-persist a selected %s input after a later Agent observer rejects",
		async (source) => {
			const harness = await createHarness({
				tools: [],
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
			});
			harnesses.push(harness);
			seed(harness);
			let selected: AgentMessage | undefined;
			let selectedId: string | undefined;
			const enqueue = async () => {
				await harness.session.steer("Selected input", [IMAGE]);
				selected = harness.session.agent.peekQueuedMessages()[0];
				if (!selected || selected.role !== "user") throw new Error("Missing selected input");
				selectedId = harness.session.recovery.inputId(selected);
				await harness.session.steer("Remaining input");
			};
			let rejected = false;
			harness.session.agent.subscribe(async (event) => {
				if (event.type !== "message_end" || event.message !== selected || rejected) return;
				rejected = true;
				throw new Error("Observer rejected after session persistence");
			});
			const countsInRequests: number[] = [];
			const response = (context: TranscriptContext) => {
				countsInRequests.push(
					context.messages.filter(
						(message) => message.role === "user" && getMessageText(message) === "Selected input",
					).length,
				);
				return fauxAssistantMessage("Remaining input handled");
			};
			if (source === "queued continuation") {
				await enqueue();
				harness.setResponses([response]);
				await harness.session.agent.continue();
			} else {
				harness.setResponses([
					async () => {
						await enqueue();
						return fauxAssistantMessage("Original response");
					},
					response,
				]);
				await harness.session.agent.prompt("Start");
			}
			if (!selected) throw new Error("Missing selected input");
			expect(persisted(harness, selected).map((entry) => entry.id)).toEqual([selectedId]);
			expect(harness.session.messages.filter((message) => message === selected)).toHaveLength(1);
			expect(harness.session.agent.peekQueuedMessages().map(getMessageText)).toEqual(["Remaining input"]);
			expect(harness.session.recovery.info().queuedInputs).toBe(1);
			await harness.session.agent.continue();
			expect(countsInRequests).toEqual([1]);
			expect(persisted(harness, selected).map((entry) => entry.id)).toEqual([selectedId]);
			expect(harness.session.messages.filter((message) => message === selected)).toHaveLength(1);
			expect(harness.session.recovery.info().queuedInputs).toBe(0);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		},
	);

	it.each(["success", "cancel", "failure"] as const)(
		"preserves inputs queued before and during manual compaction: %s",
		async (outcome) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const harness = await createHarness({
				tools: [],
				settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							entered.resolve();
							await release.promise;
							if (outcome === "cancel") return { cancel: true };
							return outcome === "success" ? summary(event) : undefined;
						});
					},
				],
			});
			harnesses.push(harness);
			seed(harness);
			await harness.session.steer("same instruction", [IMAGE]);
			const first = harness.session.agent.peekQueuedMessages()[0];
			if (!first || first.role !== "user") throw new Error("Missing queued input");
			const firstId = harness.session.recovery.inputId(first);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic summary failure" }),
			]);
			const compacting = harness.session.compact();
			const result = outcome === "success" ? compacting : expect(compacting).rejects.toThrow();
			await entered.promise;
			await harness.session.steer("same instruction");
			await harness.session.followUp("after both instructions", [IMAGE]);
			release.resolve();
			await result;

			expect(harness.session.getSteeringMessages()).toEqual(["same instruction", "same instruction"]);
			expect(harness.session.getFollowUpMessages()).toEqual(["after both instructions"]);
			expect(harness.session.agent.peekQueuedMessages()[0]).toBe(first);
			expect(harness.session.recovery.inputId(first)).toBe(firstId);
			expect(harness.session.recovery.info().queuedInputs).toBe(3);
			expect(persisted(harness, first)).toHaveLength(0);
			const delivered: string[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "message_start" && event.message.role === "user") {
					delivered.push(getMessageText(event.message));
				}
			});
			harness.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("Instruction handled")));
			await harness.session.agent.continue();
			expect(delivered).toEqual(["same instruction", "same instruction", "after both instructions"]);
			expect(persisted(harness, first).map((entry) => entry.id)).toEqual([firstId]);
			expect(first.content).toContainEqual(IMAGE);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.session.recovery.info().queuedInputs).toBe(0);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		},
	);

	it.each(["success", "cancel", "failure"] as const)(
		"delivers pending inputs once after overflow compaction: %s",
		async (outcome) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const harness = await createHarness({
				tools: [],
				settings: {
					compaction: { prepareThreshold: 98, threshold: 99, keepRecentTokens: 1 },
					retry: { enabled: false },
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							entered.resolve();
							await release.promise;
							if (outcome === "cancel") return { cancel: true };
							return outcome === "success" ? summary(event) : undefined;
						});
					},
				],
			});
			harnesses.push(harness);
			seed(harness);
			let first: AgentMessage | undefined;
			let firstId: string | undefined;
			const requests: string[] = [];
			harness.setResponses([
				async () => {
					await harness.session.steer("first pending payload", [IMAGE]);
					first = harness.session.agent.peekQueuedMessages()[0];
					if (!first || first.role !== "user") throw new Error("Missing queued input");
					firstId = harness.session.recovery.inputId(first);
					await harness.session.followUp("follow-up payload", [IMAGE]);
					return fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "maximum context length exceeded",
					});
				},
				...(outcome === "failure"
					? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic summary failure" })]
					: []),
				...Array.from({ length: 3 }, () => (context: TranscriptContext) => {
					const input = context.messages.findLast((message) => message.role === "user");
					requests.push(getMessageText(input));
					return fauxAssistantMessage("Pending input handled");
				}),
			]);
			const running = harness.session.prompt("Continue earlier work");
			await entered.promise;
			const selectedDuringCompaction = harness.session.agent.peekQueuedMessages()[0];
			await harness.session.steer("arrived during compaction");
			release.resolve();
			await running;
			expect(selectedDuringCompaction).toBe(first);
			expect(requests).toEqual(["first pending payload", "arrived during compaction", "follow-up payload"]);
			if (!first) throw new Error("Missing queued input");
			expect(persisted(harness, first).map((entry) => entry.id)).toEqual([firstId]);
			expect(first.role === "user" && first.content).toContainEqual(IMAGE);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.session.recovery.info().queuedInputs).toBe(0);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			expect(harness.eventsOfType("compaction_end").filter((event) => event.reason === "overflow")).toHaveLength(1);
		},
	);

	it.each(["steer", "followUp"] as const)(
		"keeps the accepted %s text when image normalization mutates its payload",
		async (mode) => {
			const harness = await createHarness({ tools: [], settings: { compaction: { enabled: false } } });
			harnesses.push(harness);
			await harness.session[mode]("Accepted instruction", [IMAGE]);
			const message = harness.session.agent.peekQueuedMessages()[0];
			if (!message || message.role !== "user") throw new Error("Missing queued input");
			// Delivery-time image normalization replaces content on this same payload object.
			message.content = [
				{ type: "text", text: "Accepted instruction\n\n[Image: original 1200x9000, displayed at 267x2000.]" },
				IMAGE,
			];
			expect(
				mode === "steer" ? harness.session.getSteeringMessages() : harness.session.getFollowUpMessages(),
			).toEqual(["Accepted instruction"]);
			expect(harness.session.clearQueue()).toEqual({
				steering: mode === "steer" ? ["Accepted instruction"] : [],
				followUp: mode === "followUp" ? ["Accepted instruction"] : [],
			});
		},
	);

	it("updates the correct queue when a follow-up and later steering have identical text", async () => {
		let enqueueSteering = async () => {};
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", summary);
					pi.on("turn_start", () => enqueueSteering());
				},
			],
		});
		harnesses.push(harness);
		seed(harness);
		await harness.session.followUp("same instruction");
		await harness.session.compact();
		enqueueSteering = async () => {
			await harness.session.steer("same instruction");
		};
		const queuesAtDelivery: Array<{ steering: readonly string[]; followUp: readonly string[] }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") {
				queuesAtDelivery.push({
					steering: [...harness.session.getSteeringMessages()],
					followUp: [...harness.session.getFollowUpMessages()],
				});
			}
		});
		harness.setResponses([fauxAssistantMessage("Both instructions handled")]);
		await harness.session.agent.continue();
		expect(queuesAtDelivery).toEqual([
			{ steering: ["same instruction"], followUp: [] },
			{ steering: [], followUp: [] },
		]);
	});

	it.each(["first pending payload", ""])(
		"does not summarize batched steering before its first model request: %j",
		async (firstText) => {
			const harness = await createHarness({
				tools: [],
				models: [{ id: "faux-1", contextWindow: 10000, maxTokens: 100 }],
				settings: {
					compaction: { prepareThreshold: 20, threshold: 30, keepRecentTokens: 1 },
					retry: { enabled: false },
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", summary);
					},
				],
			});
			harnesses.push(harness);
			harness.session.setSteeringMode("all");
			await harness.session.steer(firstText, [IMAGE]);
			await harness.session.steer("second pending payload");
			let request: string[] = [];
			let images: ImageContent[] = [];
			harness.setResponses([
				(context) => {
					request = context.messages.filter((message) => message.role === "user").map(getMessageText);
					images = context.messages.flatMap((message) =>
						message.role === "user" && typeof message.content !== "string"
							? message.content.filter((part): part is ImageContent => part.type === "image")
							: [],
					);
					return fauxAssistantMessage("All inputs handled");
				},
			]);
			await harness.session.prompt("Initial request".repeat(700));
			expect(request).toContain(firstText);
			expect(request).toContain("second pending payload");
			expect(images).toEqual([IMAGE]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		},
	);

	it.each(["success", "cancel", "failure", "abort", "preparation failure"] as const)(
		"preserves selected steering and follow-ups when threshold preparation ends with %s",
		async (outcome) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const tool: AgentTool = {
				name: "large_result",
				label: "Large result",
				description: "Cross the threshold between requests",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "evidence".repeat(2000) }], details: {} }),
			};
			const harness = await createHarness({
				tools: [tool],
				models: [{ id: "faux-1", contextWindow: 10000, maxTokens: 100 }],
				settings: {
					compaction: { enabled: false, prepareThreshold: 20, threshold: 30, keepRecentTokens: 1 },
					outputArtifacts: { maxInlineTokens: 10000, contextWindowFraction: 1 },
					retry: { enabled: false },
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							entered.resolve();
							await release.promise;
							if (outcome === "cancel") return { cancel: true };
							return outcome === "failure" ? undefined : summary(event);
						});
					},
				],
			});
			harnesses.push(harness);
			seed(harness);
			const prepare = harness.session.agent.prepareNextTurnWithContext;
			if (outcome === "preparation failure") {
				harness.session.agent.prepareNextTurnWithContext = async (turn, signal) => {
					await prepare?.(turn, signal);
					throw new Error("Synthetic next-turn preparation failure");
				};
			}
			let selected: AgentMessage | undefined;
			harness.session.subscribe((event) => {
				if (event.type === "compaction_end" && !event.result) harness.session.setAutoCompactionEnabled(false);
				if (
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.errorMessage === "Synthetic next-turn preparation failure"
				) {
					void harness.session.abort();
				}
			});
			const requested: string[][] = [];
			harness.setResponses([
				async () => {
					harness.session.setAutoCompactionEnabled(true);
					await harness.session.steer("selected instruction", [IMAGE]);
					selected = harness.session.agent.peekQueuedMessages()[0];
					await harness.session.followUp("follow-up instruction");
					return fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" });
				},
				...(outcome === "failure"
					? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic summary failure" })]
					: []),
				...Array.from({ length: 3 }, () => (context: TranscriptContext) => {
					requested.push(context.messages.filter((message) => message.role === "user").map(getMessageText));
					return fauxAssistantMessage("Queued instruction handled");
				}),
			]);
			const running = harness.session.prompt("Continue earlier work");
			await entered.promise;
			await harness.session.steer("arrived during compaction");
			const selectedWhileCompacting = harness.session.agent.peekQueuedMessages()[0];
			const aborting = outcome === "abort" ? harness.session.abort() : undefined;
			release.resolve();
			await running;
			await aborting;
			expect(selectedWhileCompacting).toBe(selected);
			if (outcome === "success" || outcome === "cancel" || outcome === "failure") {
				expect(requested.map((messages) => messages.at(-1))).toEqual([
					"selected instruction",
					"arrived during compaction",
					"follow-up instruction",
				]);
				if (!selected) throw new Error("Missing selected input");
				expect(persisted(harness, selected)).toHaveLength(1);
				expect(harness.session.pendingMessageCount).toBe(0);
				expect(harness.session.agent.hasQueuedMessages()).toBe(false);
				return;
			}

			expect(harness.session.getSteeringMessages()).toEqual(["selected instruction", "arrived during compaction"]);
			expect(harness.session.getFollowUpMessages()).toEqual(["follow-up instruction"]);
			expect(harness.session.agent.peekQueuedMessages()[0]).toBe(selected);
			expect(requested).toEqual([]);
			expect(harness.session.recovery.info().queuedInputs).toBe(3);
			harness.session.agent.prepareNextTurnWithContext = prepare;
			harness.session.setAutoCompactionEnabled(false);
			const delivered: string[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "message_start" && event.message.role === "user")
					delivered.push(getMessageText(event.message));
			});
			harness.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("Recovered instruction handled")));
			await harness.session.sendCustomMessage(
				{ customType: "resume-queued-input", content: "Resume queued instructions", display: false },
				{ triggerTurn: true },
			);
			expect(delivered).toEqual(["selected instruction", "arrived during compaction", "follow-up instruction"]);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		},
	);
});
