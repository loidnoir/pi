import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "../src/core/jobs/manager.ts";
import { readJobRuntime, writeJobRecord } from "../src/core/jobs/state.ts";
import { runJobWorker } from "../src/core/jobs/worker.ts";
import * as shell from "../src/utils/shell.ts";

vi.mock("node:child_process", { spy: true });

const directories: string[] = [];

async function fixture(options: {
	shell: "exited" | "running";
	descendant: "detached" | "same-group";
	timeout: number;
}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-job-worker-test-"));
	directories.push(directory);
	const manager = new JobManager(directory);
	const id = randomUUID();
	const jobDirectory = join(directory, id);
	const release = join(directory, "release");
	const released = join(directory, "released");
	const descendant = `const fs = require('node:fs'); process.stdout.on('error', () => {}); process.stderr.on('error', () => {}); console.log('descendant ready'); setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { fs.writeFileSync(${JSON.stringify(released)}, 'exiting'); process.exit(); } console.log('descendant tick'); }, 20); setTimeout(() => process.exit(), 15000);`;
	const command = `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {detached: ${options.descendant === "detached"}, stdio: 'inherit'}); child.unref(); ${options.shell === "running" ? "setInterval(() => {}, 1000);" : ""}`;
	mkdirSync(jobDirectory);
	writeJobRecord(jobDirectory, "spec.json", {
		id,
		name: "worker cleanup",
		command,
		cwd: directory,
		createdAt: Date.now(),
		token: "a".repeat(64),
		shell: { shell: process.execPath, args: ["--eval"] },
		timeout: options.timeout,
	});
	writeJobRecord(jobDirectory, "runtime.json", { state: "starting", startedAt: Date.now() });
	const spawn = vi.mocked(childProcess.spawn);
	spawn.mockClear();
	const worker = runJobWorker(jobDirectory);
	await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
	const child = spawn.mock.results[0].value;
	return {
		manager,
		id,
		child,
		jobDirectory,
		worker,
		async close() {
			writeFileSync(release, "exit");
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await worker;
			if (options.descendant === "detached") {
				await expect.poll(() => existsSync(released), { timeout: 3000 }).toBe(true);
			}
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("job supervisor cleanup", () => {
	it.each(["timeout", "stop"] as const)(
		"bounds %s cleanup without signalling an exited shell or allowing unsafe restart/delete",
		async (action) => {
			const kill = vi.spyOn(shell, "killProcessTree").mockImplementation(() => {});
			const job = await fixture({
				shell: "exited",
				descendant: "detached",
				timeout: action === "timeout" ? 0.5 : 0,
			});
			let stopping: ReturnType<JobManager["stop"]> | undefined;
			try {
				await expect.poll(() => job.child.exitCode).toBe(0);
				await expect.poll(() => job.manager.logs(job.id).text).toContain("descendant ready");
				const before = job.manager.logs(job.id).text.length;
				if (action === "stop") stopping = job.manager.stop(job.id);
				await expect.poll(() => readJobRuntime(job.jobDirectory).state, { timeout: 3000 }).toBe("failed");
				await stopping;
				await job.worker;
				expect(readJobRuntime(job.jobDirectory)).toMatchObject({
					error: expect.stringContaining("escaped subprocesses may still be running"),
				});
				expect(kill).not.toHaveBeenCalled();
				expect(job.manager.logs(job.id).text.length).toBeGreaterThan(before);
				await expect(job.manager.restart(job.id)).rejects.toThrow(/termination.*confirmed/i);
				await expect(job.manager.remove(job.id)).rejects.toThrow(/termination.*confirmed/i);
			} finally {
				await job.close();
				await stopping;
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"bounds timeout cleanup when a live shell is killed but an escaped descendant retains the pipes",
		async () => {
			const kill = vi.spyOn(shell, "killProcessTree");
			const job = await fixture({ shell: "running", descendant: "detached", timeout: 0.5 });
			try {
				await expect.poll(() => job.manager.logs(job.id).text).toContain("descendant ready");
				await expect.poll(() => readJobRuntime(job.jobDirectory).state, { timeout: 3000 }).toBe("failed");
				await job.worker;
				expect(kill).toHaveBeenCalledExactlyOnceWith(job.child.pid);
				expect(readJobRuntime(job.jobDirectory)).toMatchObject({
					error: expect.stringContaining("escaped subprocesses may still be running"),
				});
				expect(job.manager.logs(job.id).text).toContain("descendant tick");
			} finally {
				await job.close();
			}
		},
	);

	it.skipIf(process.platform === "win32")("keeps confirmed same-group timeout cleanup as timed_out", async () => {
		const job = await fixture({ shell: "running", descendant: "same-group", timeout: 0.5 });
		try {
			await expect.poll(() => job.manager.logs(job.id).text).toContain("descendant ready");
			await expect.poll(() => readJobRuntime(job.jobDirectory).state, { timeout: 3000 }).toBe("timed_out");
			expect(readFileSync(join(job.jobDirectory, "output.log"), "utf8")).toContain("descendant ready");
		} finally {
			await job.close();
		}
	});
});
