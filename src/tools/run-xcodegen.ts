import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JobQueue } from "../queue/job-queue.js";
import { logger } from "../logger.js";
import { trimLog } from "./utils.js";

export function registerRunXcodegenTool(
  server: McpServer,
  queue: JobQueue,
  commandOverride?: string,
): void {
  const command = commandOverride ?? "xcodegen";
  server.registerTool(
    "run_xcodegen",
    {
      title: "Run xcodegen",
      description:
        "Execute xcodegen with the given arguments on the Mac host. " +
        "The command is queued and executed when a slot is available. " +
        "Returns stdout/stderr and exit code.",
      inputSchema: {
        args: z
          .array(z.string())
          .describe(
            'Arguments to pass to xcodegen (e.g. ["generate", "--spec", "project.yml"])',
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory for xcodegen execution"),
      },
    },
    async ({ args, workingDirectory }) => {
      logger.info(
        `[tool:run_xcodegen] args=${JSON.stringify(args)}${workingDirectory ? ` cwd=${workingDirectory}` : ""}`,
      );
      try {
        const { jobId, completion } = queue.submit(
          args,
          workingDirectory,
          command,
        );
        const result = await completion;
        const trimmedLog = trimLog(result.log);
        const success = result.exitCode === 0;

        logger.info(
          `[tool:run_xcodegen] ${jobId} finished exit=${result.exitCode}`,
        );

        const text = [
          success ? "xcodegen SUCCEEDED" : "xcodegen FAILED",
          `Job ID: ${jobId}`,
          `Exit code: ${result.exitCode}`,
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
          `[tool:run_xcodegen] submit failed: ${error instanceof Error ? error.message : String(error)}`,
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
}
