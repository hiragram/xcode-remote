const MAX_LOG_LINES = 500;

export function trimLog(log: string): string {
  const lines = log.split("\n");
  if (lines.length <= MAX_LOG_LINES) {
    return log;
  }
  return (
    `... (${lines.length - MAX_LOG_LINES} lines omitted) ...\n` +
    lines.slice(-MAX_LOG_LINES).join("\n")
  );
}
