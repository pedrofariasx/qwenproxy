import "dotenv/config";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * TOOLCALL_DEBUG levels:
 *   "0" or undefined = disabled
 *   "1" = full debug (all toolcall logs)
 *   "errors" = only on errors (log toolcall details when parser/execution fails)
 */
export type ToolcallDebugLevel = "0" | "1" | "errors";

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: string;
  data?: Record<string, unknown>;
}

export class Logger {
  private minLevel: LogLevel;
  private context?: string;

  constructor(level: LogLevel = "info", context?: string) {
    this.minLevel = level;
    this.context = context;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private formatEntry(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const pad = (str: string): string => str.padStart(5, " ");
    const colorCode =
      entry.level === "error"
        ? "\x1b[31m"
        : entry.level === "warn"
          ? "\x1b[33m"
          : entry.level === "debug"
            ? "\x1b[36m"
            : "";
    const reset = "\x1b[0m";

    const coloredLevel = colorCode + pad(entry.level.toUpperCase()) + reset;
    const contextPart = entry.context ? ` [${entry.context}]` : "";

    let output = `${timestamp} ${coloredLevel}${contextPart} ${entry.message}`;

    if (entry.data) {
      output += "\n" + JSON.stringify(entry.data, null, 2);
    }

    return output;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("debug")) {
      console.log(
        this.formatEntry({
          timestamp: new Date(),
          level: "debug",
          message: this.context ? `[${this.context}] ${message}` : message,
          data,
        }),
      );
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("info")) {
      console.log(
        this.formatEntry({
          timestamp: new Date(),
          level: "info",
          message: this.context ? `[${this.context}] ${message}` : message,
          data,
        }),
      );
    }
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("warn")) {
      console.warn(
        this.formatEntry({
          timestamp: new Date(),
          level: "warn",
          message: this.context ? `[${this.context}] ${message}` : message,
          data,
        }),
      );
    }
  }

  error(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("error")) {
      console.error(
        this.formatEntry({
          timestamp: new Date(),
          level: "error",
          message: this.context ? `[${this.context}] ${message}` : message,
          data,
        }),
      );
    }
  }

  child(context: string): Logger {
    return new Logger(
      this.minLevel,
      this.context ? `${this.context}.${context}` : context,
    );
  }
}

// Determine initial log level from environment
const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
const toolcallDebugEnv = process.env.TOOLCALL_DEBUG || "0";

export const toolcallDebugLevel: ToolcallDebugLevel =
  toolcallDebugEnv === "1"
    ? "1"
    : toolcallDebugEnv === "errors"
      ? "errors"
      : "0";

const initialLevel: LogLevel =
  toolcallDebugLevel === "1"
    ? "debug"
    : envLevel && ["debug", "info", "warn", "error"].includes(envLevel)
      ? envLevel
      : "info";

export const logger = new Logger(initialLevel);

// Helper to check if toolcall debug is enabled
export function isToolcallDebugEnabled(): boolean {
  return toolcallDebugLevel === "1";
}

export function isToolcallErrorDebugEnabled(): boolean {
  return toolcallDebugLevel === "1" || toolcallDebugLevel === "errors";
}

// Confirm debug mode on startup
if (toolcallDebugLevel === "1") {
  logger.info("[logger] TOOLCALL_DEBUG=1 - full debug logs active");
} else if (toolcallDebugLevel === "errors") {
  logger.info("[logger] TOOLCALL_DEBUG=errors - toolcall logs on errors only");
}
