import type { ExtensionContext } from "../core/extensions/types.ts";

export function canContinueOnCompletion(ctx: ExtensionContext): boolean {
	return (
		ctx.isIdle() &&
		ctx.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user")
	);
}
