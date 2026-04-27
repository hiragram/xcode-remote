import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.XCODE_REMOTE_HOST;
    delete process.env.XCODE_REMOTE_PORT;
    delete process.env.XCODE_REMOTE_MAX_CONCURRENCY;
    delete process.env.XCODE_REMOTE_ALLOWED_PATHS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns default values when no env vars are set", () => {
    const config = loadConfig();
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 19418);
    assert.equal(config.maxConcurrency, 1);
    assert.equal(config.allowedPaths, undefined);
  });

  it("reads XCODE_REMOTE_HOST", () => {
    process.env.XCODE_REMOTE_HOST = "127.0.0.1";
    const config = loadConfig();
    assert.equal(config.host, "127.0.0.1");
  });

  it("reads XCODE_REMOTE_PORT", () => {
    process.env.XCODE_REMOTE_PORT = "8080";
    const config = loadConfig();
    assert.equal(config.port, 8080);
  });

  it("reads XCODE_REMOTE_MAX_CONCURRENCY", () => {
    process.env.XCODE_REMOTE_MAX_CONCURRENCY = "4";
    const config = loadConfig();
    assert.equal(config.maxConcurrency, 4);
  });

  it("reads XCODE_REMOTE_ALLOWED_PATHS as comma-separated list", () => {
    process.env.XCODE_REMOTE_ALLOWED_PATHS =
      "/Users/foo/Projects, /Users/bar/Dev";
    const config = loadConfig();
    assert.deepEqual(config.allowedPaths, [
      "/Users/foo/Projects",
      "/Users/bar/Dev",
    ]);
  });

  it("trims whitespace from allowed paths", () => {
    process.env.XCODE_REMOTE_ALLOWED_PATHS = "  /a , /b  ,  /c  ";
    const config = loadConfig();
    assert.deepEqual(config.allowedPaths, ["/a", "/b", "/c"]);
  });

  it("filters empty entries from allowed paths", () => {
    process.env.XCODE_REMOTE_ALLOWED_PATHS = "/a,,/b,,,/c";
    const config = loadConfig();
    assert.deepEqual(config.allowedPaths, ["/a", "/b", "/c"]);
  });
});
