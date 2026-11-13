import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { icon } from "../icons.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Normalizes line breaks and whitespace while preserving ANSI styles.
 */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t\u2028\u2029]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	contextUsage: ContextUsage | undefined;
}

/**
 * Single-line footer with directory and token totals on the left, context and model on the right.
 * Computes usage from the session and includes extension statuses when space permits.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private sessionStats?: SessionStats;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	invalidate(): void {
		// Theme-dependent output is rebuilt on every render.
	}

	dispose(): void {
		// This component owns no resources.
	}

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		this.sessionStats = {
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			usageTotals,
			contextUsage,
		};
		return this.sessionStats;
	}

	render(width: number): string[] {
		if (width <= 0) return [""];

		const state = this.session.state;
		const { usageTotals, contextUsage } = this.getSessionStats();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? `${contextPercentValue.toFixed(1)}%` : "?";
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextDisplay = `${contextPercent}/${formatTokens(contextWindow)}${autoIndicator}`;
		const contextColor = contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "dim";
		const rightParts = [theme.fg(contextColor, contextDisplay)];
		if (areExperimentalFeaturesEnabled()) {
			rightParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		const extensionStatuses = this.footerData.getExtensionStatuses();
		const fastActive = extensionStatuses.get("fast") === "fast (priority)";
		const fastPrefix = fastActive ? `${icon("fast")}  ` : "";
		const routed = this.session.routedModel;
		let modelDisplay = sanitizeStatusText(state.model?.id || "no-model");
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			const thinking = thinkingLevel === "off" ? "thinking off" : thinkingLevel;
			modelDisplay += ` • ${routed ? "" : fastPrefix}${thinking}`;
		} else if (!routed && fastActive) modelDisplay += ` ${icon("fast")}`;
		// A virtual model routes each request; show where the latest response went.
		if (routed) {
			const level = routed.thinkingLevel
				? ` • ${fastPrefix}${routed.thinkingLevel}`
				: fastActive
					? ` ${icon("fast")}`
					: "";
			modelDisplay += ` → ${sanitizeStatusText(routed.model.id)}${level}`;
		}

		const pwd = sanitizeStatusText(
			formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
		);
		const tokens = theme.fg("dim", `↑${formatTokens(usageTotals.input)} ↓${formatTokens(usageTotals.output)}`);
		const tokensWidth = visibleWidth(tokens);
		const minPadding = 2;
		const ellipsis = theme.fg("dim", "...");
		const leftContentWidth = visibleWidth(pwd) + 1 + tokensWidth;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			const withProvider = `(${sanitizeStatusText(state.model.provider)}) ${modelDisplay}`;
			const rightContentWidth = visibleWidth(rightParts.join(" ")) + 1 + visibleWidth(withProvider);
			if (leftContentWidth + minPadding + rightContentWidth <= width) {
				modelDisplay = withProvider;
			}
		}
		rightParts.push(theme.fg("dim", modelDisplay));
		// A long directory must not push all context/model information off the line.
		const reservedLeft = Math.min(leftContentWidth, Math.floor(width / 2));
		const right = truncateToWidth(rightParts.join(" "), Math.max(0, width - reservedLeft - minPadding), ellipsis);
		const rightWidth = visibleWidth(right);
		const leftWidth = rightWidth > 0 ? width - rightWidth - minPadding : width;
		const pwdWidth = leftWidth - tokensWidth - 1;
		let left =
			pwdWidth > 0
				? `${truncateToWidth(theme.fg("dim", pwd), pwdWidth, ellipsis)} ${tokens}`
				: truncateToWidth(tokens, leftWidth, ellipsis);

		// Extension statuses use only spare space so they cannot displace the main footer fields.
		const statusWidth = leftWidth - visibleWidth(left) - 1;
		if (extensionStatuses.size > 0 && statusWidth > 0) {
			const statuses = Array.from(extensionStatuses.entries())
				.filter(([key]) => key !== "fast" || !fastActive)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, text]) => `${key === "recovery" ? `${icon("pause")}  ` : ""}${sanitizeStatusText(text)}`)
				.join(" ");
			if (statuses) left += ` ${truncateToWidth(statuses, statusWidth, ellipsis)}`;
		}

		const padding = rightWidth > 0 ? " ".repeat(width - visibleWidth(left) - rightWidth) : "";
		return [left + padding + right];
	}
}
