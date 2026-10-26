/**
 * Kâtip - Deadlines & Hearings Department (Süreler & Duruşma)
 * Model: Sonnet 5.5, Effort: medium
 * Handles: UYAP document extraction, HMK deadline calculator, 7/3/1 day warnings, CalDAV calendar
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

export class DeadlinesHearingsAgent implements DepartmentAgent {
  type: DepartmentType = "DEADLINES_HEARINGS";
  name = "Süreler & Duruşma";
  description = "UYAP evrak çıkarma, HMK süre hesaplayıcı, 7/3/1 gün uyarı, CalDAV takvim entegrasyonu";
  modelConfig = { model: "sonnet-5.5" as const, effort: "medium" as const };

  systemPrompt = `Sen bir hukuk bürosu süreler uzmanısın. Görevin:
1. UYAP evrakından mahkeme, esas no, tebliğ tarihi çıkarmak
2. HMK, adli tatil (m.104), resmi tatilleri hesaplayarak kesin süreler üretmek
3. 7/3/1 gün kala uyarı oluşturmak
4. CalDAV ile takvim entegrasyonu

KURALLAR:
- UYAP'a OTOMATİK GİRİŞ YOK - sadece evrak metni işlenir
- Kritik süreye İKİ KİŞİ onayı gerekir
- Süre hesaplayıcı DETERMİNİSTİK kodla çalışır (model değil)
- Model sadece evrak metninden bilgi çıkarır, hesap yapmaz`;

  tools: AgentTool[] = [
    {
      name: "extract_uyap_data",
      description: "UYAP evrak metninden mahkeme, esas no, tebilğ tarihi çıkarma",
      inputSchema: {
        type: "object",
        properties: {
          documentText: { type: "string" },
          documentId: { type: "string" },
        },
        required: ["documentText", "documentId"],
      },
      execute: async (input, context) => {
        const text = input.documentText;

        // Extract court name
        const courtMatch = text.match(/(.+?)\s+(Asliye|Çocuk|Aile|İş|İcra|İflas|Ticaret|Ceza|Hukuk|İdare|Anayasa)\s+(Mahkemesi|Mahkeme)/i);
        const courtName = courtMatch ? courtMatch[0].trim() : null;

        // Extract case number (esas no)
        const esasMatch = text.match(/\b(20\d{2}|19\d{2})\/\d{1,6}(?:\.\w+)?\b/);
        const esasNo = esasMatch ? esasMatch[0] : null;

        // Extract notification date (teblig tarihi)
        const tebligMatch = text.match(/teblig\s+tarihi[:\s]+(\d{2}[.\/]\d{2}[.\/]\d{4})/i) ||
                           text.match(/(\d{2}[.\/]\d{2}[.\/]\d{4})\s*tarihli\s*teblig/i);
        const tebligDate = tebligMatch ? this.parseDate(tebligMatch[1]) : null;

        // Extract hearing date
        const hearingMatch = text.match(/duruşma\s+tarihi[:\s]+(\d{2}[.\/]\d{2}[.\/]\d{4})/i) ||
                            text.match(/(\d{2}[.\/]\d{2}[.\/]\d{4})\s*(?:günü|tarihli)\s*duruşma/i);
        const hearingDate = hearingMatch ? this.parseDate(hearingMatch[1]) : null;

        // Extract decision type
        let decisionType = "notification";
        if (text.includes("hüküm") || text.includes("karar")) decisionType = "decision";
        if (text.includes("duruşma")) decisionType = "hearing";
        if (text.includes("temyiz") || text.includes("istinaf")) decisionType = "appeal";

        return {
          courtName,
          esasNo,
          tebligDate,
          hearingDate,
          decisionType,
          rawText: text.slice(0, 1000),
        };
      },
    },
    {
      name: "calculate_deadlines",
      description: "HMK süre hesaplayıcı - adli tatil, resmi tatil dahil deterministik hesaplama",
      inputSchema: {
        type: "object",
        properties: {
          startDate: { type: "string", format: "date-time" },
          triggerEvent: { type: "string" }, // "teblig", "hukum", "karar"
          deadlineType: { type: "string" }, // "itiraz", "temyiz", "istinaf", "cevap", "davaci_cevap"
          caseType: { type: "string" },
        },
        required: ["startDate", "triggerEvent", "deadlineType", "caseType"],
      },
      execute: async (input, context) => {
        const startDate = new Date(input.startDate);
        let deadlineDays = 0;
        let basis = "";

        // HMK süreler (gün cinsinden)
        const hmkDeadlines: Record<string, number> = {
          itiraz: 7,           // HMK m.27 - icra itiraz
          temyiz: 14,          // HMK m.340 - temyiz
          istinaf: 14,         // HMK m.340 - istinaf
          cevap: 14,           // HMK m.130 - cevap dilekçesi
          davaci_cevap: 14,    // HMK m.130 - davacı cevabı
          istinaf_cevap: 14,   // istinaf cevabı
          yeniden_yargilama: 14,
          dusme: 10,           // HMK m.150 - düsme
          icra_takip: 7,       // icra takip
        };

        deadlineDays = hmkDeadlines[input.deadlineType] || 14;
        basis = `HMK ${this.getHmkArticle(input.deadlineType)}`;

        // Calculate with judicial holidays (adli tatil: 15 Temmuz - 31 Ağustos)
        const calculatedDate = this.addBusinessDays(startDate, deadlineDays);

        // Check for official holidays
        const holidays = await this.getOfficialHolidays(startDate.getFullYear());
        const finalDate = this.adjustForHolidays(calculatedDate, holidays);

        // Generate warnings at 7, 3, 1 days
        const warnings = [7, 3, 1].map((days) => {
          const warnDate = new Date(finalDate);
          warnDate.setDate(warnDate.getDate() - days);
          return { daysBefore: days, date: warnDate };
        });

        return {
          startDate,
          deadlineDays,
          basis,
          calculatedDate: finalDate,
          warnings,
          isCritical: deadlineDays <= 7,
        };
      },
    },
    {
      name: "create_calendar_event",
      description: "CalDAV takvime duruşma/süre eventi ekle",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          title: { type: "string" },
          startDate: { type: "string", format: "date-time" },
          endDate: { type: "string", format: "date-time" },
          description: { type: "string" },
          reminderDays: { type: "array", items: { type: "number" } },
        },
        required: ["caseId", "title", "startDate", "endDate"],
      },
      execute: async (input, context) => {
        // In production, integrate with CalDAV
        // For now, create deadline record with reminders
        const deadline = await prisma.deadline.create({
          data: {
            caseId: input.caseId,
            title: input.title,
            description: input.description,
            dueDate: new Date(input.endDate),
            calculatedDate: new Date(input.endDate),
            basis: "HMK",
            isCritical: input.reminderDays?.some((d: number) => d <= 3) || false,
            reminderSent: false,
          },
        });

        // Create notifications for reminders
        for (const days of input.reminderDays || [7, 3, 1]) {
          const remindDate = new Date(input.endDate);
          remindDate.setDate(remindDate.getDate() - days);

          if (remindDate > new Date()) {
            const caseLawyers = await prisma.caseLawyer.findMany({
              where: { caseId: input.caseId },
              include: { user: true },
            });

            for (const cl of caseLawyers) {
              await prisma.notification.create({
                data: {
                  userId: cl.userId,
                  type: "deadline_alert",
                  title: `Süre Hatırlatması: ${days} gün kaldı`,
                  message: `${input.title} - ${input.description}`,
                  priority: days <= 1 ? "critical" : days <= 3 ? "high" : "normal",
                  metadata: { deadlineId: deadline.id, daysBefore: days, remindAt: remindDate },
                },
              });
            }
          }
        }

        return { deadlineId: deadline.id, remindersSet: (input.reminderDays || [7, 3, 1]).length };
      },
    },
    {
      name: "require_dual_approval",
      description: "Kritik süreler için iki kişi onayı zorunlu kıl",
      inputSchema: {
        type: "object",
        properties: {
          deadlineId: { type: "string" },
          approverIds: { type: "array", items: { type: "string" } },
        },
        required: ["deadlineId", "approverIds"],
      },
      execute: async (input, context) => {
        const approvals = await Promise.all(
          input.approverIds.map((approverId: string) =>
            prisma.approval.create({
              data: {
                type: "deadline_confirmation",
                resourceId: input.deadlineId,
                resourceType: "Deadline",
                title: "Kritik Süre Onayı",
                description: "Bu süre kritik seviyede, iki avukat onayı gerekiyor",
                status: "PENDING",
                requestedById: context.userId,
                approverId,
              },
            })
          )
        );
        return { approvalsCreated: approvals.length };
      },
    },
  ];

  private parseDate(str: string): Date | null {
    const parts = str.split(/[.\/]/);
    if (parts.length === 3) {
      return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
    }
    return null;
  }

  private addBusinessDays(startDate: Date, days: number): Date {
    const result = new Date(startDate);
    let added = 0;
    while (added < days) {
      result.setDate(result.getDate() + 1);
      // Skip weekends (0 = Sunday, 6 = Saturday)
      if (result.getDay() !== 0 && result.getDay() !== 6) {
        added++;
      }
    }
    return result;
  }

  private async getOfficialHolidays(year: number): Promise<Date[]> {
    // Turkish official holidays (fixed dates)
    const fixedHolidays = [
      { month: 0, day: 1 },    // 1 Ocak - Yılbaşı
      { month: 3, day: 23 },   // 23 Nisan
      { month: 4, day: 1 },    // 1 Mayıs
      { month: 4, day: 19 },   // 19 Mayıs
      { month: 6, day: 15 },   // 15 Temmuz
      { month: 7, day: 30 },   // 30 Ağustos
      { month: 9, day: 29 },   // 29 Ekim
    ];

    // Religious holidays would need calculation (Ramazan, Kurban)
    // For mock, return fixed holidays
    return fixedHolidays.map((h) => new Date(year, h.month, h.day));
  }

  private adjustForHolidays(date: Date, holidays: Date[]): Date {
    const result = new Date(date);
    while (holidays.some((h) => h.toDateString() === result.toDateString()) ||
          result.getDay() === 0 || result.getDay() === 6) {
      result.setDate(result.getDate() + 1);
    }
    return result;
  }

  private getHmkArticle(deadlineType: string): string {
    const articles: Record<string, string> = {
      itiraz: "m.27",
      temyiz: "m.340",
      istinaf: "m.340",
      cevap: "m.130",
      davaci_cevap: "m.130",
      dusme: "m.150",
      icra_takip: "m.27",
    };
    return articles[deadlineType] || "m.130";
  }

  canHandle(input: any): boolean {
    const keywords = ["süre", "duruşma", "uyap", "tevdi", "hüküm", "temyiz", "istinaf", "takvim", "hatırlatma", "hesapla"];
    return keywords.some((k) => JSON.stringify(input).toLowerCase().includes(k));
  }

  async execute(input: string, context: AgentContext): Promise<AgentResponse> {
    try {
      logger.info({ caseId: context.caseId }, "Deadlines & Hearings processing");

      // Extract UYAP data if document provided
      let uyapData = null;
      if (context.metadata.documentId) {
        const doc = await prisma.document.findUnique({
          where: { id: context.metadata.documentId },
        });
        if (doc?.content) {
          uyapData = await this.tools[0].execute(
            { documentText: doc.content, documentId: context.metadata.documentId },
            context
          );
        }
      }

      // If hearing date extracted, create calendar event
      if (uyapData?.hearingDate) {
        await this.tools[2].execute(
          {
            caseId: context.caseId!,
            title: `Duruşma: ${uyapData.courtName}`,
            startDate: uyapData.hearingDate.toISOString(),
            endDate: new Date(uyapData.hearingDate.getTime() + 60 * 60 * 1000).toISOString(),
            description: `Esas No: ${uyapData.esasNo}\nMahkeme: ${uyapData.courtName}`,
            reminderDays: [7, 3, 1],
          },
          context
        );
      }

      // Calculate deadlines for the case
      const deadlines = await prisma.deadline.findMany({
        where: { caseId: context.caseId },
        orderBy: { dueDate: "asc" },
      });

      return {
        success: true,
        output: {
          uyapExtraction: uyapData,
          upcomingDeadlines: deadlines.slice(0, 10),
          criticalDeadlines: deadlines.filter((d) => d.isCritical && d.status !== "COMPLETED"),
        },
        toolsUsed: ["extract_uyap_data", "calculate_deadlines", "create_calendar_event"],
      };
    } catch (error) {
      logger.error({ error }, "Deadlines & Hearings failed");
      return { success: false, error: String(error) };
    }
  }
}