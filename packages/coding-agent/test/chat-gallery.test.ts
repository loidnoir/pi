import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { expect, test } from "vitest";

function gallery(...args: string[]): string {
	const output = execFileSync(
		process.execPath,
		["--import", "./src/experimental/source-resolver.ts", "test/chat-gallery/preview.ts", ...args],
		{
			cwd: fileURLToPath(new URL("../", import.meta.url)),
			encoding: "utf8",
			timeout: 15_000,
		},
	);
	expect(output).not.toContain("\x1b]133;");
	return stripVTControlCharacters(output);
}

test("prints message and tool specimens and expands a filtered summary", () => {
	const all = gallery("--width", "80");
	expect(all).toContain("The label precedes the image.");
	expect(all).toContain("palette.ts");
	const args = ["--filter", "compaction", "--width", "48"];
	const compact = gallery(...args);
	const expanded = gallery(...args, "--expanded");
	expect(compact).toContain("[compaction]");
	expect(compact).not.toContain("Assistant markdown");
	expect(compact).not.toContain("The preview layout is settled.");
	expect(expanded).toContain("The preview layout is settled.");
});
