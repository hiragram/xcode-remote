import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "../src/queue/job-queue.js";

// Use "echo" as the command since xcodebuild might not be available in CI
function createQueue(
  maxConcurrency: number = 1,
  allowedPaths?: string[],
): JobQueue {
  return new JobQueue(maxConcurrency, allowedPaths, "echo");
}

// Use "bash" for more complex test scenarios
function createBashQueue(
  maxConcurrency: number = 1,
  allowedPaths?: string[],
): JobQueue {
  return new JobQueue(maxConcurrency, allowedPaths, "bash");
}

describe("JobQueue", () => {
  describe("submit", () => {
    it("returns a jobId and a completion promise", () => {
      const queue = createQueue();
      const { jobId, completion } = queue.submit(["hello"]);

      assert.ok(jobId.startsWith("job_"));
      assert.ok(completion instanceof Promise);
    });

    it("generates unique job IDs", () => {
      const queue = createBashQueue(10);
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const { jobId } = queue.submit(["-c", `echo ${i}`]);
        ids.add(jobId);
      }
      assert.equal(ids.size, 20);
    });

    it("creates a job in queued status", () => {
      // Use bash with sleep to keep it queued (concurrency=1, first job blocks)
      const queue = createBashQueue(1);
      // First job: blocks the slot
      queue.submit(["-c", "sleep 10"]);
      // Second job: should be queued
      const { jobId } = queue.submit(["-c", "echo queued"]);
      const job = queue.getJob(jobId);

      assert.ok(job);
      assert.equal(job.status, "queued");
    });

    it("resolves with result on completion", async () => {
      const queue = createQueue();
      const { completion } = queue.submit(["hello", "world"]);
      const result = await completion;

      assert.equal(result.exitCode, 0);
      assert.match(result.log, /hello world/);
    });

    it("resolves with non-zero exit code on failure", async () => {
      const queue = createBashQueue();
      const { completion } = queue.submit(["-c", "exit 1"]);
      const result = await completion;

      assert.equal(result.exitCode, 1);
    });
  });

  describe("allowed paths", () => {
    it("allows submission when workingDirectory matches allowed paths", () => {
      const queue = createQueue(1, ["/Users/test/Projects"]);
      assert.doesNotThrow(() => {
        queue.submit(["hello"], "/Users/test/Projects/MyApp");
      });
    });

    it("throws when workingDirectory is not in allowed paths", () => {
      const queue = createQueue(1, ["/Users/test/Projects"]);
      assert.throws(
        () => queue.submit(["hello"], "/Users/evil/hack"),
        /not in allowed paths/,
      );
    });

    it("allows submission without workingDirectory even with allowed paths set", () => {
      const queue = createQueue(1, ["/Users/test/Projects"]);
      assert.doesNotThrow(() => {
        queue.submit(["hello"]);
      });
    });

    it("allows submission when no allowed paths are configured", () => {
      const queue = createQueue(1);
      assert.doesNotThrow(() => {
        queue.submit(["hello"], "/any/path/here");
      });
    });

    it("checks against multiple allowed paths", () => {
      const queue = createQueue(1, [
        "/Users/test/Projects",
        "/Users/test/Dev",
      ]);
      assert.doesNotThrow(() => {
        queue.submit(["hello"], "/Users/test/Dev/MyApp");
      });
    });
  });

  describe("concurrency", () => {
    it("runs jobs sequentially with maxConcurrency=1", async () => {
      const queue = createBashQueue(1);
      const order: number[] = [];

      const { completion: c1 } = queue.submit([
        "-c",
        "sleep 0.05; echo done1",
      ]);
      const { completion: c2 } = queue.submit([
        "-c",
        "sleep 0.05; echo done2",
      ]);

      c1.then(() => order.push(1));
      c2.then(() => order.push(2));

      await Promise.all([c1, c2]);

      assert.deepEqual(order, [1, 2]);
    });

    it("runs jobs in parallel with maxConcurrency=2", async () => {
      const queue = createBashQueue(2);

      const start = Date.now();
      const { completion: c1 } = queue.submit(["-c", "sleep 0.1"]);
      const { completion: c2 } = queue.submit(["-c", "sleep 0.1"]);

      await Promise.all([c1, c2]);
      const elapsed = Date.now() - start;

      // If parallel, ~100ms. If sequential, ~200ms.
      // Use a generous threshold to avoid flakiness
      assert.ok(elapsed < 180, `Expected parallel execution, took ${elapsed}ms`);
    });

    it("queues excess jobs when at capacity", async () => {
      const queue = createBashQueue(1);

      // First job blocks the slot
      const { completion: c1 } = queue.submit(["-c", "sleep 0.1"]);
      // Second and third should queue
      const { completion: c2 } = queue.submit(["-c", "echo second"]);
      const { completion: c3 } = queue.submit(["-c", "echo third"]);

      assert.equal(queue.runningCount, 1);
      assert.equal(queue.queuedCount, 2);

      await Promise.all([c1, c2, c3]);

      assert.equal(queue.runningCount, 0);
      assert.equal(queue.queuedCount, 0);
    });

    it("processes queued jobs as running ones complete", async () => {
      const queue = createBashQueue(1);
      const completionOrder: string[] = [];

      const { jobId: id1, completion: c1 } = queue.submit([
        "-c",
        "sleep 0.05; echo first",
      ]);
      const { jobId: id2, completion: c2 } = queue.submit([
        "-c",
        "echo second",
      ]);

      c1.then(() => completionOrder.push(id1));
      c2.then(() => completionOrder.push(id2));

      await Promise.all([c1, c2]);

      assert.equal(completionOrder[0], id1);
      assert.equal(completionOrder[1], id2);
    });
  });

  describe("getJob", () => {
    it("returns job by ID", () => {
      const queue = createQueue();
      const { jobId } = queue.submit(["test"]);
      const job = queue.getJob(jobId);

      assert.ok(job);
      assert.equal(job.id, jobId);
      assert.deepEqual(job.args, ["test"]);
    });

    it("returns undefined for unknown ID", () => {
      const queue = createQueue();
      assert.equal(queue.getJob("nonexistent"), undefined);
    });

    it("reflects status changes", async () => {
      const queue = createQueue();
      const { jobId, completion } = queue.submit(["hello"]);

      await completion;

      const job = queue.getJob(jobId);
      assert.ok(job);
      assert.equal(job.status, "completed");
      assert.equal(job.exitCode, 0);
    });
  });

  describe("listJobs", () => {
    it("returns all jobs when no filter", async () => {
      const queue = createQueue();
      queue.submit(["a"]);
      queue.submit(["b"]);

      const jobs = queue.listJobs();
      assert.equal(jobs.length, 2);
    });

    it("returns empty array when no jobs", () => {
      const queue = createQueue();
      assert.deepEqual(queue.listJobs(), []);
    });

    it("filters by status", async () => {
      const queue = createBashQueue(1);

      // First job blocks
      const { completion: c1 } = queue.submit(["-c", "sleep 0.2"]);
      // These queue up
      queue.submit(["-c", "echo a"]);
      queue.submit(["-c", "echo b"]);

      const running = queue.listJobs(["running"]);
      const queued = queue.listJobs(["queued"]);

      assert.equal(running.length, 1);
      assert.equal(queued.length, 2);

      // Clean up
      await c1;
      // Wait for the remaining jobs
      await new Promise((r) => setTimeout(r, 200));
    });

    it("filters by multiple statuses", async () => {
      const queue = createBashQueue(1);

      queue.submit(["-c", "sleep 0.2"]);
      queue.submit(["-c", "echo a"]);

      const active = queue.listJobs(["running", "queued"]);
      assert.equal(active.length, 2);

      // Clean up
      await new Promise((r) => setTimeout(r, 400));
    });
  });

  describe("cancelJob", () => {
    it("cancels a queued job", async () => {
      const queue = createBashQueue(1);

      // Block the slot
      const { completion: c1 } = queue.submit(["-c", "sleep 0.2"]);
      // This should be queued
      const { jobId: id2 } = queue.submit(["-c", "echo should_not_run"]);

      const cancelled = queue.cancelJob(id2);
      assert.equal(cancelled, true);

      const job = queue.getJob(id2);
      assert.ok(job);
      assert.equal(job.status, "cancelled");
      assert.ok(job.completedAt);

      await c1;
    });

    it("cancels a running job", async () => {
      const queue = createBashQueue(1);

      const { jobId, completion } = queue.submit(["-c", "sleep 30"]);

      // Wait for it to start running
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(queue.getJob(jobId)?.status, "running");

      const cancelled = queue.cancelJob(jobId);
      assert.equal(cancelled, true);

      const job = queue.getJob(jobId);
      assert.ok(job);
      assert.equal(job.status, "cancelled");

      // The promise should still resolve eventually
      await completion;
    });

    it("returns false for unknown job", () => {
      const queue = createQueue();
      assert.equal(queue.cancelJob("nonexistent"), false);
    });

    it("returns false for already completed job", async () => {
      const queue = createQueue();
      const { jobId, completion } = queue.submit(["done"]);

      await completion;
      assert.equal(queue.cancelJob(jobId), false);
    });

    it("removes cancelled job from queue so it does not run", async () => {
      const queue = createBashQueue(1);

      // Block slot
      const { completion: c1 } = queue.submit(["-c", "sleep 0.1"]);
      // Queue two more
      const { jobId: id2 } = queue.submit(["-c", "echo should_not_run"]);
      const { jobId: id3, completion: c3 } = queue.submit(["-c", "echo third"]);

      // Cancel the second
      queue.cancelJob(id2);

      // After first completes, third should run (not second)
      await c1;
      const result3 = await c3;

      assert.equal(result3.exitCode, 0);
      assert.match(result3.log, /third/);
    });
  });

  describe("runningCount and queuedCount", () => {
    it("starts at zero", () => {
      const queue = createQueue();
      assert.equal(queue.runningCount, 0);
      assert.equal(queue.queuedCount, 0);
    });

    it("increments running count when job starts", () => {
      const queue = createBashQueue(1);
      queue.submit(["-c", "sleep 1"]);

      // Give it a tick to start
      assert.equal(queue.runningCount, 1);
      assert.equal(queue.queuedCount, 0);
    });

    it("tracks queued correctly", () => {
      const queue = createBashQueue(1);
      queue.submit(["-c", "sleep 1"]);
      queue.submit(["-c", "echo a"]);
      queue.submit(["-c", "echo b"]);

      assert.equal(queue.runningCount, 1);
      assert.equal(queue.queuedCount, 2);
    });

    it("decrements after completion", async () => {
      const queue = createQueue();
      const { completion } = queue.submit(["hello"]);

      await completion;

      assert.equal(queue.runningCount, 0);
      assert.equal(queue.queuedCount, 0);
    });
  });
});
