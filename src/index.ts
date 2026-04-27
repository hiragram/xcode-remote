import { loadConfig } from "./config.js";
import { createDaemonServer } from "./server.js";
import { JobQueue } from "./queue/job-queue.js";

const config = loadConfig();
const queue = new JobQueue(
  config.maxConcurrency,
  config.allowedPaths,
  undefined,
  config.idleTimeoutMs,
);
const server = createDaemonServer(queue, config);

server.listen(config.port, config.host, () => {
  console.log(
    `xcode-remote daemon listening on ${config.host}:${config.port}`,
  );
  console.log(`Max concurrency: ${config.maxConcurrency}`);
  console.log(`Idle timeout: ${config.idleTimeoutMs / 1000}s`);
  if (config.allowedPaths) {
    console.log(`Allowed paths: ${config.allowedPaths.join(", ")}`);
  }
  console.log(`MCP endpoint: http://${config.host}:${config.port}/mcp`);
  console.log(`Health check: http://${config.host}:${config.port}/health`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down...");
  await (server as any).shutdownTransports?.();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
