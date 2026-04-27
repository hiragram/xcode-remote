import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDaemonServer } from "../src/server.js";
import { JobQueue } from "../src/queue/job-queue.js";
import type { Config } from "../src/config.js";

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    host: "127.0.0.1",
    port: 0, // random port
    maxConcurrency: 1,
    ...overrides,
  };
}

function getBaseUrl(server: Server): string {
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

describe("HTTP Server", () => {
  let server: Server;
  let baseUrl: string;
  let queue: JobQueue;

  beforeEach(async () => {
    const config = makeConfig();
    queue = new JobQueue(config.maxConcurrency, undefined, "echo");
    server = createDaemonServer(queue, config);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = getBaseUrl(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  describe("GET /health", () => {
    it("returns 200 with queue status", async () => {
      const res = await fetch(`${baseUrl}/health`);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.version, "0.1.0");
      assert.equal(body.queue.running, 0);
      assert.equal(body.queue.queued, 0);
      assert.equal(body.queue.maxConcurrency, 1);
    });

    it("reflects queue state in health response", async () => {
      // Submit a job to the queue (echo is fast so we need bash + sleep)
      const bashQueue = new JobQueue(1, undefined, "bash");
      const bashConfig = makeConfig();
      const bashServer = createDaemonServer(bashQueue, bashConfig);

      await new Promise<void>((resolve) => {
        bashServer.listen(0, "127.0.0.1", resolve);
      });
      const bashBaseUrl = getBaseUrl(bashServer);

      bashQueue.submit(["-c", "sleep 5"]);
      bashQueue.submit(["-c", "echo queued"]);

      const res = await fetch(`${bashBaseUrl}/health`);
      const body = await res.json();

      assert.equal(body.queue.running, 1);
      assert.equal(body.queue.queued, 1);

      await new Promise<void>((resolve, reject) => {
        bashServer.close((err) => (err ? reject(err) : resolve()));
      });
    });
  });

  describe("Unknown routes", () => {
    it("returns 404 for unknown path", async () => {
      const res = await fetch(`${baseUrl}/nonexistent`);
      assert.equal(res.status, 404);
    });

    it("returns 404 for root path", async () => {
      const res = await fetch(`${baseUrl}/`);
      assert.equal(res.status, 404);
    });
  });

  describe("POST /mcp", () => {
    it("returns 400 for non-initialize request without session ID", async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.jsonrpc, "2.0");
      assert.ok(body.error);
    });

    it("handles MCP initialize request and returns session ID", async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: {
              name: "test-client",
              version: "1.0.0",
            },
          },
        }),
      });

      // Should succeed
      assert.ok(res.status === 200 || res.status === 202, `Got status ${res.status}`);

      // Should have a session ID in the response header
      const sessionId = res.headers.get("mcp-session-id");
      assert.ok(sessionId, "Expected mcp-session-id header");
    });

    it("accepts subsequent requests with valid session ID", async () => {
      // First, initialize
      const initRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        }),
      });

      const sessionId = initRes.headers.get("mcp-session-id");
      assert.ok(sessionId);

      // Consume the init response body
      await initRes.text();

      // Send initialized notification
      const notifRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
      assert.ok(
        notifRes.status === 200 || notifRes.status === 202,
        `Notification got ${notifRes.status}`,
      );
      await notifRes.text();

      // Now list tools
      const toolsRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });

      assert.ok(
        toolsRes.status === 200 || toolsRes.status === 202,
        `tools/list got ${toolsRes.status}`,
      );

      const toolsBody = await toolsRes.text();
      // Should contain our tool names
      assert.match(toolsBody, /run_xcodebuild/);
      assert.match(toolsBody, /get_job/);
      assert.match(toolsBody, /list_jobs/);
      assert.match(toolsBody, /cancel_job/);
    });

    it("returns 400 for requests with invalid session ID", async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "invalid-session-id",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });

      assert.equal(res.status, 400);
    });
  });

  describe("GET /mcp", () => {
    it("returns 400 without session ID", async () => {
      const res = await fetch(`${baseUrl}/mcp`);
      assert.equal(res.status, 400);
    });

    it("returns 400 with invalid session ID", async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        headers: { "mcp-session-id": "nonexistent" },
      });
      assert.equal(res.status, 400);
    });
  });

  describe("DELETE /mcp", () => {
    it("returns 400 without session ID", async () => {
      const res = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });
      assert.equal(res.status, 400);
    });
  });

  describe("PUT /mcp", () => {
    it("returns 405 Method Not Allowed", async () => {
      const res = await fetch(`${baseUrl}/mcp`, { method: "PUT" });
      assert.equal(res.status, 405);
    });
  });
});
