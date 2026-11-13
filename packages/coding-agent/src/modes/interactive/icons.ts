export type IconPreset = "unicode" | "nerd";
export type IconName =
	| "code"
	| "quote"
	| "copy"
	| "chat"
	| "question"
	| "radioChecked"
	| "radioUnchecked"
	| "checkboxChecked"
	| "checkboxUnchecked"
	| "submit"
	| "agent"
	| "agentWorker"
	| "agentScout"
	| "agentReviewer"
	| "agentPlanner"
	| "thinking"
	| "clock"
	| "location"
	| "sparkles"
	| "read"
	| "write"
	| "edit"
	| "search"
	| "folder"
	| "terminal"
	| "skill"
	| "job"
	| "tool"
	| "settings"
	| "model"
	| "tree"
	| "export"
	| "import"
	| "share"
	| "bug"
	| "info"
	| "history"
	| "keyboard"
	| "fork"
	| "trust"
	| "login"
	| "logout"
	| "compact"
	| "reload"
	| "quit"
	| "fast"
	| "pause"
	| "extension"
	| "prompt"
	| "statusDot";

const ICONS: Record<IconPreset, Record<IconName, string>> = {
	unicode: {
		code: "</>",
		quote: "❯",
		copy: "⧉",
		chat: "?",
		question: "?",
		radioChecked: "(●)",
		radioUnchecked: "( )",
		checkboxChecked: "[x]",
		checkboxUnchecked: "[ ]",
		submit: "↵",
		agent: "@",
		agentWorker: "</>",
		agentScout: "?",
		agentReviewer: "✓",
		agentPlanner: "≡",
		thinking: "◇",
		clock: "◷",
		location: "⌖",
		sparkles: "✧",
		read: "◉",
		write: "+",
		edit: "✎",
		search: "⌕",
		folder: "/",
		terminal: ">_",
		skill: "✦",
		job: "⚙",
		tool: "⚒",
		settings: "⚙",
		model: "◈",
		tree: "⑂",
		export: "↗",
		import: "↙",
		share: "↗",
		bug: "!",
		info: "ⓘ",
		history: "↶",
		keyboard: "⌨",
		fork: "⑂",
		trust: "✓",
		login: "↪",
		logout: "↩",
		compact: "⇥",
		reload: "↻",
		quit: "×",
		fast: "ϟ",
		pause: "Ⅱ",
		extension: "⊞",
		prompt: "≡",
		statusDot: "\u2022",
	},
	nerd: {
		code: "\uf44f",
		quote: "\uf10e",
		copy: "\u{f09a8}",
		chat: "\uf075",
		question: "\uf059",
		radioChecked: "\uf192",
		radioUnchecked: "\uf10c",
		checkboxChecked: "\uf14a",
		checkboxUnchecked: "\uf096",
		submit: "\uf1d8",
		agent: "\uf007",
		agentWorker: "\uf0ad",
		agentScout: "\uf002",
		agentReviewer: "\uf132",
		agentPlanner: "\uf0ae",
		thinking: "\uf0eb",
		clock: "\uf017",
		location: "\u{f034e}",
		sparkles: "\u{f0674}",
		read: "\u{f0208}",
		write: "\uf0c7",
		edit: "\uf040",
		search: "\uf002",
		folder: "\uf07b",
		terminal: "\uf120",
		skill: "\uf0d0",
		job: "\uf085",
		tool: "\uf0ad",
		settings: "\uf013",
		model: "\uf1b2",
		tree: "\uf0e8",
		export: "\uf08e",
		import: "\uf019",
		share: "\uf1e0",
		bug: "\uf188",
		info: "\uf129",
		history: "\uf1da",
		keyboard: "\uf11c",
		fork: "\uf126",
		trust: "\uf132",
		login: "\uf090",
		logout: "\uf08b",
		compact: "\uf066",
		reload: "\uf021",
		quit: "\uf011",
		fast: "\uf0e7",
		pause: "\uf04c",
		extension: "\uf12e",
		prompt: "\uf27a",
		statusDot: "\u2022",
	},
};

// Extensions loaded through jiti must see the same preset as the main interactive runtime.
const ICON_PRESET_KEY = Symbol.for("@earendil-works/pi-coding-agent:icon-preset");

/** Return the icon preset shared by the interactive runtime and extension module loaders. */
export function getIconPreset(): IconPreset {
	return (globalThis as Record<symbol, IconPreset | undefined>)[ICON_PRESET_KEY] ?? "unicode";
}

/** Return an uncolored icon using the interactive harness's current preset. */
export function icon(name: IconName): string {
	return ICONS[getIconPreset()][name];
}

/** Apply the configured icon preset to all interactive components and extension module loaders. */
export function setIconPreset(preset: IconPreset): void {
	(globalThis as Record<symbol, IconPreset>)[ICON_PRESET_KEY] = preset;
}
