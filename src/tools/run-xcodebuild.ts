import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JobQueue } from "../queue/job-queue.js";
import { logger } from "../logger.js";
import { trimLog } from "./utils.js";

export function registerRunXcodebuildTool(
  server: McpServer,
  queue: JobQueue,
): void {
  server.registerTool(
    "run_xcodebuild",
    {
      title: "Run xcodebuild",
      description:
        "Execute xcodebuild with the given arguments on the Mac host. " +
        "The command is queued and executed when a slot is available. " +
        "Returns stdout/stderr and exit code.",
      inputSchema: {
        args: z
          .array(z.string())
          .describe(
            'Arguments to pass to xcodebuild (e.g. ["-workspace", "MyApp.xcworkspace", "-scheme", "MyApp", "build"])',
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory for xcodebuild execution"),
      },
    },
    async ({ args, workingDirectory }) => {
      logger.info(
        `[tool:run_xcodebuild] args=${JSON.stringify(args)}${workingDirectory ? ` cwd=${workingDirectory}` : ""}`,
      );
      try {
        const { jobId, completion } = queue.submit(args, workingDirectory);
        const result = await completion;
        const trimmedLog = trimLog(result.log);
        const success = result.exitCode === 0;

        logger.info(
          `[tool:run_xcodebuild] ${jobId} finished exit=${result.exitCode} reason=${result.reason}`,
        );

        const reasonLabels: Record<string, string> = {
          completed: "xcodebuild SUCCEEDED",
          error: "xcodebuild FAILED",
          cancelled: "xcodebuild CANCELLED (by user request)",
          idle_timeout: "xcodebuild KILLED (idle timeout — process produced no output)",
          test_crash_loop: "xcodebuild KILLED (test runner crash loop detected)",
        };
        const header = reasonLabels[result.reason] ?? "xcodebuild FAILED";

        const text = [
          header,
          `Job ID: ${jobId}`,
          `Exit code: ${result.exitCode}`,
          `Reason: ${result.reason}`,
          "",
          "--- Output ---",
          trimmedLog,
        ].join("\n");

        return {
          content: [{ type: "text" as const, text }],
          isError: !success,
        };
      } catch (error) {
        logger.error(
          `[tool:run_xcodebuild] submit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to submit job: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get Job Status",
      description:
        "Get the status and log of a previously submitted xcodebuild job.",
      inputSchema: {
        jobId: z.string().describe("The job ID returned from run_xcodebuild"),
      },
    },
    async ({ jobId }) => {
      logger.info(`[tool:get_job] jobId=${jobId}`);
      const job = queue.getJob(jobId);
      if (!job) {
        return {
          content: [
            { type: "text" as const, text: `Job not found: ${jobId}` },
          ],
          isError: true,
        };
      }

      const parts = [
        `Job ID: ${job.id}`,
        `Command: ${job.command}`,
        `Status: ${job.status}`,
        `Args: ${job.args.join(" ")}`,
        `Created: ${job.createdAt}`,
        job.startedAt ? `Started: ${job.startedAt}` : null,
        job.completedAt ? `Completed: ${job.completedAt}` : null,
        job.exitCode !== undefined ? `Exit code: ${job.exitCode}` : null,
        job.error ? `Error: ${job.error}` : null,
        "",
        "--- Log ---",
        trimLog(job.log),
      ]
        .filter((line) => line !== null)
        .join("\n");

      return {
        content: [{ type: "text" as const, text: parts }],
      };
    },
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List Jobs",
      description: "List all xcodebuild jobs, optionally filtered by status.",
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe(
            'Comma-separated status filter (e.g. "queued,running")',
          ),
      },
    },
    async ({ status }) => {
      logger.info(`[tool:list_jobs] status=${status ?? "all"}`);
      const statusFilter = status
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const jobs = queue.listJobs(statusFilter);

      if (jobs.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No jobs found." }],
        };
      }

      const lines = jobs.map(
        (j) =>
          `[${j.status.toUpperCase()}] ${j.id} - ${j.command} ${j.args.join(" ")} (${j.createdAt})`,
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel Job",
      description: "Cancel a queued or running xcodebuild job.",
      inputSchema: {
        jobId: z.string().describe("The job ID to cancel"),
      },
    },
    async ({ jobId }) => {
      logger.info(`[tool:cancel_job] jobId=${jobId}`);
      const success = queue.cancelJob(jobId);
      if (success) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Job ${jobId} has been cancelled.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Could not cancel job ${jobId}. It may not exist or is already completed.`,
          },
        ],
        isError: true,
      };
    },
  );
}
