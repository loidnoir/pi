import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Static } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { JobManager } from "../src/core/jobs/manager.ts";
import type { JobInfo } from "../src/core/jobs/state.ts";
import { JobsView } from "../src/core/jobs/view.ts";
import { localProof, receivePackets, sendPacket, verifyLocalProof } from "../src/core/local-channel.ts";
import { openPane, type PaneControls, type PaneHandle, type PaneView } from "../src/core/panes/host.ts";
import type { PaneCredentialsSchema, PaneOutput } from "../src/core/panes/protocol.ts";
import { closeRexPane, openRexPane, type RexPane, setRexPaneMinimized } from "../src/core/rex.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

vi.mock("../src/core/rex.ts", () => ({
	getRexLocation: vi.fn(),
	openRexPane: vi.fn(),
	closeRexPane: vi.fn(async () => {}),
	setRexPaneMinimized: vi.fn(async () => {}),
	setRexPaneTitle: vi.fn(async () => {}),
	showRexPane: vi.fn(async () => {}),
}));

const location = { sessionId: "session:owned-test", blockId: "block:origin-test" };
const ownedPane: RexPane = { sessionId: location.sessionId, blockId: "block:owned-test", layerId: "layer:owned-test" };
const panes: PaneHandle[] = [];
const viewers: Socket[] = [];
const directories: string[] = [];

beforeEach(() => {
	initTheme("dark");
	vi.clearAllMocks();
});

afterEach(async () => {
	for (const pane of panes.splice(0)) await pane.close();
	for (const viewer of viewers.splice(0)) viewer.destroy();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function fixture(create: (controls: PaneControls) => PaneView, minimized: boolean) {
	const frames: string[][] = [];
	let viewer: Socket | undefined;
	vi.mocked(openRexPane).mockImplementation(async (_location, options) => {
		const credentials = JSON.parse(readFileSync(options.command.at(-1)!, "utf8")) as Static<
			typeof PaneCredentialsSchema
		>;
		const socket = connect({ host: "127.0.0.1", port: credentials.port });
		viewer = socket;
		viewers.push(socket);
		socket.once("connect", () =>
			sendPacket(socket, {
				type: "hello",
				proof: localProof(credentials.token, "pane-client"),
				columns: 80,
				rows: 24,
			}),
		);
		receivePackets(socket, (value) => {
			// The test viewer receives packets only from this fixture's local pane host.
			const packet = value as PaneOutput;
			if (packet.type === "ready")
				expect(verifyLocalProof(credentials.token, "pane-server", packet.proof)).toBe(true);
			else if (packet.type === "frame") frames.push(packet.lines.map(stripVTControlCharacters));
		});
		return ownedPane;
	});
	const context = {
		cwd: "/tmp/pane-project",
		mode: "tui",
		ui: {
			theme,
			getRexSettings: () => ({ enabled: true, mode: "floating", minimizedJobs: true }),
			notify: vi.fn(),
		},
	} as unknown as ExtensionContext;
	const pane = await openPane(context, {
		title: "Owned test view",
		backend: "rex",
		placement: "floating",
		minimized,
		fallback: "none",
		location,
		create,
	});
	panes.push(pane);
	await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
	if (!viewer) throw new Error("Missing test viewer");
	return { pane, viewer, frames, context };
}

describe("remote pane live frames", () => {
	it("delivers an initially minimized job's async detail and own log without PaneHandle.show", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-pane-jobs-test-"));
		directories.push(directory);
		const manager = new JobManager(directory);
		const id = "00000000-0000-0000-0000-000000000001";
		const job: JobInfo = {
			id,
			name: "Owned job",
			command: "printf 'own output'",
			cwd: "/tmp/pane-project",
			createdAt: 0,
			runtime: { state: "completed", startedAt: 0, endedAt: 1000, exitCode: 0 },
			logPath: join(directory, id, "output.log"),
			workerLogPath: join(directory, id, "worker.log"),
		};
		mkdirSync(join(directory, id));
		writeFileSync(job.logPath, "OWN_JOB_LOG_CONTENT");
		const inspected = Promise.withResolvers<JobInfo>();
		vi.spyOn(manager, "inspect").mockReturnValue(inspected.promise);
		const list = vi.spyOn(manager, "list");
		vi.spyOn(manager, "watch").mockReturnValue(() => {});
		const test = await fixture((controls) => new JobsView(manager, job.cwd, controls, () => {}, id), true);
		expect(test.frames[0].join("\n")).toContain("No background jobs");
		inspected.resolve(job);
		await vi.waitFor(() => expect(test.frames.at(-1)?.join("\n")).toContain("OWN_JOB_LOG_CONTENT"));
		expect(test.frames.at(-1)?.join("\n")).toContain(id);
		expect(test.frames.at(-1)?.join("\n")).toContain("Owned job");
		expect(list).not.toHaveBeenCalled();
		expect(openRexPane).toHaveBeenCalledWith(location, expect.objectContaining({ minimized: true }));
		expect(readFileSync(job.logPath, "utf8")).toBe("OWN_JOB_LOG_CONTENT");
	});

	it("coalesces live updates and resizes after minimizing, without a host-visible restore event", async () => {
		let controls: PaneControls | undefined;
		let text = "before minimizing";
		const render = vi.fn((width: number, height: number) => [`${text}: ${width}x${height}`]);
		const test = await fixture((value) => {
			controls = value;
			return { render, handleInput() {}, dispose() {} };
		}, false);
		await test.pane.minimize();
		expect(setRexPaneMinimized).toHaveBeenCalledWith(ownedPane, true, test.context.cwd);
		const previous = test.frames.length;
		text = "latest content";
		controls!.invalidate();
		controls!.invalidate();
		controls!.invalidate();
		await vi.waitFor(() => expect(test.frames).toHaveLength(previous + 1));
		expect(test.frames.at(-1)).toContain("latest content: 80x23");
		// Rex can restore the layer itself; only a terminal resize reaches the host.
		sendPacket(test.viewer, { type: "resize", columns: 60, rows: 12 });
		await vi.waitFor(() => expect(test.frames.at(-1)).toContain("latest content: 60x11"));
		expect(render).toHaveBeenLastCalledWith(60, 11);
	});

	it("closes and disposes an initially minimized view when its viewer disconnects", async () => {
		const dispose = vi.fn();
		const test = await fixture(() => ({ render: () => ["live"], handleInput() {}, dispose }), true);
		test.viewer.destroy();
		await test.pane.closed;
		expect(dispose).toHaveBeenCalledOnce();
		await test.pane.close();
		expect(closeRexPane).toHaveBeenCalledWith(ownedPane, test.context.cwd);
	});
});
