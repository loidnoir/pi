// Controls Codex priority-tier requests without replacing the native footer.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { getSessionFastMode, supportsFastMode } from "../../core/model-preferences.ts";

/** Registers session-persisted /fast controls for ChatGPT/Codex models. */
export default function fastExtension(pi: ExtensionAPI): void {
	const isEnabled = (ctx: ExtensionContext) =>
		getSessionFastMode(ctx.sessionManager, pi.getSettings().defaultFastMode ?? false);
	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(
			"fast",
			isEnabled(ctx) ? (supportsFastMode(ctx.model) ? "fast (priority)" : "fast (inactive)") : undefined,
		);
	};
	pi.registerCommand("fast", {
		description: "Toggle Codex priority tier (higher usage): /fast [on|off|status]",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action !== "" && action !== "on" && action !== "off" && action !== "status") {
				ctx.ui.notify("Usage: /fast [on|off|status]", "error");
				return;
			}
			const enabled = isEnabled(ctx);
			if (action === "status") {
				ctx.ui.notify(
					`Codex fast mode: ${enabled ? "on" : "off"}${enabled && !supportsFastMode(ctx.model) ? " (inactive on this provider)" : ""}`,
					"info",
				);
				return;
			}
			const next = action === "" ? !enabled : action === "on";
			if (next && !supportsFastMode(ctx.model)) {
				ctx.ui.notify("Fast mode requires a ChatGPT/Codex model (openai-codex).", "warning");
				return;
			}
			if (next !== enabled) pi.appendEntry("chatgpt-fast-mode", { enabled: next });
			updateStatus(ctx);
			ctx.ui.notify(
				next
					? "Codex fast mode: on (priority tier; higher usage). Applies to the next request."
					: "Codex fast mode: off. Applies to the next request.",
				"info",
			);
		},
	});
	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("session_tree", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
}
