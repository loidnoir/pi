import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { type IconName, iconPrefix } from "./icons.ts";

type CommandSource = "builtin" | "prompt" | "extension" | "skill";
type CommandSources = Record<Exclude<CommandSource, "extension">, readonly { name: string }[]>;

const BUILTIN_ICONS = new Map<string, IconName>([
	["settings", "settings"],
	["model", "model"],
	["tree", "tree"],
	["thinking", "thinking"],
	["effort", "thinking"],
	["scoped-models", "model"],
	["export", "export"],
	["import", "import"],
	["share", "share"],
	["bug", "bug"],
	["copy", "copy"],
	["name", "edit"],
	["session", "info"],
	["changelog", "history"],
	["hotkeys", "keyboard"],
	["fork", "fork"],
	["clone", "copy"],
	["trust", "trust"],
	["login", "login"],
	["logout", "logout"],
	["new", "write"],
	["compact", "compact"],
	["resume", "history"],
	["reload", "reload"],
	["quit", "quit"],
]);

const EXTENSION_ICONS = new Map<string, IconName>([
	["agents", "agent"],
	["btw", "chat"],
	["fast", "fast"],
	["jobs", "job"],
	["llama", "model"],
	["mcp", "tool"],
	["pause", "pause"],
	["tasks", "tasks"],
]);

/** Decorate slash-command labels without changing matching or completion behavior. */
export function withSlashCommandIcons(provider: AutocompleteProvider, sources: CommandSources): AutocompleteProvider {
	const commandIcons = new Map<string, IconName>();
	const originalItems = new WeakMap<AutocompleteItem, AutocompleteItem>();
	for (const source of ["builtin", "prompt", "skill"] as const) {
		for (const command of sources[source]) {
			// Preserve the built-in command's icon when a template has the same invocation name.
			if (!commandIcons.has(command.name)) {
				commandIcons.set(command.name, getCommandIcon(command.name, source));
			}
		}
	}

	return {
		triggerCharacters: provider.triggerCharacters,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, options);
			const commandPrefix = (lines[cursorLine] ?? "").slice(0, cursorCol).trimStart();
			if (
				!suggestions ||
				options.force ||
				!commandPrefix.startsWith("/") ||
				commandPrefix.includes(" ") ||
				suggestions.prefix !== commandPrefix
			) {
				return suggestions;
			}

			return {
				...suggestions,
				items: suggestions.items.map((item) => {
					const iconName = commandIcons.get(item.value) ?? getCommandIcon(item.value, "extension");
					const decorated = {
						...item,
						// The editor retains suggestions while the picker is open; resolve the preset at render time.
						get label() {
							return `${iconPrefix(iconName)}${item.label}`;
						},
					};
					originalItems.set(decorated, item);
					return decorated;
				}),
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return provider.applyCompletion(lines, cursorLine, cursorCol, originalItems.get(item) ?? item, prefix);
		},
		...(provider.shouldTriggerFileCompletion && {
			shouldTriggerFileCompletion: provider.shouldTriggerFileCompletion.bind(provider),
		}),
	};
}

function getCommandIcon(name: string, source: CommandSource): IconName {
	switch (source) {
		case "builtin":
			return BUILTIN_ICONS.get(name) ?? "terminal";
		case "prompt":
			return "prompt";
		case "extension":
			return EXTENSION_ICONS.get(name.replace(/:\d+$/, "")) ?? "extension";
		case "skill":
			return "skill";
	}
}
