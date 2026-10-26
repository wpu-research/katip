/**
 * Kâtip - Main Entry Point
 * Fastify server with all department agents
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { katipCore } from "./core/katip-core";
import { prisma } from "./config/db";

// Route handlers
async function routes(fastify: any) {
  // Health check
  fastify.get("/health", async () => ({ status: "ok", service: "katip", version: "0.1.0" }));

  // Privacy shield health
  fastify.get("/health/privacy", async () => {
    return await (await import("./privacy/shield")).privacyShield.healthCheck();
  });

  // Main AI endpoint - route to departments
  fastify.post<{
    Body: { input: string; caseId?: string; sensitivityLevel?: "L1_NORMAL" | "L2_SENSITIVE" | "L3_HIGHLY_CONFIDENTIAL" };
  }>("/api/ai/process", async (request, reply) => {
    const { input, caseId, sensitivityLevel = "L1_NORMAL" } = request.body;

    if (!input) {
      return reply.code(400).send({ error: "input gerekli" });
    }

    // Get user from auth (mock for now)
    const userId = request.headers["x-user-id"] || "demo-user";
    const lawFirmId = request.headers["x-law-firm-id"] || "demo-firm";

    const context = {
      caseId,
      lawFirmId,
      userId,
      sensitivityLevel,
      metadata: {},
    };

    const result = await katipCore.execute(input, context);
    return result;
  });

  // Routing only (for debugging)
  fastify.post<{
    Body: { input: string; caseId?: string };
  }>("/api/ai/route", async (request, reply) => {
    const { input, caseId } = request.body;
    const context = { caseId, lawFirmId: "demo-firm", userId: "demo-user", sensitivityLevel: "L1_NORMAL" as const, metadata: {} };
    const routing = await katipCore.route(input, context);
    return routing;
  });

  // Daily briefing
  fastify.get<{
    Querystring: { lawFirmId?: string; date?: string };
  }>("/api/briefing/daily", async (request, reply) => {
    const { lawFirmId = "demo-firm", date } = request.query;
    const briefing = await katipCore.generateDailyBriefing(lawFirmId, date ? new Date(date) : new Date());
    return briefing;
  });

  // Department list
  fastify.get("/api/departments", async () => {
    return katipCore.listDepartments().map(d => ({
      type: d.type,
      name: d.name,
      description: d.description,
      model: d.modelConfig.model,
      effort: d.modelConfig.effort,
    }));
  });

  // Case management
  fastify.post<{
    Body: { clientName: string; clientType: string; taxId: string; caseType: string; summary: string; opposingParties?: string[] };
  }>("/api/cases", async (request, reply) => {
    const { clientName, clientType, taxId, caseType, summary, opposingParties } = request.body;
    const lawFirmId = request.headers["x-law-firm-id"] || "demo-firm";
    const userId = request.headers["x-user-id"] || "demo-user";

    const client = await prisma.client.create({
      data: { lawFirmId, name: clientName, type: clientType, taxId, sensitivityLevel: "L1_NORMAL" },
    });

    const caseNumber = `${new Date().getFullYear()}/${String(await prisma.case.count({ where: { lawFirmId } }) + 1).padStart(5, "0")}`;

    const newCase = await prisma.case.create({
      data: {
        lawFirmId,
        clientId: client.id,
        creatorId: userId,
        caseNumber,
        caseType: caseType as any,
        description: summary,
        sensitivityLevel: "L1_NORMAL",
        status: "OPEN",
      },
    });

    return { case: newCase, client };
  });

  fastify.get<{ Params: { id: string } }>("/api/cases/:id", async (request, reply) => {
    const { id } = request.params;
    const lawFirmId = request.headers["x-law-firm-id"] || "demo-firm";

    const caseData = await prisma.case.findFirst({
      where: { id, lawFirmId },
      include: {
        client: true,
        lawyers: { include: { user: true } },
        parties: true,
        documents: { orderBy: { createdAt: "desc" }, take: 20 },
        hearings: { orderBy: { hearingDate: "asc" } },
        deadlines: { orderBy: { dueDate: "asc" } },
        timeEntries: { orderBy: { date: "desc" }, take: 50 },
        petitions: { orderBy: { createdAt: "desc" } },
        invoices: { orderBy: { issueDate: "desc" } },
        researchMemos: { orderBy: { createdAt: "desc" } },
      },
    });

    if (!caseData) {
      return reply.code(404).send({ error: "Dosya bulunamadı" });
    }
    return caseData;
  });

  // Approvals
  fastify.get<{ Querystring: { status?: string } }>("/api/approvals", async (request, reply) => {
    const { status } = request.query;
    const userId = request.headers["x-user-id"] || "demo-user";

    const approvals = await prisma.approval.findMany({
      where: { approverId: userId, status: status as any || "PENDING" },
      include: { requestedBy: true },
      orderBy: { requestedAt: "desc" },
    });
    return approvals;
  });

  fastify.post<{ Params: { id: string }; Body: { action: "APPROVE" | "REJECT" | "CHANGES_REQUESTED"; comments?: string } }>(
    "/api/approvals/:id/respond",
    async (request, reply) => {
      const { id } = request.params;
      const { action, comments } = request.body;
      const userId = request.headers["x-user-id"] || "demo-user";

      const approval = await prisma.approval.update({
        where: { id },
        data: { status: action, respondedAt: new Date(), approverId: userId, comments },
      });
      return approval;
    }
  );

  // Time entries - daily approval screen
  fastify.get<{ Querystring: { date?: string } }>("/api/time-entries/daily", async (request, reply) => {
    const { date } = request.query;
    const userId = request.headers["x-user-id"] || "demo-user";
    const targetDate = date ? new Date(date) : new Date();

    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const entries = await prisma.timeEntry.findMany({
      where: { userId, date: { gte: startOfDay, lte: endOfDay }, status: "PENDING" },
      include: { case: { include: { client: true } } },
      orderBy: { date: "asc" },
    });

    return entries;
  });

  fastify.post<{ Body: { entryIds: string[]; action: "approve" | "reject" | "modify"; modifications?: any[] } }>(
    "/api/time-entries/bulk",
    async (request, reply) => {
      const { entryIds, action, modifications } = request.body;
      const userId = request.headers["x-user-id"] || "demo-user";

      if (action === "approve") {
        await prisma.timeEntry.updateMany({
          where: { id: { in: entryIds } },
          data: { status: "APPROVED", approvedAt: new Date(), approvedById: userId },
        });
      } else if (action === "reject") {
        await prisma.timeEntry.updateMany({
          where: { id: { in: entryIds } },
          data: { status: "REJECTED" },
        });
      } else if (action === "modify" && modifications) {
        for (const mod of modifications) {
          await prisma.timeEntry.update({
            where: { id: mod.id },
            data: { durationMinutes: mod.durationMinutes, description: mod.description, isBillable: mod.isBillable },
          });
        }
      }

      return { updated: entryIds.length };
    }
  );

  // Documents
  fastify.get<{ Querystring: { caseId?: string; type?: string } }>("/api/documents", async (request, reply) => {
    const { caseId, type } = request.query;
    const lawFirmId = request.headers["x-law-firm-id"] || "demo-firm";

    const documents = await prisma.document.findMany({
      where: { lawFirmId, caseId: caseId as string, type: type as any },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return documents;
  });

  // Invoices
  fastify.get<{ Querystring: { caseId?: string; status?: string } }>("/api/invoices", async (request, reply) => {
    const { caseId, status } = request.query;
    const lawFirmId = request.headers["x-law-firm-id"] || "demo-firm";

    const invoices = await prisma.invoice.findMany({
      where: { lawFirmId, caseId: caseId as string, status: status as any },
      include: { client: true, case: true, items: true },
      orderBy: { issueDate: "desc" },
    });
    return invoices;
  });

  // Conflict checks
  fastify.post<{
    Body: { caseId: string; taxIds: string[]; names: string[] };
  }>("/api/conflict-check", async (request, reply) => {
    const { caseId, taxIds, names } = request.body;
    const lawFirmId = request.headers["x-law-firm-id"] || "demo-firm";
    const userId = request.headers["x-user-id"] || "demo-user";

    const dept = katipCore.getDepartment("CONFLICT_POWER_OF_ATTORNEY");
    if (!dept) return reply.code(500).send({ error: "Departman bulunamadı" });

    // Use the conflict check tool directly
    const result = await (dept as any).tools[0].execute({ taxIds, names, caseId }, { lawFirmId, userId, sensitivityLevel: "L1_NORMAL", metadata: {} });
    return result;
  });

  // Research memos
  fastify.get<{ Querystring: { caseId?: string } }>("/api/research", async (request, reply) => {
    const { caseId } = request.query;
    const lawFirmId = request.headers["x-law-firm-id"] || "demo-firm";

    const memos = await prisma.researchMemo.findMany({
      where: { caseId: caseId as string, case: { lawFirmId } },
      include: { createdBy: true, documents: { include: { document: true } } },
      orderBy: { createdAt: "desc" },
    });
    return memos;
  });

  // Petitions
  fastify.get<{ Querystring: { caseId?: string; status?: string } }>("/api/petitions", async (request, reply) => {
    const { caseId, status } = request.query;
    const lawFirmId = request.headers["x-law-firm-id"] || "demo-firm";

    const petitions = await prisma.petition.findMany({
      where: { caseId: caseId as string, case: { lawFirmId }, status: status as any },
      include: { reviewedBy: true, template: true },
      orderBy: { createdAt: "desc" },
    });
    return petitions;
  });

  // Notifications
  fastify.get<{ Querystring: { unreadOnly?: string } }>("/api/notifications", async (request, reply) => {
    const { unreadOnly } = request.query;
    const userId = request.headers["x-user-id"] || "demo-user";

    const notifications = await prisma.notification.findMany({
      where: { userId, isRead: unreadOnly === "true" ? false : undefined },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return notifications;
  });

  fastify.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (request, reply) => {
    const { id } = request.params;
    await prisma.notification.update({ where: { id }, data: { isRead: true, readAt: new Date() } });
    return { success: true };
  });
}

// Start server
async function start() {
  const fastify = Fastify({ logger: false });

  // Register plugins
  await fastify.register(cors, { origin: true });

  await fastify.register(swagger, {
    openapi: {
      info: { title: "Kâtip API", version: "0.1.0" },
    },
  });
  await fastify.register(swaggerUI, { routePrefix: "/docs" });

  // Register routes
  await fastify.register(routes);

  try {
    await fastify.listen({ port: env.PORT, host: env.HOST });
    logger.info({ port: env.PORT, host: env.HOST }, "Kâtip server started");
  } catch (err) {
    logger.error(err, "Server failed to start");
    process.exit(1);
  }
}

start();