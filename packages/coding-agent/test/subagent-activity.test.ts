import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	getSubagentActivity,
	registerSubagentActivity,
	type SubagentActivity,
} from "../src/core/subagents/activity.ts";

describe("session-owned sub-agent activity", () => {
	it("distinguishes absent activity from an explicitly empty source and isolates exact session owners", () => {
		const session = SessionManager.inMemory();
		const other = SessionManager.inMemory();
		expect(getSubagentActivity(session)).toBeUndefined();
		const activity: SubagentActivity = { list: () => [], subscribe: () => () => {} };
		const unregister = registerSubagentActivity(session, activity);
		expect(getSubagentActivity(session)).toBe(activity);
		expect(getSubagentActivity(session)?.list()).toEqual([]);
		expect(getSubagentActivity(other)).toBeUndefined();
		unregister();
		expect(getSubagentActivity(session)).toBeUndefined();
	});

	it("does not let a stale cleanup remove the replacement source", () => {
		const session = SessionManager.inMemory();
		const first: SubagentActivity = { list: () => ["running"], subscribe: () => () => {} };
		const second: SubagentActivity = { list: () => ["paused"], subscribe: () => () => {} };
		const removeFirst = registerSubagentActivity(session, first);
		const removeSecond = registerSubagentActivity(session, second);
		removeFirst();
		expect(getSubagentActivity(session)).toBe(second);
		removeSecond();
		expect(getSubagentActivity(session)).toBeUndefined();
	});

	it("exposes only status listing and subscriptions, not execution controls", () => {
		const session = SessionManager.inMemory();
		const stop = vi.fn();
		const subscribe = vi.fn(() => stop);
		const unregister = registerSubagentActivity(session, { list: () => ["running", "queued"], subscribe });
		const activity = getSubagentActivity(session)!;
		expect(Object.keys(activity).sort()).toEqual(["list", "subscribe"]);
		expect(activity.list()).toEqual(["running", "queued"]);
		const listener = vi.fn();
		activity.subscribe(listener)();
		expect(subscribe).toHaveBeenCalledWith(listener);
		expect(stop).toHaveBeenCalledOnce();
		unregister();
	});
});
