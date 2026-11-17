// One detached supervisor per job; its lifetime and control channel do not depend on pi or Rex.
import { spawn } from "node:child_process";
import { closeSync, createWriteStream, openSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { Compile } from "typebox/compile";
import { killProcessTree } from "../../utils/shell.ts";
import { localProof, receivePackets, sendPacket, verifyLocalProof } from "../local-channel.ts";
import {
	JOB_TERMINATION_UNCERTAIN_ERROR,
	JobRequestSchema,
	type JobRuntime,
	readJobSpec,
	writeJobRecord,
} from "./state.ts";

const requestValidator = Compile(JobRequestSchema);

/** Supervise one command, retaining its logs and final state after the initiating pi exits. */
export async function runJobWorker(directory: string): Promise<void> {
	const claim = openSync(join(directory, "worker.lock"), "wx", 0o600);
	closeSync(claim);
	const spec = readJobSpec(directory);
	const proof = localProof(spec.token, "job-reply");
	let runtime: JobRuntime = { state: "starting", startedAt: Date.now() };
	let termination: "stopped" | "timed_out" | undefined;
	let executionError: string | undefined;
	let timeout: NodeJS.Timeout | undefined;
	let cleanup: NodeJS.Timeout | undefined;
	let terminationUncertain = false;
	const server = createServer((socket) => {
		socket.on("error", () => {});
		socket.setTimeout(5000, () => socket.destroy());
		receivePackets(socket, (packet) => {
			// Trust boundary: only authenticated, schema-checked local control messages may stop a job.
			if (
				!requestValidator.Check(packet) ||
				!verifyLocalProof(spec.token, `job-${packet.action}-request`, packet.proof)
			) {
				socket.destroy();
				return;
			}
			sendPacket(socket, { proof, runtime });
			socket.end();
			if (packet.action === "stop") stop("stopped");
		});
	});
	server.maxConnections = 16;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Job control server has no TCP address");
	const output = createWriteStream(join(directory, "output.log"), { flags: "a", mode: 0o600 });
	const stdinCommand = spec.shell.commandTransport === "stdin";
	const child = spawn(spec.shell.shell, stdinCommand ? spec.shell.args : [...spec.shell.args, spec.command], {
		cwd: spec.cwd,
		env: { ...process.env, PI_JOB_ID: spec.id, PI_JOB_PROGRESS_FILE: join(directory, "progress.json") },
		detached: process.platform !== "win32",
		stdio: [stdinCommand ? "pipe" : "ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const completion = Promise.withResolvers<number | null>();
	let childState: "running" | "exited" | "closed" = "running";
	child.once("exit", () => {
		childState = "exited";
	});
	child.once("close", (code) => {
		childState = "closed";
		completion.resolve(code);
	});
	function stop(reason: "stopped" | "timed_out") {
		if (termination || childState === "closed") return;
		termination = reason;
		if (child.pid) {
			if (childState === "exited") terminationUncertain = true;
			else killProcessTree(child.pid);
		}
		cleanup = setTimeout(() => {
			terminationUncertain = true;
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.stdin?.destroy();
			child.unref();
			completion.resolve(child.exitCode);
		}, 1000);
	}
	server.on("error", (error) => {
		executionError = `Job control server failed: ${error.message}`;
		stop("stopped");
	});
	const onSignal = () => stop("stopped");
	process.on("SIGTERM", onSignal);
	process.on("SIGHUP", onSignal);
	process.on("SIGINT", onSignal);
	output.on("error", (error) => {
		executionError = `Cannot retain job output: ${error.message}`;
		stop("stopped");
	});
	child.stdout?.pipe(output, { end: false });
	child.stderr?.pipe(output, { end: false });
	if (stdinCommand) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(spec.command);
	}
	child.once("spawn", () => {
		runtime = {
			state: "running",
			startedAt: runtime.startedAt,
			workerPid: process.pid,
			processPid: child.pid!,
			port: address.port,
		};
		writeJobRecord(directory, "runtime.json", runtime);
		if (spec.timeout !== undefined && spec.timeout > 0)
			timeout = setTimeout(() => stop("timed_out"), spec.timeout * 1000);
	});
	child.once("error", (error) => {
		executionError = error.message;
	});
	try {
		const exitCode = await completion.promise;
		clearTimeout(timeout);
		clearTimeout(cleanup);
		output.end();
		try {
			await finished(output);
		} catch (error) {
			executionError ??= error instanceof Error ? error.message : String(error);
		}
		if (terminationUncertain) executionError = JOB_TERMINATION_UNCERTAIN_ERROR;
		runtime = {
			state: executionError ? "failed" : (termination ?? (exitCode === 0 ? "completed" : "failed")),
			startedAt: runtime.startedAt,
			endedAt: Date.now(),
			exitCode,
			...(executionError ? { error: executionError } : {}),
		};
		writeJobRecord(directory, "runtime.json", runtime);
	} finally {
		clearTimeout(timeout);
		clearTimeout(cleanup);
		process.removeListener("SIGTERM", onSignal);
		process.removeListener("SIGHUP", onSignal);
		process.removeListener("SIGINT", onSignal);
		server.close();
	}
}
