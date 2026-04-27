import { spawn, ChildProcess } from "node:child_process";
import { logger } from "../logger.js";

const DEFAULT_IDLE_TIMEOUT_MS = 60 * 1000; // 60 seconds
const SIGKILL_GRACE_MS = 5_000;
const SETTLE_FALLBACK_MS = 3_000;
const TEST_CRASH_LOOP_PATTERN = "Restarting after unexpected exit";

export interface Job {
  id: string;
  command: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  args: string[];
  workingDirectory?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  log: string;
  error?: string;
}

export type JobTerminationReason = "completed" | "cancelled" | "idle_timeout" | "test_crash_loop" | "error";

export interface JobResult {
  exitCode: number;
  log: string;
  reason: JobTerminationReason;
}

interface ManagedProcess {
  proc: ChildProcess;
  settle: (result: JobResult) => void;
  job: Job;
}

export class JobRunner {
  private processes = new Map<string, ManagedProcess>();
  readonly defaultCommand: string;
  private idleTimeoutMs: number;

  constructor(
    command: string = "xcodebuild",
    idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
  ) {
    this.defaultCommand = command;
    this.idleTimeoutMs = idleTimeoutMs;
  }

  run(job: Job): Promise<JobResult> {
    return new Promise<JobResult>((resolve) => {
      let settled = false;
      const settle = (result: JobResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        this.processes.delete(job.id);
        resolve(result);
      };

      job.status = "running";
      job.startedAt = new Date().toISOString();

      const proc = spawn(job.command || this.defaultCommand, job.args, {
        cwd: job.workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.processes.set(job.id, { proc, settle, job });

      // Idle timeout: kill process if no output for a while
      let lastActivity = Date.now();
      let idleTimer = this.scheduleIdleCheck(job.id, () => lastActivity);

      const onOutput = (data: Buffer) => {
        const text = data.toString();
        job.log += text;
        lastActivity = Date.now();
        process.stdout.write(data);

        if (text.includes(TEST_CRASH_LOOP_PATTERN)) {
          logger.warn(
            `[runner] ${job.id} detected test crash loop, killing process`,
          );
          job.status = "failed";
          job.error = "Test runner entered crash loop";
          this.killAndSettle(job.id, proc, () => {
            job.completedAt ??= new Date().toISOString();
            settle({
              exitCode: 1,
              log: job.log + "\nKilled: test runner crash loop detected",
              reason: "test_crash_loop",
            });
          });
        }
      };

      proc.stdout?.on("data", onOutput);
      proc.stderr?.on("data", onOutput);

      proc.on("close", (code) => {
        const exitCode = code ?? 1;
        job.exitCode = exitCode;
        // Don't overwrite status if already set by cancel/timeout
        if (job.status === "running") {
          job.status = exitCode === 0 ? "completed" : "failed";
        }
        job.completedAt ??= new Date().toISOString();
        settle({ exitCode, log: job.log, reason: exitCode === 0 ? "completed" : "error" });
      });

      proc.on("error", (err) => {
        job.status = "failed";
        job.error = err.message;
        job.completedAt = new Date().toISOString();
        settle({ exitCode: 1, log: job.log + `\nError: ${err.message}`, reason: "error" });
      });
    });
  }

  cancel(jobId: string): void {
    const managed = this.processes.get(jobId);
    if (!managed) return;
    const { proc, settle, job } = managed;
    // Set status eagerly so that "close" handler won't overwrite it
    job.status = "cancelled";
    this.killAndSettle(jobId, proc, () => {
      job.completedAt ??= new Date().toISOString();
      settle({ exitCode: 1, log: job.log + "\nCancelled by user.", reason: "cancelled" });
    });
  }

  /**
   * Send SIGTERM → SIGKILL → fallback settle.
   * If the process emits "close" before the fallback fires,
   * settle()'s idempotency guard prevents double resolution.
   */
  private killAndSettle(
    jobId: string,
    proc: ChildProcess,
    fallbackSettle: () => void,
  ): void {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) {
        logger.warn(`[runner] ${jobId} still alive after SIGTERM, sending SIGKILL`);
        proc.kill("SIGKILL");
      }
      // Even after SIGKILL, "close" may not fire promptly.
      // Schedule a final fallback to guarantee settle() is called.
      setTimeout(() => {
        logger.warn(`[runner] ${jobId} fallback settle after kill`);
        fallbackSettle();
      }, SETTLE_FALLBACK_MS);
    }, SIGKILL_GRACE_MS);
  }

  private scheduleIdleCheck(
    jobId: string,
    getLastActivity: () => number,
  ): ReturnType<typeof setTimeout> {
    const check = () => {
      const managed = this.processes.get(jobId);
      if (!managed) return;
      const { proc, settle, job } = managed;
      const idle = Date.now() - getLastActivity();
      if (idle >= this.idleTimeoutMs) {
        logger.warn(
          `[runner] ${jobId} idle for ${Math.round(idle / 1000)}s, sending SIGTERM`,
        );
        this.killAndSettle(jobId, proc, () => {
          job.status = "failed";
          job.error = `Killed after ${Math.round(idle / 1000)}s idle`;
          job.completedAt = new Date().toISOString();
          settle({
            exitCode: 1,
            log: job.log + `\nKilled: idle timeout (${Math.round(idle / 1000)}s)`,
            reason: "idle_timeout",
          });
        });
      } else {
        idleTimer = setTimeout(check, this.idleTimeoutMs - idle + 100);
      }
    };
    let idleTimer = setTimeout(check, this.idleTimeoutMs);
    return idleTimer;
  }
}
