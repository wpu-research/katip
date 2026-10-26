/**
 * Kâtip - Intake & Reception Department (Kabul & Resepsiyon)
 * Model: Haiku 5.5, Effort: low
 * Handles: New client intake, phone reception, conflict check routing, Cal.com scheduling
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

export class IntakeReceptionAgent implements DepartmentAgent {
  type: DepartmentType = "INTAKE_RECEPTION";
  name = "Kabul & Resepsiyon";
  description = "Yeni müvekkil kabulü, mesai dışı telefon karşılama, çatışma kontrolü ve randevu ayarlama";
  modelConfig = { model: "haiku-5.5" as const, effort: "low" as const };

  systemPrompt = `Sen bir hukuk bürosu resepsiyonistasısın. Görevin:
1. Yeni müvekkil kabul formunu doldurmak
2. Karşı tarafı çatışma kontrolüne yönlendirmek
3. Temizse Cal.com'da ön görüşme randevusu oluşturmak
4. Avukata 07:30 bildirimi göndermek

KURALLAR:
- Hukuki görüş, üret veya başarı vaadi YAPMA (Av. K. m.55)
- KVKK aydınlatması sabit metinle ver
- Sadece form doldur, yönlendir, randevu ver
- Çıktı: JSON formatında kabul formu taslağı`;

  tools: AgentTool[] = [
    {
      name: "create_intake_form",
      description: "Yeni müvekkil kabul formu oluştur",
      inputSchema: {
        type: "object",
        properties: {
          clientName: { type: "string" },
          clientType: { type: "string", enum: ["individual", "corporate"] },
          taxId: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          caseType: { type: "string" },
          summary: { type: "string" },
          opposingParties: { type: "array", items: { type: "string" } },
        },
        required: ["clientName", "clientType", "taxId", "caseType", "summary"],
      },
      execute: async (input, context) => {
        // Create client and case in database
        const client = await prisma.client.create({
          data: {
            lawFirmId: context.lawFirmId,
            name: input.clientName,
            type: input.clientType,
            taxId: input.taxId,
            email: input.email,
            phone: input.phone,
            address: input.address,
            sensitivityLevel: "L1_NORMAL",
          },
        });

        const caseNumber = `${new Date().getFullYear()}/${String(await prisma.case.count({ where: { lawFirmId: context.lawFirmId } }) + 1).padStart(5, "0")}`;

        const newCase = await prisma.case.create({
          data: {
            lawFirmId: context.lawFirmId,
            clientId: client.id,
            creatorId: context.userId,
            caseNumber,
            caseType: input.caseType as any,
            description: input.summary,
            sensitivityLevel: "L1_NORMAL",
            status: "OPEN",
          },
        });

        // Queue conflict check
        await prisma.conflictCheck.create({
          data: {
            caseId: newCase.id,
            checkedTaxIds: input.opposingParties || [],
            checkedNames: [input.clientName],
            status: "CLEAR",
            checkedById: context.userId,
          },
        });

        return { clientId: client.id, caseId: newCase.id, caseNumber };
      },
    },
    {
      name: "schedule_cal_com",
      description: "Cal.com'da ön görüşme randevusu oluştur",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          clientEmail: { type: "string" },
          preferredDates: { type: "array", items: { type: "string" } },
          duration: { type: "number", default: 30 },
        },
        required: ["caseId", "clientEmail"],
      },
      execute: async (input, context) => {
        // In production, call Cal.com API
        // For mock, return a scheduled appointment
        return {
          appointmentId: `cal_${Date.now()}`,
          date: input.preferredDates[0] || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          duration: input.duration,
          status: "scheduled",
          meetingLink: `https://cal.com/katip/${input.caseId}`,
        };
      },
    },
    {
      name: "send_lawyer_notification",
      description: "Avukata 07:30 bildirimi gönder",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          lawyerIds: { type: "array", items: { type: "string" } },
          message: { type: "string" },
        },
        required: ["caseId", "lawyerIds", "message"],
      },
      execute: async (input, context) => {
        const notifications = await Promise.all(
          input.lawyerIds.map((lawyerId: string) =>
            prisma.notification.create({
              data: {
                userId: lawyerId,
                type: "daily_briefing",
                title: "Yeni Müvekkil Kabulü",
                message: input.message,
                priority: "high",
                metadata: { caseId: input.caseId },
              },
            })
          )
        );
        return { notificationsSent: notifications.length };
      },
    },
  ];

  canHandle(input: any): boolean {
    const keywords = ["kabul", "yeni müvekkil", "telefon", "randevu", "ön görüşme", "çalışma saati dışı"];
    return keywords.some((k) => JSON.stringify(input).toLowerCase().includes(k));
  }

  async execute(input: string, context: AgentContext): Promise<AgentResponse> {
    try {
      logger.info({ caseId: context.caseId }, "Intake reception processing");

      // Parse input to extract client info
      // In production, this would use the LLM to extract structured data
      const extracted = this.extractClientInfo(input);

      // Create intake form
      const formResult = await this.tools[0].execute(extracted, context);

      // Schedule Cal.com appointment if no conflicts
      const conflictCheck = await prisma.conflictCheck.findFirst({
        where: { caseId: formResult.caseId },
      });

      let appointment = null;
      if (conflictCheck?.status === "CLEAR") {
        appointment = await this.tools[1].execute(
          { caseId: formResult.caseId, clientEmail: extracted.email },
          context
        );
      }

      // Notify lawyers
      const caseLawyers = await prisma.caseLawyer.findMany({
        where: { caseId: formResult.caseId },
        include: { user: true },
      });

      if (caseLawyers.length > 0) {
        await this.tools[2].execute(
          {
            caseId: formResult.caseId,
            lawyerIds: caseLawyers.map((cl) => cl.userId),
            message: `Yeni dosya: ${formResult.caseNumber} - ${extracted.clientName} (${extracted.caseType})`,
          },
          context
        );
      }

      return {
        success: true,
        output: {
          intakeForm: {
            caseNumber: formResult.caseNumber,
            clientName: extracted.clientName,
            caseType: extracted.caseType,
            summary: extracted.summary,
          },
          conflictCheck: conflictCheck?.status,
          appointment,
          kvkkNotice: this.getKVKKNotice(),
        },
        toolsUsed: ["create_intake_form", "schedule_cal_com", "send_lawyer_notification"],
      };
    } catch (error) {
      logger.error({ error }, "Intake reception failed");
      return { success: false, error: String(error) };
    }
  }

  private extractClientInfo(input: string): any {
    // Mock extraction - in production use LLM
    return {
      clientName: "Demo Müvekkil",
      clientType: "individual",
      taxId: "12345678901",
      email: "muvekkil@example.com",
      phone: "05551234567",
      address: "İstanbul",
      caseType: "COMMERCIAL",
      summary: input.slice(0, 500),
      opposingParties: ["Karşı Taraf A.Ş."],
    };
  }

  private getKVKKNotice(): string {
    return `KVKK AYDINLATMA METNİ: Kişilerinizin, hukuki hizmet verme sürecinde işleneceği, 6698 sayılı KVKK'nın 5. ve 6. maddeleri kapsamında, hukuki yükümlülüklerimiz gereği ve meşru menfaatlerimiz için işleneceği, yetkili mercilere (mahkeme, icra, baro vb.) aktarılabileceği, 11. madde kapsamında haklarınızın (bilgi edilme, erişim, düzeltme, silinme vb.) kullanabileceğiniz hususunda aydınlatıldığınızı kabul ve beyan eder misiniz?`;
  }
}