type LogLevel = "info" | "warn" | "error";

function timestamp(): string {
  return new Date().toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });
}

function format(level: LogLevel, message: string): string {
  return `[${timestamp()}] ${level.toUpperCase()} ${message}`;
}

export const logger = {
  info(message: string): void {
    console.log(format("info", message));
  },
  warn(message: string): void {
    console.warn(format("warn", message));
  },
  error(message: string): void {
    console.error(format("error", message));
  },
};
