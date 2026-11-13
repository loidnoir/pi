import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "../src/core/jobs/manager.ts";
import type { JobInfo } from "../src/core/jobs/state.ts";
import { JobsView } from "../src/core/jobs/view.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PaneControls } from "../src/core/panes/host.ts";
import { highlightCode, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const fixtures: { view: JobsView; directory: string }[] = [];

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	for (const { view, directory } of fixtures.splice(0)) {
		view.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

async function fixture(log: string, overrides: Partial<JobInfo> = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-jobs-view-"));
	const manager = new JobManager(directory);
	const id = "00000000-0000-0000-0000-000000000001";
	const job: JobInfo = {
		id,
		name: "Test job",
		command: "printf 'hello'",
		cwd: directory,
		createdAt: 0,
		runtime: { state: "completed", startedAt: 0, endedAt: 1000, exitCode: 0 },
		logPath: join(directory, id, "output.log"),
		workerLogPath: join(directory, id, "worker.log"),
		...overrides,
	};
	mkdirSync(join(directory, id));
	writeFileSync(job.logPath, log);
	// Presentation fixtures use real raw log reads without reading credential-bearing job specs.
	vi.spyOn(manager, "inspect").mockResolvedValue(job);
	vi.spyOn(manager, "watch").mockReturnValue(() => {});
	const controls: PaneControls = {
		invalidate: vi.fn(),
		close: vi.fn(),
		minimize: vi.fn(async () => {}),
		setTitle: vi.fn(async () => {}),
	};
	const view = new JobsView(manager, directory, controls, () => {}, id);
	fixtures.push({ view, directory });
	await vi.waitFor(() => expect(controls.invalidate).toHaveBeenCalled());
	return { view, manager, job, controls };
}

function plain(lines: string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line).trimEnd());
}

function output(view: JobsView, width = 80, height = 100): string[] {
	const lines = view.render(width, height);
	const start = lines.findIndex((line, index) => index >= 5 && line === "") + 1;
	const end = lines.findIndex((line) => stripVTControlCharacters(line).startsWith("Full output:"));
	return lines.slice(start, end);
}

describe("background job view coloring", () => {
	it("keeps emitted SGR colors and styles without rewriting raw logs or job metadata", async () => {
		const raw = "\x1b[1;32mPASS\x1b[22;39m \x1b[38;5;201mindexed\x1b[0m\n\x1b[38;2;12;34;56mRGB\x1b[0m";
		const { view, manager, job } = await fixture(raw);
		const original = structuredClone(job);
		const lines = output(view);
		expect(plain(lines)).toEqual(["PASS indexed", "RGB"]);
		expect(lines[0]).toContain("\x1b[1;32mPASS\x1b[22;39m");
		expect(lines[0]).toContain("\x1b[38;5;201mindexed");
		expect(lines[1]).toContain("\x1b[38;2;12;34;56mRGB");
		expect(lines.every((line) => line.endsWith("\x1b[0m"))).toBe(true);
		expect(readFileSync(job.logPath, "utf8")).toBe(raw);
		expect(manager.logs(job.id).text).toBe(raw);
		expect(job).toEqual(original);
	});

	it("removes OSC, cursor/mode CSI, control strings and binary controls while retaining SGR", async () => {
		const raw = [
			"\x1b]0;injected title\x07",
			"\x1b]52;c;clipboard\x1b\\",
			"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x07",
			"\x1b[2J\x1b[H\x1b[?25l\x1b[5 q\x1b[<0;1;2M",
			"\x1bPdevice payload\x1b\\\x1b_apc payload\x1b\\\x1b^private payload\x1b\\\x1bXsos payload\x1b\\",
			"\x9d0;c1 title\x9c\x90c1 payload\x9c\x9b2J",
			"\x1b(B\x1b=\x1b>\x00\x07\x08\x7f\x85",
			" \x1b[31mred\x1b[0m",
		].join("");
		const { view } = await fixture(raw);
		const lines = output(view);
		expect(plain(lines)).toEqual(["link red"]);
		expect(lines[0]).toContain("\x1b[31mred\x1b[0m");
		expect(lines.join("").replace(/\x1b\[[\d;]*m/g, "")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
	});

	it.each(["\x1b", "\x1b[", "\x1b[38;2;12", "\x1b]52;c;unfinished", "\x1bPunfinished", "\x9dunfinished"])(
		"drops unfinished escape tails (%j)",
		async (tail) => {
			const { view } = await fixture(`before${tail}`);
			expect(plain(output(view))).toEqual(["before"]);
		},
	);

	it("rejects malformed/private SGR and normalizes C1 styling for wrapped continuations", async () => {
		const { view } = await fixture("\x1b[?31m\x1b[31 m\x9b32mC1 color\ncontinued\x9b0m");
		const lines = output(view);
		expect(plain(lines)).toEqual(["C1 color", "continued"]);
		expect(lines[0]).toContain("\x1b[32mC1 color");
		expect(lines[1]).toContain("\x1b[32mcontinued");
		expect(lines.join("")).not.toContain("\x9b");
	});

	it("highlights sanitized Bash syntax and truncates the command after highlighting", async () => {
		const command = "if true; then printf '%s\\n' \"$HOME\"; fi";
		const { view, job } = await fixture("plain output", { command: `\x1b[31m${command}\x1b[0m\nexit\t0` });
		const header = view.render(120, 30)[3];
		const sanitized = `${command}\\nexit   0`;
		expect(stripVTControlCharacters(header)).toBe(`$ ${sanitized}`);
		expect(header).toBe(`$ ${highlightCode(sanitized, "bash")[0]}`);
		expect(header).toContain(theme.fg("syntaxKeyword", "if"));
		expect(header).toContain(theme.fg("syntaxString", "'%s\\n'"));
		expect(header).not.toContain("\x1b[31m");
		expect(job.command).toBe(`\x1b[31m${command}\x1b[0m\nexit\t0`);
		for (const width of [1, 8, 20, 40]) expect(visibleWidth(view.render(width, 30)[3])).toBeLessThanOrEqual(width);
		initTheme("light");
		expect(view.render(120, 30)[3]).toBe(`$ ${highlightCode(sanitized, "bash")[0]}`);
	});

	it("wraps colored CJK, graphemes and tabs within terminal columns and keeps literal newline colors", async () => {
		const { view } = await fixture("\x1b[1;38;2;12;34;56m日本語\t👩‍💻éabcdefgh\r\nnext\rfinal\x1b[0m");
		for (const width of [4, 8, 16]) {
			const lines = output(view, width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(lines.every((line) => line.startsWith("\x1b[1;38;2;12;34;56m"))).toBe(true);
			const text = plain(lines).join("");
			expect(text).toContain("日本語");
			expect(text).toContain("👩‍💻éabcdefghnextfinal");
			expect(lines.join("")).not.toMatch(/[\t\r]/);
		}
		expect(plain(output(view))).toEqual(["日本語   👩‍💻éabcdefgh", "next", "final"]);
	});

	it("restores color at the top of tail and scrolled viewports when the opening SGR is offscreen", async () => {
		const raw = `\x1b[35m${Array.from({ length: 30 }, (_, index) => `row ${index}`).join("\n")}\x1b[0m`;
		const { view } = await fixture(raw);
		const tail = output(view, 80, 15);
		expect(plain(tail)).toEqual(["row 26", "row 27", "row 28", "row 29"]);
		expect(tail[0]).toContain("\x1b[35mrow 26");
		view.handleInput("\x1b[5~");
		const scrolled = output(view, 80, 15);
		expect(plain(scrolled)).toEqual(["row 16", "row 17", "row 18", "row 19"]);
		expect(scrolled[0]).toContain("\x1b[35mrow 16");
		view.handleInput("\x1b[6~");
		expect(plain(output(view, 80, 15))).toEqual(plain(tail));
	});

	it("keeps plain logs plain and leaves metadata sanitation and the output gap intact", async () => {
		const { view } = await fixture("plain log", {
			name: "\x1b[31mName\x1b[0m",
			progress: { percent: 42, message: "\x1b[31mindexing\x1b[0m" },
		});
		const lines = view.render(100, 30);
		const text = plain(lines);
		const progressIndex = text.indexOf("indexing");
		expect(text[0]).toBe("Name");
		expect(text).toContain("[============                  ] 42%");
		expect(text[progressIndex + 1]).toBe("");
		expect(text[progressIndex + 2]).toBe("plain log");
		expect(lines[progressIndex]).toBe("indexing");
		expect(lines[progressIndex + 2]).not.toMatch(/\x1b\[(?!0m)/);
	});
});
