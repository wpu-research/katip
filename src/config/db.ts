/**
 * Kâtip - Database Client
 * Prisma client with extensions for pgvector and audit logging
 */

import { PrismaClient } from "@prisma/client";
import { env } from "./env";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: env.NODE_ENV === "development"
    ? ["query", "error", "warn"]
    : ["error"],
  datasources: {
    db: {
      url: env.DATABASE_URL,
    },
  },
});

// Extension for vector operations and audit logging
export const prismaWithExtensions = prisma.$extends({
  name: "katip-extensions",
  query: {
    $allModels: {
      async $allOperations({ operation, args, query }) {
        // Add audit logging for mutations
        const isMutation = ["create", "update", "delete", "upsert"].some((op) => operation.startsWith(op));

        const result = await query(args);

        if (isMutation && env.NODE_ENV !== "test") {
          // Audit logging would go here
          // await auditLog(args.model, args.action, args.args, result);
        }

        return result;
      },
    },
  },
});

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;