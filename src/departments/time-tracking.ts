/**
 * Kâtip - Time Tracking Department (Zaman Kaydı)
 * Model: Haiku 5.5, Effort: low
 * Handles: Email/meeting/approved draft/phone note -> case mapping, Kimai draft entries, 18:00 single screen approval
 */

import { logger } from "@/config/logger";
import { prisma } from "@/config/db";
import {
  DepartmentAgent,
  AgentContext,
  AgentResponse,
  AgentTool,
  DepartmentType,
} from "@/core/types";

export class TimeTrackingAgent implements DepartmentAgent {
  type: DepartmentType = "TIME_TRACKING";
  name = "Zaman Kaydı";
  description = "E-posta, toplantı, onaylı taslak, telefon notu → dosya eşleme, Kimai'ye taslak kayıt, 18:00 tek ekran onayla/düzelt";
  modelConfig = { model: "haiku-5.5" as const, effort: "low" as const };

  systemPrompt = `Sen bir hukuk bürosu zaman kayıt uzmanısın. Görevin:
1. E-posta, toplantı takvimi, onaylı dilekçe taslakları, telefon notları → ilgili dosyaya eşle
2. Kimai'ye taslak zaman kaydı oluştur, süre önerisi ver
3. Her gün 18:00'de tek ekranda: onayla / düzelt

KURALLAR:
- Model sadece EŞLER ve ÖNERİR, KARAR VERMEZ
- Avukat/stajyer 18:00'de tek tıkla onaylar
- "Kaçan faturalanabilir zaman" kaynağı: bu sistem
- Aktivite tipleri: meeting, drafting, research, court, phone, email, travel`;

  tools: AgentTool[] = [
    {
      name: "extract_activities",
      description: "Kaynaklardan (e-posta, takvim, dilekçe, telefon) aktiviteleri çıkar ve dosyaya eşle",
      inputSchema: {
        type: "object",
        properties: {
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["email", "calendar", "document", "phone", "manual"] },
                id: { type: "string" },
                content: { type: "string" },
                timestamp: { type: "string" },
                durationHint: { type: "number" }, // dakika
              },
            },
          },
          caseIds: { type: "array", items: { type: "string" } },
        },
        required: ["sources", "caseIds"],
      },
      execute: async (input, context) => {
        const activities = [];

        for (const source of input.sources) {
          // Match to case based on content keywords
          let matchedCaseId = null;
          let confidence = 0;

          for (const caseId of input.caseIds) {
            const caseData = await prisma.case.findUnique({
              where: { id: caseId },
              include: { client: true, parties: true },
            });

            if (!caseData) continue;

            const searchText = `${caseData.caseNumber} ${caseData.client.name} ${caseData.parties.map(p => p.name).join(" ")}`.toLowerCase();
            const sourceText = source.content.toLowerCase();

            // Simple keyword matching
            const keywords = searchText.split(" ").filter(w => w.length > 3);
            const matches = keywords.filter(k => sourceText.includes(k)).length;

            if (matches > confidence) {
              confidence = matches;
              matchedCaseId = caseId;
            }
          }

          if (matchedCaseId && confidence > 0) {
            // Determine activity type
            let activityType = "drafting";
            if (source.type === "email") activityType = "email";
            else if (source.type === "calendar") activityType = "meeting";
            else if (source.type === "document") activityType = "drafting";
            else if (source.type === "phone") activityType = "phone";

            // Estimate duration
            let duration = source.durationHint || 30;
            if (source.type === "calendar" && source.content.includes("30")) duration = 30;
            else if (source.type === "calendar" && source.content.includes("60")) duration = 60;
            else if (source.type === "document") duration = 45;
            else if (source.type === "phone") duration = 15;

            activities.push({
              caseId: matchedCaseId,
              activityType,
              description: this.summarizeActivity(source),
              durationMinutes: duration,
              source: source.type,
              sourceRef: source.id,
              confidence: Math.min(confidence / 10, 1),
              timestamp: new Date(source.timestamp),
            });
          }
        }

        return { activities };
      },
    },
    {
      name: "create_kimai_drafts",
      description: "Kimai'ye taslak zaman kayıtları oluştur",
      inputSchema: {
        type: "object",
        properties: {
          activities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                caseId: { type: "string" },
                activityType: { type: "string" },
                description: { type: "string" },
                durationMinutes: { type: "number" },
                source: { type: "string" },
                sourceRef: { type: "string" },
                timestamp: { type: "string" },
                confidence: { type: "number" },
              },
            },
          },
        },
        required: ["activities"],
      },
      execute: async (input, context) => {
        const entries = [];

        for (const act of input.activities) {
          const entry = await prisma.timeEntry.create({
            data: {
              caseId: act.caseId,
              userId: context.userId,
              date: new Date(act.timestamp),
              durationMinutes: act.durationMinutes,
              description: act.description,
              activityType: act.activityType,
              isBillable: true,
              status: "PENDING",
              source: act.source,
              sourceRef: act.sourceRef,
              metadata: { confidence: act.confidence },
            },
          });
          entries.push(entry);
        }

        return { entriesCreated: entries.length, entryIds: entries.map(e => e.id) };
      },
    },
    {
      name: "get_daily_approval_screen",
      description: "18:00 onay ekranı için günün taslaklarını getir",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string" },
          date: { type: "string" },
        },
        required: ["userId", "date"],
      },
      execute: async (input, context) => {
        const date = new Date(input.date);
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        const entries = await prisma.timeEntry.findMany({
          where: {
            userId: input.userId,
            date: { gte: startOfDay, lte: endOfDay },
            status: "PENDING",
          },
          include: {
            case: { include: { client: true } },
          },
          orderBy: { date: "asc" },
        });

        const grouped = entries.reduce((acc, entry) => {
          const caseKey = entry.caseId;
          if (!acc[caseKey]) {
            acc[caseKey] = {
              caseId: entry.caseId,
              caseNumber: entry.case.caseNumber,
              clientName: entry.case.client.name,
              totalMinutes: 0,
              activities: [],
            };
          }
          acc[caseKey].totalMinutes += entry.durationMinutes;
          acc[caseKey].activities.push({
            id: entry.id,
            type: entry.activityType,
            description: entry.description,
            duration: entry.durationMinutes,
            source: entry.source,
            confidence: entry.metadata?.confidence || 0,
          });
          return acc;
        }, {} as Record<string, any>);

        return {
          date: date.toLocaleDateString("tr-TR"),
          cases: Object.values(grouped),
          grandTotalMinutes: entries.reduce((sum, e) => sum + e.durationMinutes, 0),
        };
      },
    },
    {
      name: "approve_time_entries",
      description: "Zaman kayıtlarını onayla/reddet",
      inputSchema: {
        type: "object",
        properties: {
          entryIds: { type: "array", items: { type: "string" } },
          action: { type: "string", enum: ["approve", "reject", "modify"] },
          modifications: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                durationMinutes: { type: "number" },
                description: { type: "string" },
                isBillable: { type: "boolean" },
              },
            },
          },
        },
        required: ["entryIds", "action"],
      },
      execute: async (input, context) => {
        if (input.action === "approve") {
          await prisma.timeEntry.updateMany({
            where: { id: { in: input.entryIds } },
            data: { status: "APPROVED", approvedAt: new Date(), approvedById: context.userId },
          });
        } else if (input.action === "reject") {
          await prisma.timeEntry.updateMany({
            where: { id: { in: input.entryIds } },
            data: { status: "REJECTED" },
          });
        } else if (input.action === "modify" && input.modifications) {
          for (const mod of input.modifications) {
            await prisma.timeEntry.update({
              where: { id: mod.id },
              data: {
                durationMinutes: mod.durationMinutes,
                description: mod.description,
                isBillable: mod.isBillable,
                status: "PENDING", // stays pending for re-review
              },
            });
          }
        }

        return { updated: input.entryIds.length };
      },
    },
  ];

  private summarizeActivity(source: any): string {
    const maxLen = 100;
    let text = source.content.replace(/\s+/g, " ").trim();
    if (text.length > maxLen) text = text.slice(0, maxLen) + "...";
    return `[${source.type.toUpperCase()}] ${text}`;
  }

  canHandle(input: any): boolean {
    const keywords = ["zaman", "saat", "kimai", "faturalanabilir", "toplantı", "not", "18:00", "onayla", "aktivite", "eşle"];
    return keywords.some((k) => JSON.stringify(input).toLowerCase().includes(k));
  }

  async execute(input: string, context: AgentContext): Promise<AgentResponse> {
    try {
      logger.info({ caseId: context.caseId }, "Time Tracking processing");

      // Get user's cases
      const userCases = await prisma.caseLawyer.findMany({
        where: { userId: context.userId },
        select: { caseId: true },
      });
      const caseIds = userCases.map(c => c.caseId);

      // Mock sources for demo
      const mockSources = [
        { type: "email", id: "email-1", content: `Dosya ${context.caseId} hakkında müvekkil ile yazışma`, timestamp: new Date().toISOString(), durationHint: 20 },
        { type: "calendar", id: "cal-1", content: "Duruşma hazırlığı toplantısı 60 dk", timestamp: new Date().toISOString(), durationHint: 60 },
        { type: "document", id: "doc-1", content: "Dilekçe taslağı hazırlandı", timestamp: new Date().toISOString(), durationHint: 45 },
        { type: "phone", id: "phone-1", content: "Karşı taraf avukatı ile görüşme 15 dk", timestamp: new Date().toISOString(), durationHint: 15 },
      ];

      // Extract activities
      const extracted = await this.tools[0].execute({ sources: mockSources, caseIds }, context);

      // Create Kimai drafts
      if (extracted.activities.length > 0) {
        await this.tools[1].execute({ activities: extracted.activities }, context);
      }

      // Get daily approval screen
      const today = new Date().toISOString().split("T")[0];
      const approvalScreen = await this.tools[2].execute({ userId: context.userId, date: today }, context);

      return {
        success: true,
        output: {
          extractedActivities: extracted.activities.length,
          activities: extracted.activities,
          approvalScreen,
          message: "Günün zaman kayıtları hazır. 18:00'de onay bekliyor.",
        },
        toolsUsed: ["extract_activities", "create_kimai_drafts", "get_daily_approval_screen"],
      };
    } catch (error) {
      logger.error({ error }, "Time Tracking failed");
      return { success: false, error: String(error) };
    }
  }
}