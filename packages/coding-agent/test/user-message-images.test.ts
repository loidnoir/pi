import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	collapseUserMessageImages,
	getUserMessageImageReferences,
} from "../src/modes/interactive/components/user-message-images.ts";

describe("user message image references", () => {
	let capabilities: ReturnType<typeof getCapabilities>;
	beforeEach(() => {
		capabilities = getCapabilities();
		setCapabilities({ images: null, hyperlinks: true, trueColor: true });
	});
	afterEach(() => setCapabilities(capabilities));

	test("preserves exact ranges, whitespace, prose, and duplicate references across CRLF", () => {
		const raw = "/Users/sam/Library/Application\\ Support/CleanShot/a\\ b.png";
		const source = `before ${raw} and\r\nafter ${raw}, done`;
		const references = getUserMessageImageReferences(source);
		expect(references).toHaveLength(2);
		expect(references.map((reference) => source.slice(reference.start, reference.end))).toEqual([raw, raw]);
		expect(references.map((reference) => reference.path)).toEqual([
			"/Users/sam/Library/Application Support/CleanShot/a b.png",
			"/Users/sam/Library/Application Support/CleanShot/a b.png",
		]);
		const collapsed = collapseUserMessageImages(source, references, 3);
		expect(collapsed).toContain("before `");
		expect(collapsed).toContain("[image #3 a b.png]");
		expect(collapsed).toContain(" and\r\nafter `");
		expect(collapsed).toContain("[image #4 a b.png]");
		expect(collapsed).toMatch(/`, done$/);
	});

	test("recognizes unescaped clipboard paths on their own lines, but does not guess their boundaries in prose", () => {
		const source =
			"/Users/sam/Application Support/CleanShot/a b's.png\n/Users/sam/Application Support/CleanShot/c d.png";
		expect(getUserMessageImageReferences(source).map((reference) => reference.path)).toEqual(source.split("\n"));
		expect(getUserMessageImageReferences("inspect /tmp/a b.png please")).toEqual([]);
	});

	test("uses valid file URIs for quoted, escaped, and encoded filenames", () => {
		const source = `'/tmp/a #b%.png' /tmp/c\\ d\\#.jpg FILE:///tmp/e%20f%23%25.webp`;
		const references = getUserMessageImageReferences(source);
		expect(references.map((reference) => reference.url)).toEqual([
			pathToFileURL("/tmp/a #b%.png").href,
			pathToFileURL("/tmp/c d#.jpg").href,
			pathToFileURL("/tmp/e f#%.webp").href,
		]);
	});

	test("resolves only relative link targets against the supplied cwd without changing path spelling or source ranges", () => {
		const cwd = resolve(process.cwd(), "../session-image-cwd");
		const source = "'./image name.png' ../photo.jpg /tmp/absolute.png file:///tmp/file.png";
		const references = getUserMessageImageReferences(source, cwd);
		expect(cwd).not.toBe(process.cwd());
		expect(references.map((reference) => reference.url)).toEqual([
			pathToFileURL(resolve(cwd, "image name.png")).href,
			pathToFileURL(resolve(cwd, "../photo.jpg")).href,
			pathToFileURL("/tmp/absolute.png").href,
			pathToFileURL("/tmp/file.png").href,
		]);
		expect(references.map((reference) => reference.path)).toEqual([
			"./image name.png",
			"../photo.jpg",
			"/tmp/absolute.png",
			"/tmp/file.png",
		]);
		expect(references.map((reference) => source.slice(reference.start, reference.end))).toEqual([
			"'./image name.png'",
			"../photo.jpg",
			"/tmp/absolute.png",
			"file:///tmp/file.png",
		]);
		expect(getUserMessageImageReferences("./default.png")[0]?.url).toBe(pathToFileURL(resolve("default.png")).href);
	});

	test("keeps Windows drive and UNC file URIs correct without treating backslashes as shell escapes", () => {
		const source = String.raw`'C:\Users\sam\a b#.png' \\server\share\image.jpg`;
		expect(
			getUserMessageImageReferences(source, resolve(process.cwd(), "../session-image-cwd")).map(
				(reference) => reference.url,
			),
		).toEqual(["file:///C:/Users/sam/a%20b%23.png", "file://server/share/image.jpg"]);
	});

	test("ignores code, links, HTML, non-images, URLs, and malformed file URIs", () => {
		const source = [
			"`/tmp/inline.png` ``/tmp/back`tick.png``",
			"```\n/tmp/code.png\n```",
			"~~~\n/tmp/tilde.png\n~~~",
			"    /tmp/indented.png",
			"- ```\n  /tmp/nested.png\n  ```",
			"> ```\n> /tmp/quote.png\n> ```",
			"[local](/tmp/link.png) ![alt](/tmp/image.png)",
			"[ref]: /tmp/definition.png",
			"https://example.test/a.png <https://example.test/b.png>",
			"<!-- /tmp/comment.png -->",
			"/tmp/readme.md /tmp/picture.svg src/icon.png @/tmp/reference.png",
			"file:///tmp/bad%xx.png /tmp/escape\x1b.png",
		].join("\n\n");
		expect(getUserMessageImageReferences(source)).toEqual([]);
	});

	test("handles formatted prose and simple lists without changing their Markdown syntax", () => {
		const source = "**look /tmp/one.png**\n\n- /tmp/two.jpg\n- `/tmp/code.png`\n\n> /tmp/three.gif";
		const references = getUserMessageImageReferences(source);
		expect(references.map((reference) => reference.path)).toEqual(["/tmp/one.png", "/tmp/two.jpg", "/tmp/three.gif"]);
		const collapsed = collapseUserMessageImages(source, references, 1);
		expect(collapsed.startsWith("**look ")).toBe(true);
		expect(collapsed).toContain("`/tmp/code.png`");
	});

	test("keeps labels compact when hyperlinks are unavailable and recognizes missing files without IO", () => {
		setCapabilities({ images: null, hyperlinks: false, trueColor: true });
		const source = "/nonexistent/pi-clipboard-1234-abcd.png ./日本語.bmp ../photo.JPEG";
		const references = getUserMessageImageReferences(source);
		expect(references).toHaveLength(3);
		expect(collapseUserMessageImages(source, references, 1)).toBe(
			"`[image #1 clipboard]` `[image #2 日本語.bmp]` `[image #3 photo.JPEG]`",
		);
	});
});
