# xcode-remote

An MCP server that lets Claude Code running inside a Docker container remotely execute `xcodebuild` on a Mac host.

## Why

When using Claude Code with `dangerously-skip-permissions` for autonomous iOS development, giving it full access to your Mac is risky. The solution: confine code editing to a Docker container (Linux) and only delegate build/test execution to the Mac host. xcode-remote bridges that gap.

```
[Docker Container]                       [Mac Host]

 Claude Code                    xcode-remote (MCP Server)
   ↕ HTTP                          ↕ spawn
   ↕ host.docker.internal:19418    xcodebuild
```

## Features

- **MCP Streamable HTTP** — Runs as a single-process MCP server. Claude Code connects directly over HTTP
- **Job queue** — In-memory FIFO queue with configurable concurrency limit to control machine load
- **Security** — Only `xcodebuild` can be executed. Uses `spawn` with array arguments (no shell), making command injection impossible. Optional path restriction
- **Simple** — Passes xcodebuild arguments through as-is and returns raw output. No parsing or transformation

## Setup

```bash
npm install
npm run build
npm start

# Development (hot reload)
npm run dev
```

## MCP Tools

### `run_xcodebuild`

Execute xcodebuild. The job is queued and runs when a slot becomes available. Returns stdout/stderr and exit code upon completion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `args` | `string[]` | Yes | Arguments passed to xcodebuild |
| `workingDirectory` | `string` | No | Working directory for execution |

```
args: ["-workspace", "MyApp.xcworkspace", "-scheme", "MyApp",
       "-destination", "platform=iOS Simulator,name=iPhone 16", "build"]
```

### `run_xcodegen`

Execute xcodegen. The job is queued and runs when a slot becomes available (shares the same queue as xcodebuild). Returns stdout/stderr and exit code upon completion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `args` | `string[]` | Yes | Arguments passed to xcodegen |
| `workingDirectory` | `string` | No | Working directory for execution |

```
args: ["generate", "--spec", "project.yml"]
```

### `get_job`

Get the status and log of a previously submitted job.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `jobId` | `string` | Yes | Job ID returned by `run_xcodebuild` or `run_xcodegen` |

### `list_jobs`

List all jobs, optionally filtered by status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | `string` | No | Comma-separated status filter (e.g. `"queued,running"`) |

### `cancel_job`

Cancel a queued or running job. Sends SIGTERM to running processes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `jobId` | `string` | Yes | Job ID to cancel |

## Usage with Docker

The intended setup is:

1. **Mac host** — runs xcode-remote (`npm start`)
2. **Docker container** — runs Claude Code with `--dangerously-skip-permissions`, connects to xcode-remote over HTTP

### 1. Start xcode-remote on the Mac host

```bash
cd /path/to/xcode-remote
npm start
```

### 2. Prepare a Dockerfile for Claude Code

Below is a minimal example. Adjust as needed for your project.

```dockerfile
FROM node:22-bookworm

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

# Set up a working directory for your iOS project source
WORKDIR /app

# Copy your project source (or mount as a volume at runtime)
# COPY . .

# Configure MCP: connect to xcode-remote on the Mac host
# Docker Desktop for Mac resolves host.docker.internal to the host machine
RUN mkdir -p /app/.mcp && echo '{ \
  "mcpServers": { \
    "xcode-remote": { \
      "type": "http", \
      "url": "http://host.docker.internal:19418/mcp" \
    } \
  } \
}' > /app/.mcp.json

ENTRYPOINT ["claude", "--dangerously-skip-permissions"]
```

### 3. Build and run the container

```bash
# Build the image
docker build -t claude-ios-dev .

# Run with your project source mounted
docker run -it --rm \
  -v /path/to/your/ios-project:/app \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  claude-ios-dev
```

**Key points:**

- **`host.docker.internal`** — Docker Desktop for Mac automatically resolves this to the host machine's IP. No extra flags needed.
- **Linux Docker** — If running Docker Engine on Linux (not Docker Desktop), add `--add-host=host.docker.internal:host-gateway` to `docker run`.
- **Volume mount** — Mount your iOS project source into the container so Claude Code can edit files. xcode-remote on the host can then build from the same path. Make sure the paths match — the `workingDirectory` parameter in `run_xcodebuild` refers to a path on the **Mac host**, not inside the container.

### Path mapping

Since the source files live on the Mac host and are mounted into Docker, the paths are different between the two environments:

| Context | Path |
|---------|------|
| Inside Docker | `/app/MyApp.xcworkspace` |
| On Mac host | `/path/to/your/ios-project/MyApp.xcworkspace` |

When calling `run_xcodebuild`, use the **Mac host path** for `workingDirectory` and project references, since xcodebuild runs on the host. If you mount your project at the same path on both sides (e.g. both use `/Users/you/Projects/MyApp`), no translation is needed.

Alternatively, you can keep it simple by not specifying `workingDirectory` and starting xcode-remote from your project directory:

```bash
cd /path/to/your/ios-project
npx xcode-remote  # or: node /path/to/xcode-remote/dist/index.js
```

### Verifying the connection

From inside the Docker container:

```bash
curl http://host.docker.internal:19418/health
```

If you see `{"ok":true,...}`, the connection is working.

## Connecting from Claude Code (without Docker)

For local use directly on the Mac, add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "xcode-remote": {
      "type": "http",
      "url": "http://localhost:19418/mcp"
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XCODE_REMOTE_HOST` | `0.0.0.0` | Bind host |
| `XCODE_REMOTE_PORT` | `19418` | Port |
| `XCODE_REMOTE_MAX_CONCURRENCY` | `1` | Max concurrent processes |
| `XCODE_REMOTE_ALLOWED_PATHS` | none | Comma-separated list of allowed working directories |
| `XCODE_REMOTE_IDLE_TIMEOUT` | `300` | Seconds of no output before killing a hung process |

## Health Check

```bash
curl http://localhost:19418/health
```

```json
{
  "ok": true,
  "version": "0.1.0",
  "queue": {
    "running": 0,
    "queued": 0,
    "maxConcurrency": 1
  }
}
```

## Tests

```bash
npm test
```

## Security

- The executed commands are hardcoded to `xcodebuild` and `xcodegen` — no other commands can be executed by MCP clients
- `child_process.spawn` is called with an array of arguments, bypassing the shell entirely — command injection is not possible
- Setting `XCODE_REMOTE_ALLOWED_PATHS` restricts execution to jobs under the specified directories
- The server binds to `0.0.0.0` by default — use a firewall or network configuration to prevent external access
