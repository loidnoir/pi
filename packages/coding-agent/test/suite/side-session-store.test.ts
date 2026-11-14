import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SideSessionStore } from "../../src/core/side-session-store.ts";
import { getMessageText } from "./harness.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-btw-store-"));
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

function persistentParent(): SessionManager {
	return SessionManager.create(directory, join(directory, "sessions"), { id: "reused-custom-id" });
}

describe("saved side-session storage", () => {
	it("persists an unsaved parent, stores only child messages and prompt-derived title, and reopens after restart", () => {
		const parent = persistentParent();
		expect(existsSync(parent.getSessionFile()!)).toBe(false);
		const store = new SideSessionStore({ sessionManager: parent }, directory);
		const chat = store.create("  Explain\n\tthese boundaries  ");
		expect(existsSync(parent.getSessionFile()!)).toBe(true);
		expect(chat.title).toBe("Explain these boundaries");
		const hash = createHash("sha256").update(resolve(parent.getSessionFile()!)).digest("hex");
		expect(chat.historyPath).toBe(join(directory, "btw", hash, chat.id, "session.jsonl"));
		chat.sessionManager.appendMessage({ role: "user", content: "Child question", timestamp: Date.now() });
		const reloaded = new SideSessionStore(
			{ sessionManager: SessionManager.open(parent.getSessionFile()!) },
			directory,
		);
		expect(reloaded.open(chat.id).ownMessages.map(getMessageText)).toEqual([
			"  Explain\n\tthese boundaries  ",
			"Child question",
		]);
		expect(reloaded.list().items).toEqual([
			expect.objectContaining({ id: chat.id, title: chat.title, historyPath: chat.historyPath }),
		]);
		const entries = chat.sessionManager.getEntries();
		expect(entries.find((entry) => entry.type === "custom" && entry.customType === "pi.btw")).toMatchObject({
			data: {
				parentFile: parent.getSessionFile(),
				parentSessionId: parent.getSessionId(),
				parentTimestamp: parent.getHeader()!.timestamp,
				parentLeafId: null,
			},
		});
	});

	it("freezes the exact parent leaf across later edits, compaction, and branch changes", () => {
		const parent = persistentParent();
		const original = parent.appendMessage({ role: "user", content: "Original seed", timestamp: Date.now() });
		parent.appendContextEdit(original, { content: "Seed as edited before launch" });
		const chat = new SideSessionStore({ sessionManager: parent }, directory).create("Question");
		const seed = chat.resolveParentMessages();
		parent.appendContextEdit(original, { content: "Later edit" });
		parent.appendCompaction("Later compaction", null, 100);
		parent.branch(original);
		parent.appendMessage({ role: "user", content: "Different branch", timestamp: Date.now() });
		expect(chat.resolveParentMessages()).toEqual(seed);
		expect(seed.map(getMessageText)).toEqual(["Seed as edited before launch"]);
		const reopened = new SideSessionStore({ sessionManager: parent }, directory).open(chat.id);
		expect(reopened.resolveParentMessages()).toEqual(seed);
		expect(readFileSync(chat.historyPath!, "utf8")).not.toContain("Original seed");
	});

	it("loads parent JSONL without repairing a missing newline or modifying it", () => {
		const parent = persistentParent();
		parent.appendMessage({ role: "user", content: "Seed", timestamp: Date.now() });
		const chat = new SideSessionStore({ sessionManager: parent }, directory).create("Question");
		const file = parent.getSessionFile()!;
		const bytes = readFileSync(file, "utf8").trimEnd();
		writeFileSync(file, bytes);
		expect(chat.resolveParentMessages().map(getMessageText)).toEqual(["Seed"]);
		expect(readFileSync(file, "utf8")).toBe(bytes);
	});

	it("does not repair child files while listing or opening saved history", () => {
		const parent = persistentParent();
		const chat = new SideSessionStore({ sessionManager: parent }, directory).create("Question");
		const bytes = readFileSync(chat.historyPath!, "utf8").trimEnd();
		writeFileSync(chat.historyPath!, bytes);
		const reloaded = new SideSessionStore({ sessionManager: parent }, directory);
		expect(reloaded.list().total).toBe(1);
		expect(reloaded.open(chat.id).ownMessages.map(getMessageText)).toEqual(["Question"]);
		expect(readFileSync(chat.historyPath!, "utf8")).toBe(bytes);
	});

	it("retains viewable child history when parent is moved, deleted, replaced, or lacks the frozen leaf", () => {
		const parent = persistentParent();
		parent.appendMessage({ role: "user", content: "Seed", timestamp: Date.now() });
		const chat = new SideSessionStore({ sessionManager: parent }, directory).create("Question");
		chat.sessionManager.appendMessage({ role: "user", content: "Saved child", timestamp: Date.now() });
		const file = parent.getSessionFile()!;
		const original = readFileSync(file, "utf8");
		renameSync(file, `${file}.moved`);
		const store = new SideSessionStore({ sessionManager: parent }, directory);
		expect(store.open(chat.id).ownMessages.map(getMessageText)).toEqual(["Question", "Saved child"]);
		expect(() => chat.resolveParentMessages()).toThrow("original parent context");
		expect(existsSync(file)).toBe(false);
		const header = JSON.parse(original.split("\n")[0]);
		writeFileSync(
			file,
			`${JSON.stringify({ ...header, timestamp: "2000-01-01T00:00:00.000Z" })}\n${original.split("\n").slice(1).join("\n")}`,
		);
		expect(() => chat.resolveParentMessages()).toThrow("identity");
		writeFileSync(file, `${JSON.stringify(header)}\n`);
		expect(() => chat.resolveParentMessages()).toThrow("branch is missing");
		expect(store.list().total).toBe(1);
		expect(() => store.create("New question without valid original parent")).toThrow("branch is missing");
	});

	it("paginates twenty at a time by activity and isolates distinct parent files sharing a public ID", () => {
		vi.useFakeTimers();
		const parent = persistentParent();
		const store = new SideSessionStore({ sessionManager: parent }, directory);
		for (let index = 0; index < 23; index++) store.create(`Question ${index}`);
		const first = store.list();
		expect(first).toMatchObject({ total: 23, nextOffset: 20 });
		expect(first.items).toHaveLength(20);
		expect(store.list(20).items).toHaveLength(3);
		const old = store.open(store.list(20).items[2].id);
		vi.advanceTimersByTime(1000);
		old.sessionManager.appendMessage({ role: "user", content: "Latest activity", timestamp: Date.now() });
		expect(store.list().items[0].id).toBe(old.id);
		const other = SessionManager.create(directory, join(directory, "other"), { id: parent.getSessionId() });
		expect(new SideSessionStore({ sessionManager: other }, directory).list().total).toBe(0);
	});

	it("lists healthy chats with explicit warnings for incomplete or corrupt neighboring histories", () => {
		const parent = persistentParent();
		const store = new SideSessionStore({ sessionManager: parent }, directory);
		const healthy = store.create("Healthy chat");
		const brokenIds: string[] = [];
		for (const state of ["directory-only", "header-only", "corrupt"] as const) {
			const id = randomUUID();
			brokenIds.push(id);
			const childDirectory = join(dirname(dirname(healthy.historyPath!)), id);
			mkdirSync(childDirectory);
			if (state === "directory-only") continue;
			const content =
				state === "header-only"
					? `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: directory })}\n`
					: "{\n";
			writeFileSync(join(childDirectory, "session.jsonl"), content);
		}
		const page = new SideSessionStore({ sessionManager: parent }, directory).list();
		expect(page.items.map((item) => item.id)).toEqual([healthy.id]);
		expect(page.total).toBe(1);
		expect(page.errors).toHaveLength(3);
		for (const id of brokenIds) expect(page.errors).toContainEqual(expect.stringContaining(id));
	});

	it("keeps --no-session children and seeds in memory, scoped to the parent instance", () => {
		const parent = SessionManager.inMemory(directory);
		parent.appendMessage({ role: "user", content: "Ephemeral seed", timestamp: Date.now() });
		const store = new SideSessionStore({ sessionManager: parent }, directory);
		const chat = store.create("Ephemeral child");
		chat.sessionManager.appendMessage({ role: "user", content: "Child", timestamp: Date.now() });
		expect(chat.historyPath).toBeUndefined();
		expect(existsSync(join(directory, "btw"))).toBe(false);
		expect(chat.resolveParentMessages().map(getMessageText)).toEqual(["Ephemeral seed"]);
		expect(new SideSessionStore({ sessionManager: parent }, directory).open(chat.id)).toBe(chat);
		expect(new SideSessionStore({ sessionManager: SessionManager.inMemory(directory) }, directory).list().total).toBe(
			0,
		);
	});

	it("surfaces persistence failures and rejects unknown or path-traversal chat IDs", () => {
		const parent = persistentParent();
		const blocker = join(directory, "not-a-directory");
		writeFileSync(blocker, "blocked");
		const store = new SideSessionStore({ sessionManager: parent }, blocker);
		expect(() => store.create("Question")).toThrow();
		expect(() => store.open("../../escape")).toThrow("Unknown /btw chat");
	});
});
