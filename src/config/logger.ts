/**
 * Kâtip - Logger Configuration
 * Pino logger with pretty printing for development
 */

import pino from "pino";
import { env } from "./env";

const isDevelopment = env.NODE_ENV === "development";

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: isDevelopment
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss Z",
          ignore: "pid,hostname",
        },
      }
    : undefined,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: "katip",
    version: "0.1.0",
  },
});

// Child loggers for different modules
export const createModuleLogger = (module: string) => {
  return logger.child({ module });
};

export const auditLogger = createModuleLogger("audit");
export const aiLogger = createModuleLogger("ai");
export const dbLogger = createModuleLogger("db");
export const queueLogger = createModuleLogger("queue");
export const privacyLogger = createModuleLogger("privacy");