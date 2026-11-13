import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import {
	Container,
	getCapabilities,
	getKeybindings,
	setCapabilities,
	setKeybindings,
	TuiAltScreen,
	TuiMainScreen,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getIconPreset, setIconPreset } from "../src/modes/interactive/icons.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";
const image: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
};

function plain(component: UserMessageComponent, width = 240): string {
	return stripAnsi(component.render(width).join("\n"));
}

function click(width: number, height: number, y: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("UserMessageComponent", () => {
	let capabilities: ReturnType<typeof getCapabilities>;
	let keybindings: ReturnType<typeof getKeybindings>;
	let iconPreset: ReturnType<typeof getIconPreset>;
	beforeEach(() => {
		initTheme("dark");
		capabilities = getCapabilities();
		keybindings = getKeybindings();
		iconPreset = getIconPreset();
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		setKeybindings(new KeybindingsManager());
	});
	afterEach(() => {
		setCapabilities(capabilities);
		setKeybindings(keybindings);
		setIconPreset(iconPreset);
	});

	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});

	test("collapses screenshot-style escaped image paths in place without altering text or transformer input", () => {
		const first =
			"/Users/sam/Library/Application\\ Support/CleanShot/media/one/CleanShot\\ 2026-11-13\\ at\\ 23.07.32@2x.png";
		const second =
			"/Users/sam/Library/Application\\ Support/CleanShot/media/two/CleanShot\\ 2026-11-13\\ at\\ 23.07.55@2x.png";
		const raw = `${first} let's fix those in ~/Developer/pi/\nand work on this ${second}`;
		const transformer = vi.fn((text: string) => text);
		const component = new UserMessageComponent(raw, undefined, 1, [transformer]);
		const collapsed = plain(component);
		expect(collapsed).toContain("[image #1 CleanShot 2026-11-13 ...]");
		expect(collapsed).toContain("[image #2 CleanShot 2026-11-13 ...]");
		expect(collapsed).toContain("let's fix those in ~/Developer/pi/");
		expect(collapsed).toContain("and work on this");
		expect(collapsed).not.toContain("/Users/sam/Library");
		expect(transformer.mock.calls[0]?.[0]).toBe(raw);
		expect(component.render(240).join("\n")).toContain(
			"file:///Users/sam/Library/Application%20Support/CleanShot/media/one/CleanShot%202026-11-13%20at%2023.07.32@2x.png",
		);
		component.setExpanded(true);
		const expanded = plain(component);
		expect(expanded).toContain(first);
		expect(expanded).toContain(second);
		component.setExpanded(false);
		expect(plain(component)).toBe(collapsed);
	});

	test("uses the component cwd for initial references and references changed by Markdown transformers", () => {
		const cwd = resolve(process.cwd(), "../session-image-cwd");
		const source = "inspect ./first.png";
		let filename = "first";
		const transform = vi.fn((markdown: string) => markdown.replace("first", filename));
		const component = new UserMessageComponent(source, undefined, 1, [transform], undefined, undefined, { cwd });
		expect(component.render(100).join("\n")).toContain(pathToFileURL(resolve(cwd, "first.png")).href);
		filename = "second";
		component.invalidate();
		expect(component.render(100).join("\n")).toContain(pathToFileURL(resolve(cwd, "second.png")).href);
		expect(transform.mock.calls.map((call) => call[0])).toEqual([source, source]);
		expect(new UserMessageComponent(source).render(100).join("\n")).toContain(
			pathToFileURL(resolve("first.png")).href,
		);
	});

	test("leaves code, links, non-image files, and unrelated URLs unchanged", () => {
		const raw = [
			"`/tmp/inline.png`",
			"```sh\n/tmp/fenced.png\n```",
			"    /tmp/indented.png",
			"https://example.test/image.png [site](https://example.test/other.png)",
			"[local](file:///tmp/link.png) ![alt](/tmp/markdown.png)",
			"/tmp/document.pdf /tmp/source.ts ordinary/image.png",
		].join("\n\n");
		const component = new UserMessageComponent(raw);
		expect(plain(component)).not.toContain("[image #");
		expect(plain(component)).not.toContain("expand images");
		const before = component.render(240);
		component.setExpanded(true);
		expect(component.render(240)).toEqual(before);
	});

	test("keeps attachment payloads and block order unchanged while expanding only on request", () => {
		const content: UserMessage["content"] = [
			{ type: "text", text: "before /tmp/first.png" },
			image,
			{ type: "text", text: "after /tmp/last.png" },
		];
		const original = JSON.stringify(content);
		const component = new UserMessageComponent(content);
		const collapsed = plain(component);
		expect(collapsed.indexOf("[image #1 first.png]")).toBeLessThan(collapsed.indexOf("[image #2]"));
		expect(collapsed.indexOf("[image #2]")).toBeLessThan(collapsed.indexOf("[image #3 last.png]"));
		expect(collapsed).not.toContain("image/png");
		component.setExpanded(true);
		expect(plain(component)).toContain("[Image: [image/png] 1x1]");
		expect(JSON.stringify(content)).toBe(original);
	});

	test("honors image visibility, terminal capabilities, and image width when explicitly expanded", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const component = new UserMessageComponent([image], undefined, 1, [], undefined, undefined, {
			showImages: false,
		});
		component.setExpanded(true);
		expect(component.render(80).join("\n")).not.toContain("\x1b_G");
		component.setShowImages(true);
		component.setImageWidthCells(8);
		expect(component.render(80).join("\n")).toContain("c=8");
		component.setExpanded(false);
		expect(component.render(80).join("\n")).not.toContain("\x1b_G");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		component.invalidate();
		component.setExpanded(true);
		expect(plain(component)).toContain("image/png");
		expect(component.render(80).join("\n")).not.toContain("\x1b_G");
	});

	test("offers keyboard expansion through the configured chat action and mouse expansion without stealing focus", async () => {
		const bindings = new KeybindingsManager({ "app.tools.expand": "ctrl+e" });
		setKeybindings(bindings);
		const terminal = new VirtualTerminal(100, 24);
		const tui = new TuiMainScreen(terminal);
		const component = new UserMessageComponent("inspect /tmp/image.png");
		const editor = new CustomEditor(tui, getEditorTheme(), bindings);
		let expanded = false;
		editor.onAction("app.tools.expand", () => {
			expanded = !expanded;
			component.setExpanded(expanded);
			tui.requestRender();
		});
		tui.addChild(component);
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			expect(plain(component)).toContain("ctrl+e expand images");
			terminal.sendInput("\x05");
			await terminal.waitForRender();
			expect(plain(component)).toContain("inspect /tmp/image.png");
			const lines = component.render(100);
			const hint = lines.findIndex((line) => stripAnsi(line).includes("collapse images"));
			expect(component.handleMouse(click(100, lines.length, hint))).toMatchObject({ handled: true, render: true });
			expect(plain(component)).toContain("[image #1 image.png]");
			expect(component.handleMouse(click(100, lines.length, 1))).toBeUndefined();
			expect(component.handleMouse({ ...click(100, lines.length, hint), type: "drag" })).toBeUndefined();
		} finally {
			tui.stop();
		}
	});

	test("routes fullscreen link clicks and expansion through normalized mouse input without changing editor focus", async () => {
		const terminal = new VirtualTerminal(100, 24);
		const openUrl = vi.fn();
		const copySelection = vi.fn<(text: string) => Promise<true>>().mockResolvedValue(true);
		const tui = new TuiAltScreen(terminal, false, undefined, { openUrl, copySelection });
		const component = new UserMessageComponent("inspect /tmp/a\\ b.png");
		const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
		tui.addChild(component);
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const imageRow = terminal.getViewport().findIndex((line) => line.includes("[image #1")) + 1;
			terminal.sendInput(`\x1b[<0;12;${imageRow}M`);
			terminal.sendInput(`\x1b[<0;12;${imageRow}m`);
			await terminal.waitForRender();
			expect(openUrl).toHaveBeenCalledWith("file:///tmp/a%20b.png");
			const hintRow = terminal.getViewport().findIndex((line) => line.includes("expand images")) + 1;
			terminal.sendInput(`\x1b[<0;3;${hintRow}M`);
			terminal.sendInput(`\x1b[<0;3;${hintRow}m`);
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("inspect /tmp/a\\ b.png");
			expect(tui.getFocusedComponent()).toBe(editor);
			copySelection.mockClear();
			const sourceRow = terminal.getViewport().findIndex((line) => line.includes("inspect /tmp/a")) + 1;
			terminal.sendInput(`\x1b[<0;2;${sourceRow}M`);
			terminal.sendInput(`\x1b[<32;100;${sourceRow}M`);
			terminal.sendInput(`\x1b[<0;100;${sourceRow}m`);
			await vi.waitFor(() => expect(copySelection).toHaveBeenCalled());
			expect(copySelection.mock.calls[0]?.[0]).toContain("inspect /tmp/a\\ b.png");
		} finally {
			tui.stop();
		}
	});

	test.each([0, 1, 2, 3, 8, 20, 80])("fits width %s with CJK labels, padding changes, and invalidation", (width) => {
		const component = new UserMessageComponent("見て /tmp/日本語の画像.png 続き");
		for (const expanded of [false, true, false]) {
			component.setExpanded(expanded);
			component.setOutputPad(3);
			component.invalidate();
			const lines = component.render(width);
			if (width === 0) expect(lines).toEqual([]);
			else expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	test("rebuilds themed labels and keeps icon preset changes from changing source text", () => {
		const component = new UserMessageComponent("/tmp/日本語.png");
		const dark = component.render(80).join("\n");
		initTheme("light");
		setIconPreset("nerd");
		component.invalidate();
		const light = component.render(80).join("\n");
		expect(light).not.toBe(dark);
		expect(stripAnsi(light)).toBe(stripAnsi(dark));
	});

	test("wires image-only messages, history source, and initial chat expansion without mutating a message", () => {
		const chatContainer = new Container();
		const cwd = resolve(process.cwd(), "../session-image-cwd");
		const context = {
			chatContainer,
			sessionManager: { getCwd: () => cwd },
			getUserMessageText: (message: UserMessage) =>
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join(""),
			getMarkdownThemeWithSettings: getMarkdownTheme,
			getMarkdownTransformers: () => [],
			outputPad: 1,
			toolOutputExpanded: true,
			settingsManager: { getShowImages: () => false, getImageWidthCells: () => 8 },
			editor: { addToHistory: vi.fn() },
		};
		const addMessage = (
			InteractiveMode.prototype as unknown as {
				addMessageToChat(this: typeof context, message: UserMessage, options?: { populateHistory?: boolean }): void;
			}
		).addMessageToChat;
		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "inspect /tmp/image.png" }, image],
			timestamp: 1,
		};
		const original = JSON.stringify(message);
		addMessage.call(context, message, { populateHistory: true });
		expect(stripAnsi(chatContainer.render(100).join("\n"))).toContain("inspect /tmp/image.png");
		expect(context.editor.addToHistory).toHaveBeenCalledWith("inspect /tmp/image.png");
		expect(JSON.stringify(message)).toBe(original);
		chatContainer.clear();
		addMessage.call(context, { role: "user", content: [image], timestamp: 2 });
		expect(stripAnsi(chatContainer.render(100).join("\n"))).toContain("[image #1]");
		chatContainer.clear();
		context.toolOutputExpanded = false;
		const skillMessage: UserMessage = {
			role: "user",
			content: [
				image,
				{
					type: "text",
					text: '<skill name="test" location="/tmp/test.md">\nbody\n</skill>\n\nafter /tmp/last.png',
				},
				image,
			],
			timestamp: 3,
		};
		const skillSource = JSON.stringify(skillMessage);
		addMessage.call(context, skillMessage);
		const skillDisplay = stripAnsi(chatContainer.render(100).join("\n"));
		expect(skillDisplay.indexOf("[image #1]")).toBeLessThan(skillDisplay.indexOf("after [image #2 last.png]"));
		expect(skillDisplay.indexOf("after [image #2 last.png]")).toBeLessThan(skillDisplay.indexOf("[image #3]"));
		expect(JSON.stringify(skillMessage)).toBe(skillSource);
		chatContainer.clear();
		addMessage.call(context, { role: "user", content: "inspect ./image.png", timestamp: 4 });
		expect(chatContainer.render(100).join("\n")).toContain(pathToFileURL(resolve(cwd, "image.png")).href);
	});

	test("passes persisted entry identity in transformer context; live leaves it undefined", () => {
		initTheme("dark");
		const captured: Array<{ messageId?: string; timestamp?: string }> = [];
		const capture = (_markdown: string, context: { messageId?: string; timestamp?: string }) => {
			captured.push({ messageId: context.messageId, timestamp: context.timestamp });
			return _markdown;
		};

		new UserMessageComponent("restored", undefined, 1, [capture], "entry-abc", "2025-01-15T10:30:00.000Z").render(80);
		new UserMessageComponent("live", undefined, 1, [capture]).render(80);

		expect(captured).toEqual([
			{ messageId: "entry-abc", timestamp: "2025-01-15T10:30:00.000Z" },
			{ messageId: undefined, timestamp: undefined },
		]);
	});
});
