// File-type glyphs for terminal path labels; never part of tool output or source content.
import { getIconPreset, glyphPrefix, icon } from "./icons.ts";

export type FilePathKind = "file" | "directory";

const FILE_ICONS = new Map(
	Object.entries({
		ts: "\ue628",
		mts: "\ue628",
		cts: "\ue628",
		tsx: "\ue7ba",
		js: "\ue74e",
		mjs: "\ue74e",
		cjs: "\ue74e",
		jsx: "\ue7ba",
		py: "\ue73c",
		pyi: "\ue73c",
		rs: "\ue7a8",
		go: "\ue724",
		md: "\ue73e",
		mdx: "\ue73e",
		markdown: "\ue73e",
		json: "\ue60b",
		jsonc: "\ue60b",
		json5: "\ue60b",
		yaml: "\ue6a8",
		yml: "\ue6a8",
		toml: "\ue6b2",
		c: "\ue61e",
		h: "\ue61e",
		cc: "\ue61d",
		cpp: "\ue61d",
		cxx: "\ue61d",
		hpp: "\ue61d",
		cs: "\u{f031b}",
		java: "\ue738",
		kt: "\ue634",
		kts: "\ue634",
		swift: "\ue755",
		rb: "\ue739",
		php: "\ue73d",
		lua: "\ue620",
		html: "\ue736",
		htm: "\ue736",
		css: "\ue749",
		scss: "\ue749",
		sass: "\ue749",
		vue: "\ue6a0",
		svelte: "\ue697",
		sql: "\ue706",
		pdf: "\uf1c1",
		png: "\uf1c5",
		jpg: "\uf1c5",
		jpeg: "\uf1c5",
		gif: "\uf1c5",
		webp: "\uf1c5",
		svg: "\uf1c5",
	}),
);

/** Return an uncolored file glyph, or no extra glyph with the Unicode preset or a URI. */
export function fileIcon(path: string, kind: FilePathKind = "file"): string {
	if (getIconPreset() !== "nerd" || /^[a-z][a-z\d+.-]*:\/\//i.test(path) || !path) return "";
	if (kind === "directory" || /[/\\]$/.test(path) || path === "." || path === "..") return icon("folder");
	const name = path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
	if (name === "dockerfile" || name.startsWith("dockerfile.")) return "\ue7b0";
	if (name === "makefile" || name === "gnumakefile") return "\ue615";
	if (name === ".gitignore" || name === ".gitattributes" || name === ".gitmodules") return "\ue702";
	if (name === ".env" || name.startsWith(".env.")) return "\ue615";
	const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
	if (["sh", "bash", "zsh", "fish", "ps1"].includes(extension) || /^\.(?:bash|zsh|profile)/.test(name))
		return icon("terminal");
	return FILE_ICONS.get(extension) ?? "\uf15c";
}

/** Prefix a presentation-only path with its current file glyph when enabled. */
export function fileIconPrefix(path: string, kind?: FilePathKind): string {
	return glyphPrefix(fileIcon(path, kind));
}
