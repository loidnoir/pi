// Session-keyed, read-only child activity for native UI; prompts and execution controls stay private.
import type { ReadonlySessionManager } from "../session-manager.ts";
import type { SubagentStatus } from "./state.ts";

export interface SubagentActivity {
	list(): readonly SubagentStatus[];
	subscribe(listener: () => void): () => void;
}

const activities = new WeakMap<ReadonlySessionManager, SubagentActivity>();

/** Publish this session's child activity, including explicitly disabled native delegation. */
export function registerSubagentActivity(session: ReadonlySessionManager, activity: SubagentActivity): () => void {
	activities.set(session, activity);
	return () => {
		if (activities.get(session) === activity) activities.delete(session);
	};
}

/** Return only registered live activity; an absent source means unknown, not idle. */
export function getSubagentActivity(session: ReadonlySessionManager): SubagentActivity | undefined {
	return activities.get(session);
}
