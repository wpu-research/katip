/**
 * Kâtip - Email & Client Department (E-posta & Müvekkil)
 * Model: Sonnet 5.5, Effort: medium
 * Handles: Haiku classifies inbox, Sonnet drafts replies in office tone, weekly client summary
 */

import { createHash } from "crypto";
import { logger } from "@/config/logger";
import { prisma } from "@/config/db";
import {
  DepartmentAgent,
  AgentContext,
  AgentResponse,
  AgentTool,
  DepartmentType,
} from "@/core/types";

export class EmailClientAgent implements DepartmentAgent {
  type: DepartmentType = "EMAIL_CLIENT";
  name = "E-posta & Müvekkil";
  description = "Gelen kutusu sınıflandırma (Haiku), büro tonunda yanıt taslağı (Sonnet), haftalık müvekkil durum özeti";
  modelConfig = { model: "sonnet-5.5" as const, effort: "medium" as const };

  systemPrompt = `Sen bir hukuk bürosu müvekkil ilişkileri uzmanısın. Görevin:
1. Haiku ile gelen kutusunu sınıflandır: dosya, aciliyet, yanıt gerekir mi
2. Sonnet ile büro tonunda yanıt taslağı yaz
3. Haftalık müvekkil durum özeti hazırla

KURALLAR:
- Taslaklar klasörüne yazar, KENDİSİ GÖNDERMEZ
- Büro tonu: resmi, empati, net, işe odaklı
- Aciliyet: "acil" (24 saat), "normal" (3 gün), "düşük" (1 hafta)
- Müvekkil bilgilendirme: ne yapıldı, ne yapılacak, ne bekliyor`;

  tools: AgentTool[] = [
    {
      name: "classify_emails",
      description: "Haiku ile e-postaları sınıflandır",
      inputSchema: {
        type: "object",
        properties: {
          emails: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                from: { type: "string" },
                subject: { type: "string" },
                body: { type: "string" },
                receivedAt: { type: "string" },
              },
            },
          },
        },
        required: ["emails"],
      },
      execute: async (input, context) => {
        // Mock classification - in production, batch call Haiku
        return {
          classified: input.emails.map((email: any) => {
            const lower = (email.subject + " " + email.body).toLowerCase();
            let category = "general";
            let urgency = "normal";
            let needsReply = false;
            let caseMatch = null;

            if (lower.includes("dava") || lower.includes("dosya") || lower.includes("esas")) category = "case";
            if (lower.includes("fatura") || lower.includes("ödeme")) category = "billing";
            if (lower.includes("randevu") || lower.includes("görüşme")) category = "appointment";
            if (lower.includes("acil") || lower.includes("ürgent") || lower.includes("yarın")) urgency = "high";
            if (lower.includes("bilgi") || lower.includes("soru") || lower.includes("?") || email.from.includes("müvekkil")) needsReply = true;

            return { ...email, category, urgency, needsReply, caseMatch };
          }),
        };
      },
    },
    {
      name: "draft_reply",
      description: "Sonnet ile büro tonunda yanıt taslağı yaz",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "object" },
          caseContext: { type: "object" },
          tone: { type: "string", enum: ["formal", "empathetic", "direct", "informative"] },
        },
        required: ["email", "caseContext"],
      },
      execute: async (input, context) => {
        const { email, caseContext, tone = "formal" } = input;

        const draft = `Sayın ${email.from.split("@")[0]},

E-postanız için teşekkür ederiz. ${caseContext.caseNumber ? `Dosya ${caseContext.caseNumber} ` : ""}kapsamında değerlendirmelerimiz şöyledir:

**Mevcut Durum:** ${caseContext.status || "Dosya aktif olarak takip edilmektedir."}

**Yapılan İşlemler:**
${caseContext.recentActions?.map((a: string) => `- ${a}`).join("\n") || "- Dosya incelendi"}

**Sonraki Adımlar:**
${caseContext.nextSteps?.map((s: string) => `- ${s}`).join("\n") || "- Karşı taraf cevabı bekleniyor"}

**Beklenen Süreç:** ${caseContext.timeline || "İlgili mahkeme takvimine bağlı olarak"}

Herhangi bir sorunuz olursa lütfen bize başvurun.

Saygılarımızla,
${context.lawFirmId ? "Kâtip Hukuk Bürosu" : "Hukuk Bürosu"}
${caseContext.lawyerName || "Avukat"}`;

        // Save as draft
        const draftRecord = await prisma.document.create({
          data: {
            caseId: caseContext.caseId,
            lawFirmId: context.lawFirmId,
            title: `E-posta Taslağı: Re: ${email.subject}`,
            type: "CORRESPONDENCE",
            content: draft,
            contentHash: createHash("sha256").update(draft).digest("hex"),
            sensitivityLevel: "L1_NORMAL",
            uploadedById: context.userId,
            metadata: { emailId: email.id, isDraft: true, tone },
          },
        });

        return { draftId: draftRecord.id, content: draft };
      },
    },
    {
      name: "generate_weekly_summary",
      description: "Haftalık müvekkil durum özeti",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          weekStart: { type: "string" },
          weekEnd: { type: "string" },
        },
        required: ["caseId", "weekStart", "weekEnd"],
      },
      execute: async (input, context) => {
        const start = new Date(input.weekStart);
        const end = new Date(input.weekEnd);

        const [caseData, hearings, deadlines, timeEntries, petitions, emails] = await Promise.all([
          prisma.case.findUnique({
            where: { id: input.caseId },
            include: { client: true, lawyers: { include: { user: true } } },
          }),
          prisma.hearing.findMany({
            where: { caseId: input.caseId, hearingDate: { gte: start, lte: end } },
          }),
          prisma.deadline.findMany({
            where: { caseId: input.caseId, dueDate: { gte: start, lte: end } },
          }),
          prisma.timeEntry.findMany({
            where: { caseId: input.caseId, date: { gte: start, lte: end } },
          }),
          prisma.petition.findMany({
            where: { caseId: input.caseId, generatedAt: { gte: start, lte: end } },
          }),
          prisma.document.findMany({
            where: { caseId: input.caseId, type: "CORRESPONDENCE", createdAt: { gte: start, lte: end } },
          }),
        ]);

        const totalHours = timeEntries.reduce((sum, t) => sum + t.durationMinutes, 0) / 60;
        const billableHours = timeEntries.filter((t) => t.isBillable).reduce((sum, t) => sum + t.durationMinutes, 0) / 60;

        const summary = `**HAFTALIK DURUM ÖZETİ: ${caseData?.caseNumber}**
**Müvekkil:** ${caseData?.client?.name}
**Dönem:** ${start.toLocaleDateString("tr-TR")} - ${end.toLocaleDateString("tr-TR")}

**📅 Bu Haftaki Duruşmalar:** ${hearings.length}
${hearings.map((h) => `- ${h.hearingDate.toLocaleDateString("tr-TR")}: ${h.courtName} (${h.hearingType})`).join("\n") || "- Yok"}

**⏰ Bu Haftaki Süreler:** ${deadlines.length}
${deadlines.map((d) => `- ${d.dueDate.toLocaleDateString("tr-TR")}: ${d.title} (${d.basis})`).join("\n") || "- Yok"}

**📝 Hazırlanan Dilekçeler:** ${petitions.length}
${petitions.map((p) => `- ${p.title} (${p.status})`).join("\n") || "- Yok"}

**⏱️ Zaman Kayıtları:** ${totalHours.toFixed(1)} saat (faturalanabilir: ${billableHours.toFixed(1)} saat)

**📧 E-posta Yazışmaları:** ${emails.length}

**🎯 Haftaya Bakış:**
- ${deadlines[0] ? `Kritik süre: ${deadlines[0].title} (${deadlines[0].dueDate.toLocaleDateString("tr-TR")})` : "Önümüzdeki hafta kritik süre yok"}
- ${hearings[0] ? `Yaklaşan duruşma: ${hearings[0].courtName} (${hearings[0].hearingDate.toLocaleDateString("tr-TR")})` : "Yaklaşan duruşma yok"}

**⚠️ Riskler/Notlar:** ${(caseData?.metadata as { risks?: string } | null)?.risks || "Özel risk belirtilmemiş"}`;

        return { summary, stats: { hearings: hearings.length, deadlines: deadlines.length, petitions: petitions.length, totalHours, billableHours } };
      },
    },
    {
      name: "save_draft_to_folder",
      description: "Taslağı taslaklar klasörüne kaydet",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string" },
          folderPath: { type: "string" },
        },
        required: ["draftId", "folderPath"],
      },
      execute: async (input, context) => {
        // In production, integrate with Nextcloud/OnlyOffice
        // For mock, update document metadata
        await prisma.document.update({
          where: { id: input.draftId },
          data: { metadata: { folderPath: input.folderPath, savedAt: new Date() } },
        });
        return { saved: true, path: input.folderPath };
      },
    },
  ];

  canHandle(input: any): boolean {
    const keywords = ["e-posta", "email", "gelen kutusu", "yanıt", "müvekkil", "haftalık", "özet", "taslak", "gönder"];
    return keywords.some((k) => JSON.stringify(input).toLowerCase().includes(k));
  }

  async execute(input: string, context: AgentContext): Promise<AgentResponse> {
    try {
      logger.info({ caseId: context.caseId }, "Email & Client processing");

      // For demo, create mock email processing
      const mockEmails = [
        { id: "1", from: "muvekkil@example.com", subject: "Dosya durumu hakkında", body: "Davamızın güncel durumu nedir?", receivedAt: new Date().toISOString() },
        { id: "2", from: "karşı_taraf@avukat.com", subject: "Cevap dilekçesi", body: "Ekli cevap dilekçesini inceleyiniz.", receivedAt: new Date().toISOString() },
      ];

      const classified = await this.tools[0].execute({ emails: mockEmails }, context);

      // Draft replies for emails needing response
      const drafts = [];
      for (const email of classified.classified.filter((e: any) => e.needsReply)) {
        const caseData = await prisma.case.findUnique({
          where: { id: context.caseId },
          include: { client: true, lawyers: { include: { user: true } } },
        });

        const draft = await this.tools[1].execute(
          {
            email,
            caseContext: {
              caseId: context.caseId,
              caseNumber: caseData?.caseNumber,
              status: caseData?.status,
              recentActions: ["Dilekçe hazırlandı", "Delil toplandı"],
              nextSteps: ["Karşı taraf cevabı bekleniyor", "Duruşma tarihi bekleniyor"],
              timeline: "2-3 hafta",
              lawyerName: caseData?.lawyers?.[0]?.user?.name,
            },
          },
          context
        );
        drafts.push(draft);
      }

      // Generate weekly summary
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - 7);
      const weekly = await this.tools[2].execute(
        { caseId: context.caseId!, weekStart: weekStart.toISOString(), weekEnd: new Date().toISOString() },
        context
      );

      return {
        success: true,
        output: {
          classifiedEmails: classified.classified,
          draftsGenerated: drafts.length,
          drafts: drafts.map((d) => ({ draftId: d.draftId, preview: d.content.slice(0, 200) })),
          weeklySummary: weekly.summary,
        },
        toolsUsed: ["classify_emails", "draft_reply", "generate_weekly_summary"],
      };
    } catch (error) {
      logger.error({ error }, "Email & Client failed");
      return { success: false, error: String(error) };
    }
  }
}