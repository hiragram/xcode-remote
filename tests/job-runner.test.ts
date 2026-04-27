import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JobRunner, type Job } from "../src/queue/job-runner.js";

function makeJob(overrides?: Partial<Job>): Job {
  return {
    id: "job_test001",
    status: "queued",
    args: [],
    createdAt: new Date().toISOString(),
    log: "",
    ...overrides,
  };
}

describe("JobRunner", () => {
  describe("run", () => {
    it("runs a command successfully and captures stdout", async () => {
      const runner = new JobRunner("echo");
      const job = makeJob({ args: ["hello", "world"] });

      const result = await runner.run(job);

      assert.equal(result.exitCode, 0);
      assert.match(result.log, /hello world/);
      assert.equal(job.status, "completed");
      assert.ok(job.startedAt);
      assert.ok(job.completedAt);
      assert.equal(job.exitCode, 0);
    });

    it("captures stderr output", async () => {
      const runner = new JobRunner("bash");
      const job = makeJob({ args: ["-c", "echo error_output >&2"] });

      const result = await runner.run(job);

      assert.equal(result.exitCode, 0);
      assert.match(result.log, /error_output/);
    });

    it("captures both stdout and stderr interleaved", async () => {
      const runner = new JobRunner("bash");
      const job = makeJob({
        args: ["-c", "echo stdout_line; echo stderr_line >&2"],
      });

      const result = await runner.run(job);

      assert.equal(result.exitCode, 0);
      assert.match(result.log, /stdout_line/);
      assert.match(result.log, /stderr_line/);
    });

    it("reports non-zero exit code as failed", async () => {
      const runner = new JobRunner("bash");
      const job = makeJob({ args: ["-c", "exit 42"] });

      const result = await runner.run(job);

      assert.equal(result.exitCode, 42);
      assert.equal(job.status, "failed");
      assert.equal(job.exitCode, 42);
    });

    it("sets status to running during execution", async () => {
      const runner = new JobRunner("bash");
      const job = makeJob({ args: ["-c", "sleep 0.1"] });

      const promise = runner.run(job);
      // Immediately after spawn, job should be running
      assert.equal(job.status, "running");
      assert.ok(job.startedAt);

      await promise;
      assert.notEqual(job.status, "running");
    });

    it("handles command not found", async () => {
      const runner = new JobRunner("nonexistent_command_12345");
      const job = makeJob({ args: [] });

      const result = await runner.run(job);

      assert.equal(result.exitCode, 1);
      assert.equal(job.status, "failed");
      assert.ok(job.error);
      assert.match(result.log, /Error:/);
    });

    it("respects workingDirectory", async () => {
      const runner = new JobRunner("pwd");
      const job = makeJob({ args: [], workingDirectory: "/tmp" });

      const result = await runner.run(job);

      assert.equal(result.exitCode, 0);
      // macOS /tmp is a symlink to /private/tmp
      assert.match(result.log, /\/tmp/);
    });

    it("accumulates log on the job object", async () => {
      const runner = new JobRunner("bash");
      const job = makeJob({
        args: ["-c", "for i in 1 2 3; do echo line$i; done"],
      });

      await runner.run(job);

      assert.match(job.log, /line1/);
      assert.match(job.log, /line2/);
      assert.match(job.log, /line3/);
    });

    it("handles large output", async () => {
      const runner = new JobRunner("bash");
      const job = makeJob({
        args: ["-c", "for i in $(seq 1 1000); do echo line_$i; done"],
      });

      const result = await runner.run(job);

      assert.equal(result.exitCode, 0);
      assert.match(result.log, /line_1\n/);
      assert.match(result.log, /line_1000/);
    });
  });

  describe("cancel", () => {
    it("kills a running process", async () => {
      const runner = new JobRunner("bash");
      const job = makeJob({ args: ["-c", "sleep 30"] });

      const promise = runner.run(job);

      // Wait a bit for the process to start
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(job.status, "running");

      runner.cancel(job.id);

      const result = await promise;
      // Killed processes return non-zero exit code
      assert.notEqual(result.exitCode, 0);
    });

    it("does nothing for unknown job id", () => {
      const runner = new JobRunner("echo");
      // Should not throw
      runner.cancel("nonexistent_id");
    });
  });
});
