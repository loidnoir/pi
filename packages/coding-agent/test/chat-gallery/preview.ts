import { parseArgs } from "node:util";
import { Spacer, setCapabilities, setKeybindings, Text, TuiMainScreen, truncateToWidth } from "@earendil-works/pi-tui";
import { isImageLine } from "../../../tui/src/terminal-image.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { setTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { messageBlocks } from "./messages.ts";
import { statusBlocks } from "./status.ts";
import { toolBlocks } from "./tools.ts";

function preview(): void {
	const { values } = parseArgs({
		options: {
			expanded: { type: "boolean", default: false },
			filter: { type: "string", default: "" },
			help: { type: "boolean", short: "h" },
			list: { type: "boolean" },
			theme: { type: "string", default: "dark" },
			width: { type: "string" },
		},
	});
	if (values.help) {
		console.log(
			"npm run chat:gallery -- [--list] [--filter text] [--expanded] [--width columns] [--theme name]\nUse chat:gallery:watch to redraw after TypeScript edits. Rerun after editing theme JSON.",
		);
		return;
	}
	const width = Number(values.width ?? process.stdout.columns ?? 80);
	if (!Number.isInteger(width) || width < 1 || width > 1000) throw new Error("Width must be 1–1000 columns");
	if (!process.stdout.isTTY) setCapabilities({ images: null, hyperlinks: true, trueColor: true });
	const result = setTheme(values.theme);
	if (!result.success) throw new Error(result.error);
	setKeybindings(new KeybindingsManager());
	const screen = new TuiMainScreen(new VirtualTerminal(width));
	const blocks = [
		...messageBlocks(screen, values.expanded),
		...toolBlocks(screen, values.expanded),
		...statusBlocks(screen),
	];
	const matches = blocks.filter(([name]) => name.toLowerCase().includes(values.filter.toLowerCase()));
	if (matches.length === 0)
		throw new Error(`No blocks match ${JSON.stringify(values.filter)}. Use --list to see the names.`);
	if (values.list) {
		console.log(matches.map(([name]) => name).join("\n"));
		return;
	}
	for (const [name, component] of matches) {
		screen.addChild(new Spacer(1));
		screen.addChild(new Text(theme.bold(theme.fg("accent", name)), 0, 0));
		screen.addChild(component);
	}
	screen.renderNow();
	const lines = screen.captureRenderState().previousLines;
	console.log(lines.map((line) => (isImageLine(line) ? line : truncateToWidth(line, width, ""))).join("\n"));
}

try {
	preview();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
