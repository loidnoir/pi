import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import {
	Container,
	Image,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	type TuiMouseEvent,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { ThemedText } from "./themed-text.ts";
import {
	collapseUserMessageImages,
	getUserMessageImageReferences,
	type UserMessageImageReference,
} from "./user-message-images.ts";

interface UserMessageOptions {
	cwd?: string;
	showImages?: boolean;
	imageWidthCells?: number;
}

type MessageBlock =
	| { kind: "text"; text: string; references: UserMessageImageReference[]; firstImageNumber: number }
	| { kind: "image"; image: ImageContent; number: number };

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private readonly blocks: MessageBlock[] = [];
	private readonly cwd: string;
	private imageCount = 0;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private renderedPad: number;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageId?: string;
	private timestamp?: string;

	constructor(
		content: UserMessage["content"],
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
		options: UserMessageOptions = {},
	) {
		super();
		this.cwd = options.cwd ?? process.cwd();
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.renderedPad = outputPad;
		let text = "";
		const flushText = () => {
			if (!text) return;
			const references = getUserMessageImageReferences(text, this.cwd);
			this.blocks.push({ kind: "text", text, references, firstImageNumber: this.imageCount + 1 });
			this.imageCount += references.length;
			text = "";
		};
		if (typeof content === "string") text = content;
		else {
			for (const block of content) {
				if (block.type === "text") text += block.text;
				else {
					flushText();
					this.blocks.push({ kind: "image", image: block, number: ++this.imageCount });
				}
			}
		}
		flushText();
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.renderedPad = padding;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	setShowImages(showImages: boolean): void {
		this.showImages = showImages;
		this.rebuild();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = width;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const transform = createMarkdownTransform(
			"user",
			() => false,
			this.markdownTransformers,
			this.messageId,
			this.timestamp,
		);
		for (const block of this.blocks) {
			if (block.kind === "image") {
				this.addChild(this.label(() => theme.fg("userMessageText", `[image #${block.number}]`)));
				if (this.expanded && this.showImages) {
					this.addChild(
						new Image(
							block.image.data,
							block.image.mimeType,
							{ fallbackColor: (text) => theme.fg("muted", text) },
							{ maxWidthCells: this.imageWidthCells },
						),
					);
				}
				continue;
			}
			let source = block.text;
			let references = block.references;
			this.addChild(
				new Markdown(
					block.text,
					this.renderedPad,
					0,
					this.markdownTheme,
					{
						color: (content) => theme.fg("userMessageText", content),
						bgColor: (content) => theme.bg("userMessageBg", content),
					},
					{
						preserveOrderedListMarkers: true,
						preserveBackslashEscapes: true,
						transform: (markdown, width) => {
							const transformed = transform(markdown, width);
							if (this.expanded) return transformed;
							if (source !== transformed) {
								source = transformed;
								references = getUserMessageImageReferences(source, this.cwd);
							}
							return collapseUserMessageImages(source, references, block.firstImageNumber);
						},
					},
				),
			);
		}
		if (this.imageCount > 0) {
			this.addChild(
				new MouseRegion(
					this.label(() =>
						theme.fg(
							"dim",
							`${this.imageCount} image${this.imageCount === 1 ? "" : "s"} · ${keyHint("app.tools.expand", this.expanded ? "collapse images" : "expand images")}`,
						),
					),
					(event) => {
						if (event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl)
							return;
						this.setExpanded(!this.expanded);
						return { handled: true, render: true };
					},
				),
			);
		}
	}

	private label(build: () => string): ThemedText {
		const label = new ThemedText(build, this.renderedPad, 0);
		label.setCustomBgFn((content) => theme.bg("userMessageBg", content));
		return label;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		return super.handleMouse({ ...event, y: event.y - 1, height: event.height - 2 });
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const padding = Math.min(this.outputPad, Math.max(0, Math.floor((width - 1) / 2)));
		if (padding !== this.renderedPad) {
			this.renderedPad = padding;
			this.rebuild();
		}
		const content = this.children.flatMap((child) => {
			const lines = child.render(width);
			// A wide glyph cannot fit a one-column content area. Normal wrapped rows and image payloads need no scan.
			return child instanceof Image || width - padding * 2 >= 2
				? lines
				: lines.map((line) => truncateToWidth(line, width));
		});
		if (content.length === 0) return content;
		const blank = theme.bg("userMessageBg", " ".repeat(width));
		const lines = [blank, ...content, blank];

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
