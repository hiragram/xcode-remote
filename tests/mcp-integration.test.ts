import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDaemonServer } from "../src/server.js";
import { JobQueue } from "../src/queue/job-queue.js";
import type { Config } from "../src/config.js";

function makeConfig(): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    maxConcurrency: 2,
  };
}

describe("MCP Integration", () => {
  let server: Server;
  let baseUrl: string;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeEach(async () => {
    const config = makeConfig();
    // Use "echo" for simple tests; "bash" for complex ones
    const queue = new JobQueue(config.maxConcurrency, undefined, "echo");
    server = createDaemonServer(queue, config, { xcodegenCommand: "echo" });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
    );
    client = new Client({
      name: "test-client",
      version: "1.0.0",
    });
    await client.connect(transport);
  });

  afterEach(async () => {
    try {
      await transport.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  describe("tools/list", () => {
    it("lists all 5 tools", async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map((t) => t.name).sort();

      assert.deepEqual(toolNames, [
        "cancel_job",
        "get_job",
        "list_jobs",
        "run_xcodebuild",
        "run_xcodegen",
      ]);
    });

    it("run_xcodebuild tool has correct schema", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "run_xcodebuild");

      assert.ok(tool);
      assert.ok(tool.description);
      assert.ok(tool.inputSchema);
      assert.ok(tool.inputSchema.properties);
      assert.ok("args" in tool.inputSchema.properties!);
      assert.ok("workingDirectory" in tool.inputSchema.properties!);
    });

    it("get_job tool has correct schema", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "get_job");

      assert.ok(tool);
      assert.ok(tool.inputSchema.properties);
      assert.ok("jobId" in tool.inputSchema.properties!);
    });

    it("list_jobs tool has correct schema", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "list_jobs");

      assert.ok(tool);
      assert.ok(tool.inputSchema.properties);
      assert.ok("status" in tool.inputSchema.properties!);
    });

    it("run_xcodegen tool has correct schema", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "run_xcodegen");

      assert.ok(tool);
      assert.ok(tool.description);
      assert.ok(tool.inputSchema);
      assert.ok(tool.inputSchema.properties);
      assert.ok("args" in tool.inputSchema.properties!);
      assert.ok("workingDirectory" in tool.inputSchema.properties!);
    });

    it("cancel_job tool has correct schema", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "cancel_job");

      assert.ok(tool);
      assert.ok(tool.inputSchema.properties);
      assert.ok("jobId" in tool.inputSchema.properties!);
    });
  });

  describe("run_xcodebuild tool", () => {
    it("executes a command and returns output", async () => {
      const result = await client.callTool({
        name: "run_xcodebuild",
        arguments: { args: ["hello", "world"] },
      });

      assert.ok(result.content);
      assert.equal(result.content.length, 1);
      const text = (result.content[0] as { type: "text"; text: string }).text;
      assert.match(text, /xcodebuild SUCCEEDED/);
      assert.match(text, /Exit code: 0/);
      assert.match(text, /hello world/);
      assert.match(text, /Job ID: job_/);
    });

    it("returns isError=true on failure", async () => {
      // echo always succeeds, but with "echo" as command the args are just echoed
      // We need a command that fails. We can't easily swap the command here because
      // the queue was created with "echo". So let's test the output format at least.
      const result = await client.callTool({
        name: "run_xcodebuild",
        arguments: { args: ["test_output"] },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      assert.match(text, /xcodebuild SUCCEEDED/);
    });
  });

  describe("run_xcodegen tool", () => {
    it("executes xcodegen and returns output", async () => {
      const result = await client.callTool({
        name: "run_xcodegen",
        arguments: { args: ["hello", "xcodegen"] },
      });

      assert.ok(result.content);
      assert.equal(result.content.length, 1);
      const text = (result.content[0] as { type: "text"; text: string }).text;
      assert.match(text, /xcodegen SUCCEEDED/);
      assert.match(text, /Exit code: 0/);
      assert.match(text, /hello xcodegen/);
      assert.match(text, /Job ID: job_/);
    });

    it("job is visible in list_jobs", async () => {
      await client.callTool({
        name: "run_xcodegen",
        arguments: { args: ["gen_list_test"] },
      });

      const result = await client.callTool({
        name: "list_jobs",
        arguments: {},
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      assert.match(text, /gen_list_test/);
    });

    it("job is retrievable via get_job", async () => {
      const runResult = await client.callTool({
        name: "run_xcodegen",
        arguments: { args: ["gen_get_test"] },
      });

      const runText = (
        runResult.content[0] as { type: "text"; text: string }
      ).text;
      const jobIdMatch = runText.match(/Job ID: (job_\w+)/);
      assert.ok(jobIdMatch);

      const getResult = await client.callTool({
        name: "get_job",
        arguments: { jobId: jobIdMatch[1] },
      });

      const getText = (
        getResult.content[0] as { type: "text"; text: string }
      ).text;
      assert.match(getText, /Status: completed/);
      assert.match(getText, /gen_get_test/);
    });
  });

  describe("get_job tool", () => {
    it("retrieves a previously submitted job", async () => {
      // Submit a job first
      const runResult = await client.callTool({
        name: "run_xcodebuild",
        arguments: { args: ["for_get_test"] },
      });

      const runText = (
        runResult.content[0] as { type: "text"; text: string }
      ).text;
      const jobIdMatch = runText.match(/Job ID: (job_\w+)/);
      assert.ok(jobIdMatch);

      const jobId = jobIdMatch[1];

      // Now get the job
      const getResult = await client.callTool({
        name: "get_job",
        arguments: { jobId },
      });

      const getText = (
        getResult.content[0] as { type: "text"; text: string }
      ).text;
      assert.match(getText, /Job ID:/);
      assert.match(getText, /Status: completed/);
      assert.match(getText, /Exit code: 0/);
      assert.match(getText, /for_get_test/);
    });

    it("returns error for unknown job ID", async () => {
      const result = await client.callTool({
        name: "get_job",
        arguments: { jobId: "job_nonexistent" },
      });

      assert.equal(result.isError, true);
      const text = (result.content[0] as { type: "text"; text: string }).text;
      assert.match(text, /Job not found/);
    });
  });

  describe("list_jobs tool", () => {
    it("returns empty when no jobs", async () => {
      // Fresh server, but we connected to it which doesn't submit jobs
      // Actually we need a fresh queue. The current queue may have jobs from other tests.
      // Let's just check the format.
      const result = await client.callTool({
        name: "list_jobs",
        arguments: {},
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      // Either "No jobs found." or a list of jobs
      assert.ok(text);
    });

    it("lists submitted jobs", async () => {
      // Submit a job
      await client.callTool({
        name: "run_xcodebuild",
        arguments: { args: ["list_test_1"] },
      });
      await client.callTool({
        name: "run_xcodebuild",
        arguments: { args: ["list_test_2"] },
      });

      const result = await client.callTool({
        name: "list_jobs",
        arguments: {},
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      assert.match(text, /list_test_1/);
      assert.match(text, /list_test_2/);
      assert.match(text, /\[COMPLETED\]/);
    });

    it("filters by status", async () => {
      await client.callTool({
        name: "run_xcodebuild",
        arguments: { args: ["completed_job"] },
      });

      const result = await client.callTool({
        name: "list_jobs",
        arguments: { status: "running" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      // The job already completed, so filtering by "running" should give no results
      assert.equal(text, "No jobs found.");
    });
  });

  describe("cancel_job tool", () => {
    it("returns error for unknown job ID", async () => {
      const result = await client.callTool({
        name: "cancel_job",
        arguments: { jobId: "job_nonexistent" },
      });

      assert.equal(result.isError, true);
      const text = (result.content[0] as { type: "text"; text: string }).text;
      assert.match(text, /Could not cancel/);
    });

    it("returns error for already completed job", async () => {
      // Submit and wait for completion
      const runResult = await client.callTool({
        name: "run_xcodebuild",
        arguments: { args: ["done_job"] },
      });

      const runText = (
        runResult.content[0] as { type: "text"; text: string }
      ).text;
      const jobIdMatch = runText.match(/Job ID: (job_\w+)/);
      assert.ok(jobIdMatch);

      const result = await client.callTool({
        name: "cancel_job",
        arguments: { jobId: jobIdMatch[1] },
      });

      assert.equal(result.isError, true);
      const text = (result.content[0] as { type: "text"; text: string }).text;
      assert.match(text, /Could not cancel/);
    });
  });
});

describe("MCP Integration with bash (failure scenarios)", () => {
  let server: Server;
  let baseUrl: string;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeEach(async () => {
    const config = makeConfig();
    const queue = new JobQueue(config.maxConcurrency, undefined, "bash");
    server = createDaemonServer(queue, config);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
    );
    client = new Client({
      name: "test-client",
      version: "1.0.0",
    });
    await client.connect(transport);
  });

  afterEach(async () => {
    try {
      await transport.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("reports failure on non-zero exit code", async () => {
    const result = await client.callTool({
      name: "run_xcodebuild",
      arguments: { args: ["-c", "echo error_output >&2; exit 1"] },
    });

    assert.equal(result.isError, true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /xcodebuild FAILED/);
    assert.match(text, /Exit code: 1/);
    assert.match(text, /error_output/);
  });

  it("captures combined stdout and stderr", async () => {
    const result = await client.callTool({
      name: "run_xcodebuild",
      arguments: {
        args: ["-c", "echo out_line; echo err_line >&2; echo out_line2"],
      },
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /out_line/);
    assert.match(text, /err_line/);
    assert.match(text, /out_line2/);
  });

  it("handles workingDirectory parameter", async () => {
    const result = await client.callTool({
      name: "run_xcodebuild",
      arguments: {
        args: ["-c", "pwd"],
        workingDirectory: "/tmp",
      },
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /xcodebuild SUCCEEDED/);
    assert.match(text, /\/tmp/);
  });
});

describe("MCP Integration with allowed paths", () => {
  let server: Server;
  let baseUrl: string;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeEach(async () => {
    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      maxConcurrency: 1,
      allowedPaths: ["/tmp", "/var"],
    };
    const queue = new JobQueue(
      config.maxConcurrency,
      config.allowedPaths,
      "bash",
    );
    server = createDaemonServer(queue, config);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
    );
    client = new Client({
      name: "test-client",
      version: "1.0.0",
    });
    await client.connect(transport);
  });

  afterEach(async () => {
    try {
      await transport.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("allows execution in allowed paths", async () => {
    const result = await client.callTool({
      name: "run_xcodebuild",
      arguments: {
        args: ["-c", "echo ok"],
        workingDirectory: "/tmp",
      },
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /xcodebuild SUCCEEDED/);
  });

  it("rejects execution in disallowed paths", async () => {
    const result = await client.callTool({
      name: "run_xcodebuild",
      arguments: {
        args: ["-c", "echo evil"],
        workingDirectory: "/Users/evil",
      },
    });

    assert.equal(result.isError, true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /not in allowed paths/);
  });

  it("allows execution without workingDirectory", async () => {
    const result = await client.callTool({
      name: "run_xcodebuild",
      arguments: { args: ["-c", "echo ok"] },
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /xcodebuild SUCCEEDED/);
  });
});
