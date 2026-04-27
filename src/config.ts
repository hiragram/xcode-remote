export interface Config {
  host: string;
  port: number;
  maxConcurrency: number;
  allowedPaths?: string[];
  idleTimeoutMs: number;
}

export function loadConfig(): Config {
  return {
    host: process.env.XCODE_REMOTE_HOST ?? "0.0.0.0",
    port: parseInt(process.env.XCODE_REMOTE_PORT ?? "19418", 10),
    maxConcurrency: parseInt(
      process.env.XCODE_REMOTE_MAX_CONCURRENCY ?? "1",
      10,
    ),
    allowedPaths: process.env.XCODE_REMOTE_ALLOWED_PATHS
      ?.split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    idleTimeoutMs: parseInt(
      process.env.XCODE_REMOTE_IDLE_TIMEOUT ?? "300",
      10,
    ) * 1000,
  };
}
