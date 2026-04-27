import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import type { JobQueue } from "./queue/job-queue.js";
import { registerRunXcodebuildTool } from "./tools/run-xcodebuild.js";
import { registerRunXcodegenTool } from "./tools/run-xcodegen.js";
import { logger } from "./logger.js";

export interface ServerOptions {
  xcodegenCommand?: string;
}

function createMcpServer(
  queue: JobQueue,
  options?: ServerOptions,
): McpServer {
  const server = new McpServer({
    name: "xcode-remote",
    version: "0.1.0",
  });

  registerRunXcodebuildTool(server, queue);
  registerRunXcodegenTool(server, queue, options?.xcodegenCommand);

  return server;
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        resolve(body);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function createDaemonServer(
  queue: JobQueue,
  config: Config,
  options?: ServerOptions,
) {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Health check
    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        version: "0.1.0",
        queue: {
          running: queue.runningCount,
          queued: queue.queuedCount,
          maxConcurrency: config.maxConcurrency,
        },
      });
      return;
    }

    // MCP Streamable HTTP
    if (pathname === "/mcp") {
      try {
        if (req.method === "POST") {
          const body = await parseBody(req);
          const sessionId = req.headers["mcp-session-id"] as string | undefined;

          if (sessionId && transports.has(sessionId)) {
            const transport = transports.get(sessionId)!;
            await transport.handleRequest(req, res, body);
          } else if (!sessionId && isInitializeRequest(body)) {
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                transports.set(sid, transport);
              },
            });

            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid) {
                transports.delete(sid);
                logger.info(`[mcp] session closed sid=${sid}`);
              }
            };

            const mcpServer = createMcpServer(queue, options);
            await mcpServer.connect(transport);
            logger.info(`[mcp] session initialized sid=${transport.sessionId}`);
            await transport.handleRequest(req, res, body);
          } else {
            sendJson(res, 400, {
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Bad Request: No valid session ID provided",
              },
              id: null,
            });
          }
        } else if (req.method === "GET") {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (!sessionId || !transports.has(sessionId)) {
            res.writeHead(400);
            res.end("Invalid or missing session ID");
            return;
          }
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res);
        } else if (req.method === "DELETE") {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (!sessionId || !transports.has(sessionId)) {
            res.writeHead(400);
            res.end("Invalid or missing session ID");
            return;
          }
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res);
        } else {
          res.writeHead(405);
          res.end("Method Not Allowed");
        }
      } catch (error) {
        logger.error(`[mcp] request error: ${error}`);
        if (!res.headersSent) {
          sendJson(res, 500, {
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
      return;
    }

    // 404
    res.writeHead(404);
    res.end("Not Found");
  });

  // Expose a graceful shutdown helper on the server instance
  (server as any).shutdownTransports = async () => {
    for (const [sid, transport] of transports) {
      try {
        await transport.close();
      } catch (error) {
        logger.error(`[mcp] error closing session ${sid}: ${error}`);
      }
    }
    transports.clear();
  };

  return server;
}
