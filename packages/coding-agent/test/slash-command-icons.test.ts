import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	SelectList,
	type SlashCommand,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { type IconName, type IconPreset, icon, setIconPreset } from "../src/modes/interactive/icons.ts";
import { withSlashCommandIcons } from "../src/modes/interactive/slash-command-icons.ts";

const builtinIcons: Record<string, IconName> = {
	settings: "settings",
	model: "model",
	tree: "tree",
	thinking: "thinking",
	effort: "thinking",
	"scoped-models": "model",
	export: "export",
	import: "import",
	share: "share",
	bug: "bug",
	copy: "copy",
	name: "edit",
	session: "info",
	changelog: "history",
	hotkeys: "keyboard",
	fork: "fork",
	clone: "copy",
	trust: "trust",
	login: "login",
	logout: "logout",
	new: "write",
	compact: "compact",
	resume: "history",
	reload: "reload",
	quit: "quit",
};
const extensionIcons = new Map<string, IconName>([
	["jobs", "job"],
	["agents", "agent"],
	["btw", "chat"],
	["fast", "fast"],
	["llama", "model"],
	["mcp", "tool"],
	["pause", "pause"],
	["jobs:2", "job"],
	["deploy", "extension"],
	["review:1", "extension"],
	["review:2", "extension"],
	["tools:review:2", "extension"],
	["constructor", "extension"],
	["toString", "extension"],
]);
const sources = {
	builtin: [...BUILTIN_SLASH_COMMANDS],
	prompt: [
		{ name: "summarize", description: "[u] Summarize changes", argumentHint: "<topic>" },
		{ name: "project:review", description: "[p] Review changes" },
	],
	skill: [
		{ name: "skill:testing", description: "[u] Test changes" },
		{ name: "skill:code-review", description: "[p] Review code" },
	],
};
const argumentItems: AutocompleteItem[] = [
	{ value: "jobs", label: "Job environment", description: "Custom argument label" },
	{ value: "/server", label: "Remote server" },
];
const extensionCommands: SlashCommand[] = [...extensionIcons.keys()].map((name) => ({
	name,
	description: `Extension ${name}`,
	...(name === "deploy" && {
		getArgumentCompletions: (prefix: string) => argumentItems.filter((item) => item.value.startsWith(prefix)),
	}),
}));
const commands = [...sources.builtin, ...sources.prompt, ...extensionCommands, ...sources.skill];
const signal = new AbortController().signal;
const selectTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

let directory: string;

function createProviders() {
	const base = new CombinedAutocompleteProvider(commands, directory);
	return { base, decorated: withSlashCommandIcons(base, sources) };
}

function suggestions(provider: AutocompleteProvider, text: string, force = false) {
	return provider.getSuggestions([text], 0, text.length, { signal, force });
}

describe("slash-command icons", () => {
	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-slash-icons-"));
		mkdirSync(join(directory, "commands"));
		writeFileSync(join(directory, "commands", "example.txt"), "example");
		writeFileSync(join(directory, "file.txt"), "example");
	});
	afterEach(() => setIconPreset("unicode"));
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	test.each<IconPreset>(["unicode", "nerd"])(
		"decorates every command source with two spaces in %s",
		async (preset) => {
			setIconPreset(preset);
			const { base, decorated } = createProviders();
			const original = await suggestions(base, "/");
			const result = await suggestions(decorated, "/");
			expect(result?.prefix).toBe(original?.prefix);
			expect(result?.items.map((item) => item.value)).toEqual(commands.map((command) => command.name));
			expect(Object.keys(builtinIcons)).toEqual(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
			for (const [index, item] of result!.items.entries()) {
				const raw = original!.items[index]!;
				const expected = sources.skill.some((command) => command.name === item.value)
					? "skill"
					: sources.prompt.some((command) => command.name === item.value)
						? "prompt"
						: Object.hasOwn(builtinIcons, item.value)
							? builtinIcons[item.value]!
							: extensionIcons.get(item.value)!;
				expect(item.label).toBe(`${icon(expected)}  ${raw.label}`);
				expect(item.value).toBe(raw.value);
				expect(item.description).toBe(raw.description);
				expect(decorated.applyCompletion(["/"], 0, 1, item, "/")).toEqual({
					lines: [`/${raw.value} `],
					cursorLine: 0,
					cursorCol: raw.value.length + 2,
				});
			}
		},
	);

	test.each(["/rc", "/test", "/skill:testing", "/project:rev", "/review:2", "  /jobs", "/zzzzmissing"])(
		"preserves fuzzy matching, names, ordering and insertion for %s",
		async (text) => {
			const { base, decorated } = createProviders();
			const original = await suggestions(base, text);
			const result = await suggestions(decorated, text);
			expect(result?.items.map((item) => item.value)).toEqual(original?.items.map((item) => item.value));
			expect(result?.prefix).toBe(original?.prefix);
			for (const [index, item] of (result?.items ?? []).entries()) {
				expect(decorated.applyCompletion([text], 0, text.length, item, result!.prefix)).toEqual(
					base.applyCompletion([text], 0, text.length, original!.items[index]!, original!.prefix),
				);
			}
			if (text === "/test") expect(result?.items[0]?.value).toBe("skill:testing");
			if (text === "/zzzzmissing") expect(result).toBeNull();
		},
	);

	test.each(["/deploy ", "/deploy jo", "/deploy /ser"])(
		"leaves argument completions untouched for %s",
		async (text) => {
			const { base, decorated } = createProviders();
			const original = await suggestions(base, text);
			const result = await suggestions(decorated, text);
			expect(result).toEqual(original);
			expect(result?.items.length).toBeGreaterThan(0);
			for (const item of result!.items) expect(argumentItems).toContain(item);
		},
	);

	test.each([
		{ text: "./co", force: false },
		{ text: "see ./fi", force: false },
		{ text: "/export ./fi", force: true },
		{ text: "./commands/", force: false },
		{ text: "", force: true },
	])("leaves path completion unchanged for $text (force=$force)", async ({ text, force }) => {
		const { base, decorated } = createProviders();
		const original = await suggestions(base, text, force);
		const result = await suggestions(decorated, text, force);
		expect(result).toEqual(original);
		expect(result?.items.length).toBeGreaterThan(0);
		for (const item of result!.items) {
			expect(decorated.applyCompletion([text], 0, text.length, item, result!.prefix)).toEqual(
				base.applyCompletion([text], 0, text.length, item, original!.prefix),
			);
		}
		expect(decorated.shouldTriggerFileCompletion?.([text], 0, text.length)).toBe(
			base.shouldTriggerFileCompletion([text], 0, text.length),
		);
	});

	test("does not decorate forced absolute paths or attachment suggestions", async () => {
		const { base, decorated } = createProviders();
		const text = `${directory}/fi`;
		expect(await suggestions(decorated, text, true)).toEqual(await suggestions(base, text, true));
		expect((await suggestions(decorated, text, true))?.items[0]?.label).toBe("file.txt");
		const attachment = { prefix: "@fi", items: [{ value: "@file.txt", label: "file.txt" }] };
		vi.spyOn(base, "getSuggestions").mockResolvedValueOnce(attachment);
		expect(await suggestions(decorated, "/deploy @fi")).toBe(attachment);
	});

	test("composes after extension providers and returns their original items to completion handlers", async () => {
		const { base } = createProviders();
		const customItem = { value: "custom:2", label: "custom:2", description: "Custom slash suggestion" };
		const applyCompletion = vi.fn(base.applyCompletion.bind(base));
		const extension: AutocompleteProvider = {
			triggerCharacters: ["#"],
			getSuggestions: async (lines, line, col, options) => {
				if (lines[line]?.slice(0, col) === "/custom") return { prefix: "/custom", items: [customItem] };
				if (lines[line]?.slice(0, col) === "#issue") {
					return { prefix: "#issue", items: [{ value: "#123", label: "Issue 123" }] };
				}
				return base.getSuggestions(lines, line, col, options);
			},
			applyCompletion,
			shouldTriggerFileCompletion: () => false,
		};
		const decorated = withSlashCommandIcons(extension, sources);
		expect(decorated.triggerCharacters).toEqual(["#"]);
		expect(decorated.shouldTriggerFileCompletion?.(["/custom"], 0, 7)).toBe(false);
		const custom = (await suggestions(decorated, "/custom"))!;
		expect(custom.items[0]?.label).toBe(`${icon("extension")}  custom:2`);
		expect(customItem.label).toBe("custom:2");
		decorated.applyCompletion(["/custom"], 0, 7, custom.items[0]!, custom.prefix);
		expect(applyCompletion).toHaveBeenCalledWith(["/custom"], 0, 7, customItem, "/custom");
		expect(applyCompletion.mock.calls[0]?.[3]).toBe(customItem);
		expect(await suggestions(decorated, "#issue")).toEqual(await suggestions(extension, "#issue"));
		expect((await suggestions(decorated, "/jobs"))?.items[0]?.label).toBe(`${icon("job")}  jobs`);
	});

	test("updates an existing picker on preset changes without changing its selection or values", async () => {
		const { decorated } = createProviders();
		const result = (await suggestions(decorated, "/"))!;
		const list = new SelectList(result.items, 5, selectTheme);
		const selectedIndex = result.items.findIndex((item) => item.value === "model");
		list.setSelectedIndex(selectedIndex);
		const selected = list.getSelectedItem();
		const unicode = list.render(100).join("\n");
		expect(unicode).toContain(`${icon("model")}  model`);
		setIconPreset("nerd");
		list.invalidate();
		const nerd = list.render(100).join("\n");
		expect(nerd).toContain(`${icon("model")}  model`);
		expect(nerd).not.toBe(unicode);
		expect(list.getSelectedItem()).toBe(selected);
		expect(selected?.value).toBe("model");
		for (const line of list.render(20)) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		setIconPreset("unicode");
		list.invalidate();
		expect(list.render(100).join("\n")).toBe(unicode);
	});
});
