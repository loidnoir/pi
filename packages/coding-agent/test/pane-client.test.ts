import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tui from "@earendil-works/pi-tui";
import type { Terminal as Xterm } from "@xterm/headless";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { localProof, receivePackets, sendPacket } from "../src/core/local-channel.ts";
import { runPaneClient } from "../src/core/panes/client.ts";
import type { PaneInput } from "../src/core/panes/protocol.ts";

const { copySelection } = vi.hoisted(() => ({
	copySelection: vi.fn<(text: string) => Promise<true>>().mockResolvedValue(true),
}));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof tui>();
	return {
		...actual,
		ProcessTerminal: vi.fn(),
		TuiAltScreen: class extends actual.TuiAltScreen {
			constructor(terminal: tui.Terminal, debug: boolean) {
				super(terminal, debug, undefined, { copySelection });
			}
		},
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("pane client terminal", () => {
	it("forwards viewport input, retains selection and paints the frame on the terminal background", async () => {
		const terminal = new VirtualTerminal(80, 24);
		// Replace only the process terminal boundary; run the real fullscreen input dispatcher.
		// biome-ignore lint/complexity/useArrowFunction: Vitest invokes this mock as a constructor.
		vi.mocked(tui.ProcessTerminal).mockImplementation(function () {
			return terminal as unknown as tui.ProcessTerminal;
		});
		copySelection.mockClear();
		const packets: PaneInput[] = [];
		const connected = Promise.withResolvers<Socket>();
		const token = "a".repeat(64);
		const server = createServer((socket) => {
			socket.on("error", () => {});
			receivePackets(socket, (value) => {
				// This fixture receives packets only from the local client under test.
				const packet = value as PaneInput;
				packets.push(packet);
				if (packet.type === "hello") {
					expect(packet.proof).toBe(localProof(token, "pane-client"));
					sendPacket(socket, { type: "ready", proof: localProof(token, "pane-server") });
					sendPacket(socket, { type: "frame", lines: ["selectable pane content", "second line"] });
					connected.resolve(socket);
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture server address");
		const directory = mkdtempSync(join(tmpdir(), "pi-pane-client-test-"));
		const credentials = join(directory, "credentials.json");
		writeFileSync(credentials, JSON.stringify({ port: address.port, token }));
		const running = runPaneClient(credentials);
		let socket: Socket | undefined;
		try {
			socket = await connected.promise;
			await vi.waitFor(async () => {
				await terminal.waitForRender();
				expect(terminal.getViewport()[0]).toBe("selectable pane content");
			});
			terminal.sendInput("\x1b]11;rgb:eeee/f0f0/f2f2\x07");
			terminal.sendInput("\x1b[?62;22c");
			const card = `\x1b[48;2;211;226;205m${"read".padEnd(80)}\x1b[49m`;
			sendPacket(socket, {
				type: "frame",
				lines: ["\x1b[34mselectable pane content\x1b[0m", card, "", card, "Messages 2/2"],
			});
			await vi.waitFor(async () => {
				await terminal.waitForRender();
				expect(terminal.getViewport()[4].trimEnd()).toBe("Messages 2/2");
			});
			const { buffer } = (terminal as unknown as { xterm: Xterm }).xterm;
			for (const [row, color] of [0xeef0f2, 0xd3e2cd, 0xeef0f2, 0xd3e2cd, 0xeef0f2].entries()) {
				for (let col = 0; col < terminal.columns; col++) {
					const cell = buffer.active.getLine(row)!.getCell(col)!;
					expect(cell.isBgRGB() && cell.getBgColor(), `row ${row}, col ${col}`).toBe(color);
				}
			}
			terminal.sendInput("\x1b[5~"); // PageUp
			terminal.sendInput("\x1b[6~"); // PageDown
			terminal.sendInput("x");
			terminal.sendInput("\x1b[<64;3;1M"); // Wheel up: default one logical line
			terminal.sendInput("\x1b[<65;3;1M"); // Wheel down
			terminal.sendInput("\x1b[<72;3;1M"); // Alt+wheel up: accelerated logical lines
			await vi.waitFor(() => expect(packets.filter((packet) => packet.type === "scroll")).toHaveLength(3));
			expect(packets.filter((packet) => packet.type === "input")).toEqual([
				{ type: "input", data: "\x1b[5~" },
				{ type: "input", data: "\x1b[6~" },
				{ type: "input", data: "x" },
			]);
			expect(packets.filter((packet) => packet.type === "scroll")).toEqual([
				{ type: "scroll", lines: -1 },
				{ type: "scroll", lines: 1 },
				{ type: "scroll", lines: -5 },
			]);
			const previous = packets.length;
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;23;1M");
			terminal.sendInput("\x1b[<0;23;1m");
			await vi.waitFor(() => expect(copySelection).toHaveBeenCalledWith("selectable pane content"));
			expect(packets).toHaveLength(previous);
		} finally {
			socket?.destroy();
			await running;
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
