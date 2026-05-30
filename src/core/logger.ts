import { config } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: string;
  data?: Record<string, unknown>;
  requestId?: string;
}

export class Logger {
  private minLevel: LogLevel;
  private context?: string;
  private requestId?: string;
  private format: LogFormat;

  constructor(level: LogLevel = 'info', context?: string, format?: LogFormat, requestId?: string) {
    this.minLevel = level;
    this.context = context;
    this.requestId = requestId;
    this.format = format ?? (config.logFormat === 'json' ? 'json' : 'text');
  }

  withRequestId(requestId: string): Logger {
    return new Logger(this.minLevel, this.context, this.format, requestId);
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private formatEntry(entry: LogEntry): string {
    if (this.format === 'json') {
      return this.formatJson(entry);
    }
    return this.formatText(entry);
  }

  private formatText(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const pad = (str: string): string => str.padStart(5, ' ');
    const colorCode = (
      entry.level === 'error' ? '\x1b[31m' :
      entry.level === 'warn' ? '\x1b[33m' :
      entry.level === 'debug' ? '\x1b[36m' : ''
    );
    const reset = '\x1b[0m';

    const coloredLevel = colorCode + pad(entry.level.toUpperCase()) + reset;
    const contextPart = entry.context ? ` [${entry.context}]` : '';

    let output = `${timestamp} ${coloredLevel}${contextPart} ${entry.message}`;

    if (entry.data) {
      output += '\n' + JSON.stringify(entry.data, null, 2);
    }

    return output;
  }

  private formatJson(entry: LogEntry): string {
    const obj: Record<string, unknown> = {
      timestamp: entry.timestamp.toISOString(),
      level: entry.level.toUpperCase(),
      message: entry.message,
    };
    if (entry.context) {
      obj.module = entry.context;
    }
    if (entry.requestId || this.requestId) {
      obj.request_id = entry.requestId ?? this.requestId;
    }
    if (entry.data) {
      obj.data = entry.data;
    }
    return JSON.stringify(obj);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatEntry({
        timestamp: new Date(),
        level: 'debug',
        message,
        context: this.context,
        requestId: this.requestId,
        data,
      }));
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      console.log(this.formatEntry({
        timestamp: new Date(),
        level: 'info',
        message,
        context: this.context,
        requestId: this.requestId,
        data,
      }));
    }
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatEntry({
        timestamp: new Date(),
        level: 'warn',
        message,
        context: this.context,
        requestId: this.requestId,
        data,
      }));
    }
  }

  error(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      console.error(this.formatEntry({
        timestamp: new Date(),
        level: 'error',
        message,
        context: this.context,
        requestId: this.requestId,
        data,
      }));
    }
  }

  child(context: string): Logger {
    return new Logger(this.minLevel, this.context ? `${this.context}.${context}` : context);
  }
}

export const logger = new Logger('info');
