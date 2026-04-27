import { randomUUID } from "node:crypto";
import { JobRunner, type Job, type JobResult } from "./job-runner.js";
import { logger } from "../logger.js";

interface PendingJob {
  job: Job;
  resolve: (result: JobResult) => void;
}

export class JobQueue {
  private jobs = new Map<string, Job>();
  private queue: PendingJob[] = [];
  private _runningCount = 0;
  private maxConcurrency: number;
  private runner: JobRunner;
  private allowedPaths?: string[];

  constructor(
    maxConcurrency: number = 1,
    allowedPaths?: string[],
    command?: string,
    idleTimeoutMs?: number,
  ) {
    this.maxConcurrency = maxConcurrency;
    this.runner = new JobRunner(command, idleTimeoutMs);
    this.allowedPaths = allowedPaths;
  }

  get runningCount(): number {
    return this._runningCount;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  submit(
    args: string[],
    workingDirectory?: string,
    command?: string,
  ): { jobId: string; completion: Promise<JobResult> } {
    if (this.allowedPaths && workingDirectory) {
      const allowed = this.allowedPaths.some((p) =>
        workingDirectory.startsWith(p),
      );
      if (!allowed) {
        throw new Error(
          `Working directory '${workingDirectory}' is not in allowed paths`,
        );
      }
    }

    const id = `job_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const job: Job = {
      id,
      command: command ?? this.runner.defaultCommand,
      status: "queued",
      args,
      workingDirectory,
      createdAt: new Date().toISOString(),
      log: "",
    };

    this.jobs.set(id, job);

    logger.info(
      `[queue] submitted ${id} cmd=${job.command} args=[${args.join(" ")}]${workingDirectory ? ` cwd=${workingDirectory}` : ""} | queued=${this.queue.length + 1} running=${this._runningCount}`,
    );

    const completion = new Promise<JobResult>((resolve) => {
      this.queue.push({ job, resolve });
      this.processNext();
    });

    return { jobId: id, completion };
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  listJobs(statusFilter?: string[]): Job[] {
    const jobs = Array.from(this.jobs.values());
    if (statusFilter && statusFilter.length > 0) {
      return jobs.filter((j) => statusFilter.includes(j.status));
    }
    return jobs;
  }

  cancelJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.status === "queued") {
      job.status = "cancelled";
      job.completedAt = new Date().toISOString();
      this.queue = this.queue.filter((p) => p.job.id !== id);
      logger.info(
        `[queue] cancelled ${id} (was queued) | queued=${this.queue.length} running=${this._runningCount}`,
      );
      return true;
    }

    if (job.status === "running") {
      // runner.cancel() sends SIGTERM → SIGKILL → fallback settle,
      // which will update job status and resolve the completion promise.
      this.runner.cancel(id);
      logger.info(
        `[queue] cancelled ${id} (was running, sent SIGTERM) | queued=${this.queue.length} running=${this._runningCount}`,
      );
      return true;
    }

    return false;
  }

  private processNext(): void {
    while (this._runningCount < this.maxConcurrency && this.queue.length > 0) {
      const pending = this.queue.shift()!;

      if (pending.job.status === "cancelled") {
        pending.resolve({ exitCode: 1, log: "Cancelled", reason: "cancelled" });
        continue;
      }

      this._runningCount++;
      logger.info(
        `[queue] starting ${pending.job.id} | queued=${this.queue.length} running=${this._runningCount}`,
      );

      this.runner.run(pending.job).then((result) => {
        this._runningCount--;
        logger.info(
          `[queue] finished ${pending.job.id} exit=${result.exitCode} | queued=${this.queue.length} running=${this._runningCount}`,
        );
        pending.resolve(result);
        this.processNext();
      });
    }
  }
}
