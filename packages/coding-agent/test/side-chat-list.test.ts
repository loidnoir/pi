import { stripVTControlCharacters } from "node:util";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PaneControls } from "../src/core/panes/host.ts";
import { type SideChatListItem, SideChatListView } from "../src/core/panes/side-chat-list.ts";
import { iconPrefix, setIconPreset } from "../src/modes/interactive/icons.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => setIconPreset("unicode"));

function fixture(count: number) {
	const items: SideChatListItem[] = Array.from({ length: count }, (_, index) => ({
		id: `chat-${index}`,
		title: `Question ${index}`,
		updatedAt: count - index,
	}));
	const controls: PaneControls = {
		invalidate: vi.fn(),
		close: vi.fn(),
		minimize: vi.fn(async () => {}),
		setTitle: vi.fn(async () => {}),
	};
	const list = vi.fn((offset: number) => ({ items: items.slice(offset, offset + 20), total: items.length }));
	const open = vi.fn(async (_id: string) => {});
	const view = new SideChatListView(controls, { list, open });
	return { view, controls, items, list, open };
}

function text(view: SideChatListView): string {
	return view.render(100, 30).map(stripVTControlCharacters).join("\n");
}

describe("saved side chat list", () => {
	it("leaves the host as the sole title, separates the chat rows, and uses the configured text icon", () => {
		const { view } = fixture(2);
		for (const preset of ["nerd", "unicode"] as const) {
			setIconPreset(preset);
			const lines = view.render(100, 30).map(stripVTControlCharacters);
			const first = lines.findIndex((line) => line.includes("Question 0"));
			const last = lines.findIndex((line) => line.includes("Question 1"));
			expect(lines[0]).toBe("");
			expect(lines[first - 1]).toBe("");
			expect(lines[last + 1]).toBe("");
			expect(lines[first]).toBe(`${iconPrefix("text")}Question 0  chat-0`);
			expect(lines.join("\n")).not.toContain("btw chats");
			expect(lines[first]).not.toContain(">");
		}
	});

	it("opens no model and shows twenty chats per page, with explicit page boundaries", async () => {
		const { view, list, open } = fixture(41);
		expect(text(view)).toContain("Page 1/3");
		expect(text(view)).toContain("Question 19");
		expect(text(view)).not.toContain("Question 20");
		view.handleInput("\u001b[6~");
		expect(list).toHaveBeenLastCalledWith(20);
		expect(text(view)).toContain("Page 2/3");
		view.handleInput("\u001b[6~");
		view.handleInput("\u001b[6~");
		expect(list).toHaveBeenLastCalledWith(40);
		expect(text(view)).toContain("Question 40");
		view.handleInput("\r");
		await vi.waitFor(() => expect(open).toHaveBeenCalledWith("chat-40"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		view.handleInput("\u001b[5~");
		expect(list).toHaveBeenLastCalledWith(20);
	});

	it("keeps selection visible in small windows and respects configurable keys", async () => {
		setKeybindings(new KeybindingsManager({ "tui.select.down": "j", "tui.select.confirm": "x" }));
		const { view, open } = fixture(20);
		for (let index = 0; index < 19; index++) view.handleInput("j");
		const lines = view.render(40, 10);
		expect(lines.map(stripVTControlCharacters).join("\n")).toContain("Question 19");
		expect(lines.length).toBeLessThanOrEqual(10);
		view.handleInput("x");
		await vi.waitFor(() => expect(open).toHaveBeenCalledWith("chat-19"));
	});

	it("refreshes saved chats and clamps a removed last page", () => {
		const { view, items, list } = fixture(21);
		view.handleInput("\u001b[6~");
		items.splice(20);
		view.refresh();
		expect(list).toHaveBeenLastCalledWith(0);
		expect(text(view)).toContain("Page 1/1");
	});

	it("keeps healthy histories selectable and shows unreadable-chat warnings", async () => {
		const { controls, open } = fixture(0);
		const view = new SideChatListView(controls, {
			list: () => ({
				items: [{ id: "healthy", title: "Healthy history", updatedAt: 1 }],
				total: 1,
				errors: ["Interrupted chat creation"],
			}),
			open,
		});
		expect(text(view)).toContain("Skipped 1 unreadable chat: Interrupted chat creation");
		expect(text(view)).toContain("Healthy history");
		view.handleInput("\r");
		await vi.waitFor(() => expect(open).toHaveBeenCalledWith("healthy"));
		for (const line of view.render(40, 8)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	it("handles empty history, escaped titles, failures, close and minimize", async () => {
		const { view, controls, items, open } = fixture(0);
		expect(text(view)).toContain("No side chats yet");
		view.handleInput("\r");
		expect(open).not.toHaveBeenCalled();
		items.push({ id: "untrusted", title: "\u001b[31mRED\u001b[0m\nnext", updatedAt: 0 });
		view.refresh();
		for (const width of [1, 8, 40]) {
			for (const line of view.render(width, 8)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(text(view)).toContain("RED next");
		open.mockRejectedValueOnce(new Error("Cannot reopen saved context"));
		view.handleInput("\r");
		await vi.waitFor(() => expect(text(view)).toContain("Cannot reopen saved context"));
		view.handleInput("\u001bm");
		expect(controls.minimize).toHaveBeenCalledOnce();
		view.handleInput("\u001b");
		expect(controls.close).toHaveBeenCalledOnce();
	});
});
