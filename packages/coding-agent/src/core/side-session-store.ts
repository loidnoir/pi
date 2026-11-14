// Parent-scoped, child-only /btw histories with frozen references to the original parent branch.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { getAgentDir } from "../config.ts";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import {
	buildSessionProjection,
	type FileEntry,
	type ReadonlySessionManager,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "./session-manager.ts";

export interface SideSessionInfo {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	historyPath?: string;
}

export interface SideSessionPage {
	items: SideSessionInfo[];
	total: number;
	nextOffset?: number;
	errors?: string[];
}

const parentReferenceSchema = Type.Object({
	parentFile: Type.Union([Type.String(), Type.Null()]),
	parentSessionId: Type.String(),
	parentTimestamp: Type.String(),
	parentLeafId: Type.Union([Type.String(), Type.Null()]),
});
const parentReferenceValidator = Compile(parentReferenceSchema);
type ParentReference = Static<typeof parentReferenceSchema>;
const chatIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const memoryChats = new WeakMap<
	ReadonlySessionManager,
	{ parentId: string; timestamp: string; chats: Map<string, StoredSideSession> }
>();

/** A saved chat's own history and the resolver for its fixed inherited context. */
export class StoredSideSession implements SideSessionInfo {
	readonly id: string;
	readonly agentDir: string;
	readonly historyPath: string | undefined;
	private manager: SessionManager;
	private readonly reference: ParentReference;
	private readonly memorySeed?: AgentMessage[];

	constructor(
		manager: SessionManager,
		reference: ParentReference,
		agentDir: string,
		memorySeed?: AgentMessage[],
		historyPath = manager.getSessionFile(),
	) {
		this.id = manager.getSessionId();
		this.manager = manager;
		this.historyPath = historyPath;
		this.reference = reference;
		this.agentDir = agentDir;
		this.memorySeed = memorySeed;
	}

	get sessionManager(): SessionManager {
		return this.manager;
	}

	/** Refresh a writable child manager only after its runtime owns the file's execution lease. */
	openWriter(): void {
		if (!this.historyPath) return;
		const { header, incompleteTail } = readSession(this.historyPath);
		if (incompleteTail)
			throw new Error(
				"Cannot continue /btw: saved history has an incomplete final JSONL entry; history is still viewable",
			);
		const original = this.manager.getHeader()!;
		if (header.id !== original.id || header.timestamp !== original.timestamp)
			throw new Error("Cannot continue /btw: saved chat identity changed; reopen its history");
		this.manager = SessionManager.open(this.historyPath);
	}

	get title(): string {
		return this.sessionManager.getSessionName() ?? "Side conversation";
	}

	get createdAt(): number {
		return Date.parse(this.sessionManager.getHeader()!.timestamp);
	}

	get updatedAt(): number {
		return this.sessionManager
			.getEntries()
			.reduce((latest, entry) => Math.max(latest, Date.parse(entry.timestamp)), this.createdAt);
	}

	get ownMessages(): AgentMessage[] {
		return this.sessionManager.getEntries().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	}

	/** Read the exact original parent branch without repairing, migrating, or creating its file. */
	resolveParentMessages(): AgentMessage[] {
		if (!this.reference.parentFile) return this.memorySeed ?? [];
		return buildSessionProjection(readParent(this.reference.parentFile, this.reference), this.reference.parentLeafId)
			.messages;
	}
}

/** Create, reopen, and page side chats belonging to one parent session file (or one memory-only parent). */
export class SideSessionStore {
	private readonly parent: ReadonlySessionManager;
	private readonly agentDir: string;
	private readonly directory?: string;
	private readonly chats: Map<string, StoredSideSession>;

	constructor(ctx: { sessionManager: ReadonlySessionManager }, agentDir = getAgentDir()) {
		this.parent = ctx.sessionManager;
		this.agentDir = resolve(agentDir);
		const file = this.parent.getSessionFile();
		if (file) {
			this.directory = join(this.agentDir, "btw", createHash("sha256").update(resolve(file)).digest("hex"));
			this.chats = new Map();
		} else {
			const header = this.parent.getHeader()!;
			const saved = memoryChats.get(this.parent);
			this.chats = saved?.parentId === header.id && saved.timestamp === header.timestamp ? saved.chats : new Map();
			memoryChats.set(this.parent, { parentId: header.id, timestamp: header.timestamp, chats: this.chats });
		}
	}

	/** List twenty chats in latest-activity order without resolving their parents or altering their logs. */
	list(offset = 0): SideSessionPage {
		const ids =
			this.directory && existsSync(this.directory)
				? readdirSync(this.directory).filter((id) => chatIdPattern.test(id))
				: [...this.chats.keys()];
		const items: SideSessionInfo[] = [];
		const errors: string[] = [];
		for (const id of ids) {
			try {
				const chat = this.directory ? this.load(id) : this.chats.get(id)!;
				items.push({
					id: chat.id,
					title: chat.title,
					createdAt: chat.createdAt,
					updatedAt: chat.updatedAt,
					historyPath: chat.historyPath,
				});
			} catch (error) {
				errors.push(`Cannot load /btw chat ${id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		items.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
		return {
			items: items.slice(offset, offset + 20),
			total: items.length,
			...(errors.length ? { errors } : {}),
			...(offset + 20 < items.length ? { nextOffset: offset + 20 } : {}),
		};
	}

	/** Create a distinct saved history, deriving its title directly from the initial question. */
	create(question: string): StoredSideSession {
		if (!question.trim()) throw new Error("A new /btw chat requires a question");
		this.parent.ensurePersisted();
		const header = this.parent.getHeader();
		if (!header) throw new Error("Cannot open /btw without a parent session header");
		const parentFile = this.parent.getSessionFile();
		const reference: ParentReference = {
			parentFile: parentFile ? resolve(parentFile) : null,
			parentSessionId: header.id,
			parentTimestamp: header.timestamp,
			parentLeafId: this.parent.getLeafId(),
		};
		if (reference.parentFile) readParent(reference.parentFile, reference);
		const id = randomUUID();
		let manager: SessionManager;
		if (this.directory) {
			const directory = join(this.directory, id);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const childHeader: SessionHeader = {
				type: "session",
				version: 3,
				id,
				timestamp: new Date().toISOString(),
				cwd: this.parent.getCwd(),
				parentSession: reference.parentFile!,
			};
			const file = join(directory, "session.jsonl");
			writeFileSync(file, `${JSON.stringify(childHeader)}\n`, { flag: "wx", mode: 0o600 });
			manager = SessionManager.open(file);
		} else {
			manager = SessionManager.inMemory(this.parent.getCwd(), { id });
		}
		manager.appendCustomEntry("pi.btw", reference);
		const title = sanitizeBinaryOutput(stripAnsi(question)).replace(/\s+/gu, " ").trim().slice(0, 80);
		manager.appendSessionInfo(title);
		manager.appendMessage({ role: "user", content: question, timestamp: Date.now() });
		const chat = new StoredSideSession(
			manager,
			reference,
			this.agentDir,
			parentFile ? undefined : this.parent.buildSessionProjection().messages,
		);
		this.chats.set(id, chat);
		return chat;
	}

	/** Open saved own messages even when the original parent context is no longer available. */
	open(id: string): StoredSideSession {
		const chat = this.chats.get(id) ?? this.load(id);
		this.chats.set(id, chat);
		return chat;
	}

	private load(id: string): StoredSideSession {
		if (!chatIdPattern.test(id) || !this.directory) throw new Error(`Unknown /btw chat: ${id}`);
		const file = join(this.directory, id, "session.jsonl");
		const { header, entries } = readSession(file);
		const metadata = entries.find((entry) => entry.type === "custom" && entry.customType === "pi.btw");
		const reference = metadata?.type === "custom" ? metadata.data : undefined;
		// Metadata and path identity are untrusted persisted filesystem input.
		if (
			header.id !== id ||
			!parentReferenceValidator.Check(reference) ||
			reference.parentFile !== resolve(this.parent.getSessionFile()!)
		)
			throw new Error(`Invalid /btw chat metadata: ${id}`);
		return new StoredSideSession(
			SessionManager.inMemory(header.cwd, undefined, [header, ...entries]),
			reference,
			this.agentDir,
			undefined,
			file,
		);
	}
}

function readSession(file: string): { header: SessionHeader; entries: SessionEntry[]; incompleteTail: boolean } {
	const content = readFileSync(file, "utf8");
	const lines = content.split("\n");
	const parsed: FileEntry[] = [];
	let incompleteTail = false;
	for (let index = 0; index < lines.length; index++) {
		if (!lines[index].trim()) continue;
		try {
			// JSONL is a filesystem trust boundary, matching SessionManager's entry decoding.
			parsed.push(JSON.parse(lines[index]) as FileEntry);
		} catch {
			if (index === lines.length - 1 && !content.endsWith("\n")) {
				incompleteTail = true;
				break;
			}
			throw new Error(`Invalid session JSONL: ${file}`);
		}
	}
	const header = parsed[0];
	if (!header || header.type !== "session" || typeof header.id !== "string" || typeof header.timestamp !== "string")
		throw new Error(`Invalid session header: ${file}`);
	const entries = parsed.slice(1).filter((entry): entry is SessionEntry => entry.type !== "session");
	return { header, entries, incompleteTail };
}

function readParent(file: string, reference: ParentReference): SessionEntry[] {
	try {
		const { header, entries } = readSession(file);
		if (header.id !== reference.parentSessionId || header.timestamp !== reference.parentTimestamp)
			throw new Error("parent identity no longer matches");
		validateBranch(entries, reference.parentLeafId);
		return entries;
	} catch (error) {
		throw new Error(
			`Cannot continue /btw with its original parent context: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function validateBranch(entries: SessionEntry[], leafId: string | null): void {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const visited = new Set<string>();
	let current = leafId;
	while (current !== null) {
		const entry = byId.get(current);
		if (!entry || visited.has(current) || (entry.parentId !== null && typeof entry.parentId !== "string"))
			throw new Error(`original parent branch is missing or invalid at ${current}`);
		visited.add(current);
		current = entry.parentId;
	}
}
