import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ContextUsage } from "../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { icon, setIconPreset } from "../src/modes/interactive/icons.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(
	options: {
		sessionName?: string;
		cwd?: string;
		modelId?: string | null;
		provider?: string;
		reasoning?: boolean;
		thinkingLevel?: string;
		usage?: AssistantUsage;
		backgroundUsage?: AssistantUsage;
		branchUsage?: AssistantUsage;
		compactionUsage?: AssistantUsage;
		toolUsage?: AssistantUsage;
		usingSubscription?: boolean;
		contextUsage?: ContextUsage | "unavailable";
		routedModel?: { model: { id: string }; thinkingLevel?: string };
	} = {},
): AgentSession {
	const entries: Array<Record<string, unknown>> = [];

	if (options.usage !== undefined) {
		entries.push({ type: "message", message: { role: "assistant", usage: options.usage } });
	}
	if (options.backgroundUsage !== undefined) {
		entries.push({ type: "usage", usage: options.backgroundUsage });
	}
	if (options.branchUsage !== undefined) {
		entries.push({ type: "branch_summary", usage: options.branchUsage });
	}
	if (options.compactionUsage !== undefined) {
		entries.push({ type: "compaction", usage: options.compactionUsage });
	}
	if (options.toolUsage !== undefined) {
		entries.push({ type: "message", message: { role: "toolResult", usage: options.toolUsage } });
	}

	const session = {
		state: {
			model:
				options.modelId === null
					? undefined
					: {
							id: options.modelId ?? "test-model",
							provider: options.provider ?? "test",
							contextWindow: 200_000,
							reasoning: options.reasoning ?? false,
						},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "test-session",
			getLeafId: () => null,
			getSessionName: () => options.sessionName,
			getCwd: () => options.cwd ?? "/tmp/project",
		},
		getContextUsage: () =>
			options.contextUsage === "unavailable"
				? undefined
				: (options.contextUsage ?? { tokens: 24_600, contextWindow: 200_000, percent: 12.3 }),
		routedModel: options.routedModel,
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(statuses = new Map<string, string>(), providerCount = 1): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "hidden-git-branch",
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => providerCount,
		onBranchChange: () => () => {},
	};
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent single-line layout", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	beforeEach(() => {
		vi.stubEnv("PI_EXPERIMENTAL", "0");
	});

	afterEach(() => setIconPreset("unicode"));

	it("uses the current shared pause icon for recovery status without changing its text", () => {
		const statuses = new Map([["recovery", "Paused · /pause to continue"]]);
		const footer = new FooterComponent(createSession(), createFooterData(statuses));
		for (const preset of ["nerd", "unicode"] as const) {
			setIconPreset(preset);
			footer.invalidate();
			expect(stripAnsi(footer.render(160)[0])).toContain(`${icon("pause")}  Paused · /pause to continue`);
			for (const width of [0, 1, 8, 40, 160])
				expect(visibleWidth(footer.render(width)[0])).toBeLessThanOrEqual(width);
		}
		expect(statuses.get("recovery")).toBe("Paused · /pause to continue");
	});

	it.each(["unicode", "nerd"] as const)("shows active fast mode before thinking on the right (%s)", (preset) => {
		setIconPreset(preset);
		const statuses = new Map([["fast", "fast (priority)"]]);
		const footer = new FooterComponent(
			createSession({ reasoning: true, thinkingLevel: "xhigh" }),
			createFooterData(statuses),
		);
		const text = stripAnsi(footer.render(160)[0]);
		expect(text.endsWith(`test-model • ${icon("fast")}  xhigh`)).toBe(true);
		expect(text).not.toContain("fast (priority)");
		expect(statuses.get("fast")).toBe("fast (priority)");
		for (const width of [0, 1, 8, 40, 160]) expect(visibleWidth(footer.render(width)[0])).toBeLessThanOrEqual(width);
		setIconPreset(preset === "nerd" ? "unicode" : "nerd");
		footer.invalidate();
		expect(stripAnsi(footer.render(160)[0])).toContain(`${icon("fast")}  xhigh`);
	});

	it.each([
		{ options: { reasoning: true }, suffix: () => `test-model • ${icon("fast")}  thinking off` },
		{ options: {}, suffix: () => `test-model ${icon("fast")}` },
		{
			options: {
				reasoning: true,
				thinkingLevel: "high",
				routedModel: { model: { id: "physical" }, thinkingLevel: "medium" },
			},
			suffix: () => `test-model • high → physical • ${icon("fast")}  medium`,
		},
		{
			options: { routedModel: { model: { id: "physical" } } },
			suffix: () => `test-model → physical ${icon("fast")}`,
		},
	])("keeps the fast icon at the rightmost model/thinking display: $options", ({ options, suffix }) => {
		const footer = new FooterComponent(
			createSession(options),
			createFooterData(new Map([["fast", "fast (priority)"]])),
		);
		expect(stripAnsi(footer.render(160)[0]).endsWith(suffix())).toBe(true);
	});

	it("keeps inactive fast mode distinct and hides the flash when fast mode is off", () => {
		const statuses = new Map([["fast", "fast (inactive)"]]);
		const footer = new FooterComponent(
			createSession({ reasoning: true, thinkingLevel: "xhigh" }),
			createFooterData(statuses),
		);
		expect(stripAnsi(footer.render(160)[0])).toContain("fast (inactive)");
		expect(stripAnsi(footer.render(160)[0])).not.toContain(icon("fast"));
		statuses.delete("fast");
		expect(stripAnsi(footer.render(160)[0])).not.toContain("fast");
		expect(stripAnsi(footer.render(160)[0])).not.toContain(icon("fast"));
	});

	it("puts the directory and token counts on the left and context/model on the right", () => {
		const session = createSession({
			reasoning: true,
			thinkingLevel: "high",
			usage: { input: 12_345, output: 6_789, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		});
		const footer = new FooterComponent(session, createFooterData());
		const lines = footer.render(120);

		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBe(120);
		expect(stripAnsi(lines[0])).toMatch(/^\/tmp\/project ↑12k ↓6\.8k {2,}12\.3%\/200k \(auto\) test-model • high$/);
	});

	it.each([
		{ providerCount: 1, expectedModel: "test-model" },
		{ providerCount: 2, expectedModel: "(test) test-model" },
	])("uses the existing provider label policy with $providerCount providers", ({ providerCount, expectedModel }) => {
		const footer = new FooterComponent(createSession(), createFooterData(new Map(), providerCount));

		expect(stripAnsi(footer.render(120)[0]).endsWith(`12.3%/200k (auto) ${expectedModel}`)).toBe(true);
	});

	it("omits the provider when adding it would require truncating the main fields", () => {
		const footer = new FooterComponent(createSession(), createFooterData(new Map(), 2));
		const fullLine = "/tmp/project ↑0 ↓0  12.3%/200k (auto) (test) test-model";
		const width = visibleWidth(fullLine);

		expect(stripAnsi(footer.render(width)[0])).toBe(fullLine);
		const narrowLine = footer.render(width - 1)[0];
		expect(visibleWidth(narrowLine)).toBe(width - 1);
		expect(stripAnsi(narrowLine)).not.toContain("(test)");
		expect(stripAnsi(narrowLine)).toMatch(/^\/tmp\/project ↑0 ↓0 {2,}12\.3%\/200k \(auto\) test-model$/);
	});

	it("shows zero input and output counts before any usage", () => {
		const footer = new FooterComponent(createSession(), createFooterData());

		expect(stripAnsi(footer.render(120)[0])).toContain("/tmp/project ↑0 ↓0");
	});

	it("keeps home directory abbreviation in the rendered line", () => {
		vi.stubEnv("HOME", "/home/user");
		const footer = new FooterComponent(createSession({ cwd: "/home/user/project" }), createFooterData());

		expect(stripAnsi(footer.render(120)[0])).toMatch(/^~\/project ↑0 ↓0 /);
	});

	it("omits branch, session name, cache stats, cost, and subscription estimates", () => {
		const session = createSession({
			sessionName: "hidden-session-title",
			provider: "kimi-coding",
			usingSubscription: true,
			usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 50, cost: { total: 1.234 } },
		});
		const data = createFooterData();
		const branch = vi.spyOn(data, "getGitBranch");
		const sessionName = vi.spyOn(session.sessionManager, "getSessionName");
		const subscription = vi.spyOn(session.modelRuntime, "isUsingSubscription");
		const footer = new FooterComponent(session, data);
		const text = stripAnsi(footer.render(160)[0]);

		expect(text).toContain("↑100 ↓10");
		expect(text).not.toMatch(/hidden-git-branch|hidden-session-title|R50|W50|CH|\$|\(sub\)/);
		expect(branch).not.toHaveBeenCalled();
		expect(sessionName).not.toHaveBeenCalled();
		expect(subscription).not.toHaveBeenCalled();
	});

	it("includes background, summary, compaction, and tool usage in input/output totals", () => {
		const session = createSession({
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
			backgroundUsage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
			branchUsage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } },
			compactionUsage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.125 } },
			toolUsage: { input: 15, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.375 } },
		});
		const footer = new FooterComponent(session, createFooterData());

		expect(stripAnsi(footer.render(120)[0])).toContain("↑150 ↓24");
	});

	it("updates cached totals after an entry is appended", () => {
		const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } };
		const session = createSession({ usage });
		const footer = new FooterComponent(session, createFooterData());
		const getEntries = vi.spyOn(session.sessionManager, "getEntries");
		const getContextUsage = vi.spyOn(session, "getContextUsage");
		expect(stripAnsi(footer.render(120)[0])).toContain("↑10 ↓1");
		footer.render(100);
		expect(getEntries).toHaveBeenCalledTimes(1);
		expect(getContextUsage).toHaveBeenCalledTimes(1);

		session.sessionManager.getEntries().push({ type: "message", message: { role: "assistant", usage } } as never);
		expect(stripAnsi(footer.render(120)[0])).toContain("↑20 ↓2");
		expect(getContextUsage).toHaveBeenCalledTimes(2);
	});

	it("updates cached totals when the session changes", () => {
		const footer = new FooterComponent(createSession(), createFooterData());
		footer.render(120);
		footer.setSession(
			createSession({ usage: { input: 42, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }),
		);

		expect(stripAnsi(footer.render(120)[0])).toContain("↑42 ↓7");
	});

	it("shows the physical model and thinking level a virtual model routed to", () => {
		const session = createSession({
			modelId: "auto",
			reasoning: true,
			thinkingLevel: "high",
			routedModel: { model: { id: "gpt-5.6-luna" }, thinkingLevel: "medium" },
		});
		const footer = new FooterComponent(session, createFooterData());

		expect(stripAnsi(footer.render(120)[0])).toMatch(/auto • high → gpt-5\.6-luna • medium$/);
	});

	it("shows when thinking is off on a reasoning model", () => {
		const footer = new FooterComponent(createSession({ reasoning: true }), createFooterData());

		expect(stripAnsi(footer.render(120)[0])).toMatch(/test-model • thinking off$/);
	});

	it("preserves the experimental indication on the same line", () => {
		vi.stubEnv("PI_EXPERIMENTAL", "1");
		const footer = new FooterComponent(createSession(), createFooterData());
		const lines = footer.render(120);

		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0])).toContain("12.3%/200k (auto) • xp test-model");
		expect(lines[0]).toContain(theme.bold(theme.fg("warning", "xp")));
	});

	it("preserves unknown context usage and the context window", () => {
		const session = createSession({ contextUsage: { tokens: null, contextWindow: 128_000, percent: null } });
		const footer = new FooterComponent(session, createFooterData());

		expect(stripAnsi(footer.render(120)[0])).toContain("?/128k (auto)");
	});

	it("falls back to the model window when context usage is unavailable", () => {
		const footer = new FooterComponent(createSession({ contextUsage: "unavailable" }), createFooterData());

		expect(stripAnsi(footer.render(120)[0])).toContain("0.0%/200k (auto)");
	});

	it("handles missing models and context usage", () => {
		const footer = new FooterComponent(
			createSession({ modelId: null, contextUsage: "unavailable" }),
			createFooterData(),
		);

		expect(stripAnsi(footer.render(120)[0])).toMatch(/0\.0%\/0 \(auto\) no-model$/);
	});

	it("omits the auto indication when auto-compaction is disabled", () => {
		const footer = new FooterComponent(createSession(), createFooterData());
		footer.setAutoCompactEnabled(false);
		const text = stripAnsi(footer.render(120)[0]);

		expect(text).toContain("12.3%/200k");
		expect(text).not.toContain("(auto)");
	});

	it.each([
		{ percent: 70, color: "dim" },
		{ percent: 70.1, color: "warning" },
		{ percent: 90, color: "warning" },
		{ percent: 90.1, color: "error" },
	] as const)("keeps the $color context color at $percent percent", ({ percent, color }) => {
		const footer = new FooterComponent(
			createSession({ contextUsage: { tokens: 0, contextWindow: 200_000, percent } }),
			createFooterData(),
		);

		expect(footer.render(120)[0]).toContain(theme.fg(color, `${percent.toFixed(1)}%/200k (auto)`));
	});

	it("sorts extension statuses by key and normalizes them without adding a row", () => {
		const data = createFooterData(
			new Map([
				["zeta", "\x1b[32mready\x1b[0m"],
				["alpha", " first\nsecond\r\t third\u2028fourth\u2029fifth "],
			]),
		);
		const footer = new FooterComponent(createSession(), data);
		const lines = footer.render(160);

		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toMatch(/[\r\n\t\u2028\u2029]/);
		expect(stripAnsi(lines[0])).toContain("↑0 ↓0 first second third fourth fifth ready");
		expect(lines[0]).toContain("\x1b[32mready\x1b[0m");
		expect(stripAnsi(lines[0])).toMatch(/12\.3%\/200k \(auto\) test-model$/);
	});

	it("truncates long styled statuses without displacing the main footer fields", () => {
		const footer = new FooterComponent(
			createSession(),
			createFooterData(new Map([["status", `\x1b[32m${"busy ".repeat(100)}\x1b[0m`]])),
		);
		const lines = footer.render(100);

		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBe(100);
		expect(stripAnsi(lines[0])).toMatch(/^\/tmp\/project ↑0 ↓0 busy .*\.\.\. {2}12\.3%\/200k \(auto\) test-model$/);
	});

	it("truncates long directories while keeping token counts and right-hand details", () => {
		const footer = new FooterComponent(createSession({ cwd: `/tmp/${"directory/".repeat(50)}` }), createFooterData());
		const lines = footer.render(100);

		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBe(100);
		expect(stripAnsi(lines[0])).toMatch(/^\/tmp\/.*\.\.\. ↑0 ↓0 {2}12\.3%\/200k \(auto\) test-model$/);
	});

	it("keeps Unicode and ANSI content within every narrow width, including zero", () => {
		const longNames = new FooterComponent(
			createSession({
				cwd: `/tmp/${"한글👩‍💻e\u0301/".repeat(20)}`,
				modelId: `\x1b[36m${"模型👩‍💻e\u0301".repeat(20)}\x1b[0m`,
				provider: "공급자",
				reasoning: true,
				thinkingLevel: "high",
			}),
			createFooterData(new Map([["status", `\x1b[32m${"好👩‍💻e\u0301".repeat(30)}\x1b[0m`]])),
		);

		const longStatuses = new FooterComponent(
			createSession(),
			createFooterData(new Map([["status", `\x1b[32m${"好👩‍💻e\u0301".repeat(30)}\x1b[0m`]])),
		);

		for (const footer of [longNames, longStatuses]) {
			for (let width = 0; width <= 160; width++) {
				const lines = footer.render(width);
				expect(lines, `width ${width}`).toHaveLength(1);
				expect(visibleWidth(lines[0]), `width ${width}`).toBeLessThanOrEqual(width);
				expect(stripAnsi(lines[0]), `width ${width}`).not.toMatch(/[\r\n\t\x1b\uFFFD]/);
			}
			expect(footer.render(0)).toEqual([""]);
		}
		expect(stripAnsi(longStatuses.render(120)[0])).toContain("好👩‍💻e\u0301");
	});

	it("normalizes multiline directories and model names into one terminal row", () => {
		const footer = new FooterComponent(
			createSession({ cwd: "/tmp/first\nsecond", modelId: "model\r\nname", provider: "provider\tname" }),
			createFooterData(new Map(), 2),
		);
		const lines = footer.render(120);

		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0])).toMatch(/^\/tmp\/first second ↑0 ↓0 .*\(provider name\) model name$/);
	});
});
