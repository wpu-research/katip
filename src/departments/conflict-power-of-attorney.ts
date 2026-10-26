/**
 * Kâtip - Conflict & Power of Attorney Department (Çatışma & Vekalet)
 * Model: Haiku 5.5, Effort: low
 * Handles: TCKN/VKN exact + fuzzy matching, power of attorney draft, fee agreement, AAÜT minimum fee check
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

export class ConflictPowerOfAttorneyAgent implements DepartmentAgent {
  type: DepartmentType = "CONFLICT_POWER_OF_ATTORNEY";
  name = "Çatışma & Vekalet";
  description = "TCKN/VKN tam ve bulanık eşleşme, vekaletname ve ücret sözleşmesi taslağı, AAÜT asgari altı kontrolü";
  modelConfig = { model: "haiku-5.5" as const, effort: "low" as const };

  systemPrompt = `Sen bir hukuk bürosu çatışma kontrol uzmanısın. Görevin:
1. Yeni müvekkil/karşı taraf TCKN/VKN ile mevcut müvekkilleri karşılaştır
2. pg_trgm ile isim benzerliği kontrol et
3. Çatışma varsa detaylı rapor ver
4. Çatışma yoksa vekaletname ve ücret sözleşmesi taslağı hazırla
5. AAÜT m.164 asgari altı tutarını kontrol et

KURALLAR:
- Eşleşme kararı SQL'de verilir, model SADECE sonucu özetler
- Çatışma varsa "POTENTIAL_CONFLICT" veya "CONFIRMED_CONFLICT" döndür
- Vekaletname: Av. K. m.164, HMK m.104 uygun
- Ücret sözleşmesi: AAÜT asgari altı limiti kontrol et`;

  tools: AgentTool[] = [
    {
      name: "check_conflict",
      description: "TCKN/VKN tam eşleşme ve pg_trgm ile isim benzerliği kontrolü",
      inputSchema: {
        type: "object",
        properties: {
          taxIds: { type: "array", items: { type: "string" } },
          names: { type: "array", items: { type: "string" } },
          caseId: { type: "string" },
        },
        required: ["taxIds", "names", "caseId"],
      },
      execute: async (input, context) => {
        const { taxIds, names, caseId } = input;

        // Exact match on tax IDs
        const exactMatches = await prisma.client.findMany({
          where: {
            lawFirmId: context.lawFirmId,
            taxId: { in: taxIds },
            NOT: { cases: { some: { id: caseId } } },
          },
          include: { cases: { include: { lawyers: { include: { user: true } } } } },
        });

        // Fuzzy match on names using pg_trgm (similarity > 0.3)
        // This requires raw query for pg_trgm
        const fuzzyMatches: any[] = [];
        for (const name of names) {
          const results = await prisma.$queryRaw`
            SELECT c.*, similarity(c.name, ${name}) as sim
            FROM "Client" c
            WHERE c."lawFirmId" = ${context.lawFirmId}
            AND c.id NOT IN (SELECT "clientId" FROM "Case" WHERE id = ${caseId})
            AND similarity(c.name, ${name}) > 0.3
            ORDER BY sim DESC
            LIMIT 5
          `;
          fuzzyMatches.push(...(results as any[]));
        }

        // Check opposing parties in existing cases
        const opposingMatches = await prisma.party.findMany({
          where: {
            OR: [
              { taxId: { in: taxIds } },
              { name: { in: names } },
            ],
            isOpposing: true,
            case: { lawFirmId: context.lawFirmId, NOT: { id: caseId } },
          },
          include: { case: { include: { client: true, lawyers: { include: { user: true } } } } },
        });

        let status: "CLEAR" | "POTENTIAL_CONFLICT" | "CONFIRMED_CONFLICT" = "CLEAR";
        const matches: any[] = [];

        if (exactMatches.length > 0) {
          status = "CONFIRMED_CONFLICT";
          matches.push(...exactMatches.map((m) => ({ type: "EXACT_TAX_ID", client: m, confidence: 1.0 })));
        }

        if (fuzzyMatches.length > 0) {
          status = status === "CLEAR" ? "POTENTIAL_CONFLICT" : status;
          matches.push(...fuzzyMatches.map((m) => ({ type: "FUZZY_NAME", client: m, confidence: m.sim })));
        }

        if (opposingMatches.length > 0) {
          status = "CONFIRMED_CONFLICT";
          matches.push(...opposingMatches.map((m) => ({ type: "OPPOSING_PARTY", party: m, confidence: 1.0 })));
        }

        // Update conflict check record
        await prisma.conflictCheck.updateMany({
          where: { caseId },
          data: {
            status,
            matches: matches as any,
            checkedAt: new Date(),
          },
        });

        return { status, matches, exactMatches, fuzzyMatches, opposingMatches };
      },
    },
    {
      name: "generate_power_of_attorney",
      description: "Vekaletname taslağı oluştur",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          clientName: { type: "string" },
          clientTaxId: { type: "string" },
          lawyerNames: { type: "array", items: { type: "string" } },
          powers: { type: "array", items: { type: "string" } },
        },
        required: ["caseId", "clientName", "clientTaxId", "lawyerNames"],
      },
      execute: async (input, context) => {
        const caseData = await prisma.case.findUnique({
          where: { id: input.caseId },
          include: { client: true },
        });

        const template = `VEKALETNAME

MÜVEKKİL: ${input.clientName}
TCKN/VKN: ${input.clientTaxId}

VEKİL AVUKATLAR:
${input.lawyerNames.map((n: string, i: number) => `${i + 1}. ${n}`).join("\n")}

YETKİLER:
${input.powers.map((p: string, i: number) => `${i + 1}. ${p}`).join("\n")}

Bu vekaletname, ${caseData?.caseNumber || ""} numaralı dosya kapsamında verilmiştir.
Avukatlık Kanunu m.164 ve HMK m.104 hükümlerine uygun olarak düzenlenmiştir.

Tarih: ${new Date().toLocaleDateString("tr-TR")}
Müvekkil İmza: ________________`;

        return { content: template, format: "text" };
      },
    },
    {
      name: "generate_fee_agreement",
      description: "Ücret sözleşmesi taslağı oluştur (AAÜT kontrolü ile)",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          clientName: { type: "string" },
          billingType: { type: "string", enum: ["HOURLY", "FIXED_FEE", "CONTINGENCY", "RETAINER", "SUCCESS_FEE"] },
          hourlyRate: { type: "number" },
          fixedFee: { type: "number" },
          contingencyPercent: { type: "number" },
          retainerAmount: { type: "number" },
          caseType: { type: "string" },
          estimatedHours: { type: "number" },
        },
        required: ["caseId", "clientName", "billingType", "caseType"],
      },
      execute: async (input, context) => {
        // Get AAÜT minimum fee for case type
        const minimumFee = await this.getMinimumFee(input.caseType);

        let proposedFee = 0;
        let feeDescription = "";

        switch (input.billingType) {
          case "HOURLY":
            proposedFee = input.hourlyRate * (input.estimatedHours || 10);
            feeDescription = `Saatlik ${input.hourlyRate} TL × ${input.estimatedHours || 10} saat = ${proposedFee} TL`;
            break;
          case "FIXED_FEE":
            proposedFee = input.fixedFee;
            feeDescription = `Sabit ücret: ${proposedFee} TL`;
            break;
          case "CONTINGENCY":
            proposedFee = input.contingencyPercent;
            feeDescription = `Başarı payı: %${proposedFee}`;
            break;
          case "RETAINER":
            proposedFee = input.retainerAmount;
            feeDescription = `Avans: ${proposedFee} TL`;
            break;
        }

        const isAboveMinimum = proposedFee >= minimumFee || input.billingType === "CONTINGENCY";

        const template = `ÜCRET SÖZLEŞMESİ

MÜVEKKİL: ${input.clientName}
DOSYA: ${input.caseId}

ÜCRET TÜRÜ: ${input.billingType}
${feeDescription}

AAÜT ASGARİ ALTI TUTARI (${input.caseType}): ${minimumFee} TL
${isAboveMinimum ? "✓ Asgari altı tutarın üzerinde" : "⚠ ASGARİ ALTI TUTARIN ALTINDA - Revize gerekli"}

ÖDEME ŞARTLARİ:
1. Avans ödemesi: ${input.billingType === "RETAINER" ? input.retainerAmount : "Belirtilmemiş"} TL
2. Ara ödemeler: İşlem aşamalarında
3. Nihai ödeme: Dosya sonuçlandığında

Avukatlık Kanunu m.164, AAÜT ve HMK ilgili hükümlerine göre düzenlenmiştir.

Tarih: ${new Date().toLocaleDateString("tr-TR")}
Müvekkil: ________________  Avukat: ________________`;

        return {
          content: template,
          format: "text",
          minimumFee,
          proposedFee,
          isAboveMinimum,
        };
      },
    },
  ];

  async getMinimumFee(caseType: string): Promise<number> {
    // AAÜT 2024 asgari ücretler (örnek değerler)
    const minimumFees: Record<string, number> = {
      COMMERCIAL: 8500,
      CRIMINAL: 12000,
      FAMILY: 6500,
      LABOR: 5500,
      ADMINISTRATIVE: 7500,
      ENFORCEMENT: 4000,
      BANKRUPTCY: 15000,
      INTELLECTUAL_PROPERTY: 10000,
      OTHER: 5000,
    };
    return minimumFees[caseType] || 5000;
  }

  canHandle(input: any): boolean {
    const keywords = ["çatışma", "vekalet", "vekaletname", "ücret sözleşmesi", "tckn", "vkn", "eşleşme", "aaut"];
    return keywords.some((k) => JSON.stringify(input).toLowerCase().includes(k));
  }

  async execute(input: string, context: AgentContext): Promise<AgentResponse> {
    try {
      logger.info({ caseId: context.caseId }, "Conflict & Power of Attorney processing");

      // Extract info from input
      const extracted = this.extractInfo(input);

      // Run conflict check
      const conflictResult = await this.tools[0].execute(
        { taxIds: extracted.taxIds, names: extracted.names, caseId: context.caseId! },
        context
      );

      if (conflictResult.status !== "CLEAR") {
        return {
          success: true,
          output: {
            conflictStatus: conflictResult.status,
            matches: conflictResult.matches,
            message: this.getConflictMessage(conflictResult.status),
            requiresManualReview: true,
          },
          toolsUsed: ["check_conflict"],
        };
      }

      // Generate documents
      const [poa, feeAgreement] = await Promise.all([
        this.tools[1].execute(
          { caseId: context.caseId!, ...extracted.poaData },
          context
        ),
        this.tools[2].execute(
          { caseId: context.caseId!, ...extracted.feeData },
          context
        ),
      ]);

      return {
        success: true,
        output: {
          conflictStatus: "CLEAR",
          powerOfAttorney: poa.content,
          feeAgreement: feeAgreement.content,
          feeCheck: {
            minimumFee: feeAgreement.minimumFee,
            proposedFee: feeAgreement.proposedFee,
            isAboveMinimum: feeAgreement.isAboveMinimum,
          },
        },
        toolsUsed: ["check_conflict", "generate_power_of_attorney", "generate_fee_agreement"],
      };
    } catch (error) {
      logger.error({ error }, "Conflict & POA failed");
      return { success: false, error: String(error) };
    }
  }

  private extractInfo(input: string): any {
    // Mock extraction
    return {
      taxIds: ["1234567890", "9876543210"],
      names: ["Ahmet Yılmaz", "Ayşe Demir"],
      poaData: {
        clientName: "Demo Müvekkil",
        clientTaxId: "12345678901",
        lawyerNames: ["Av. Mehmet Öztürk", "Av. Ayşe Kaya"],
        powers: ["Dava açma ve takip", "İcra takibi", "Arabuluculuk", "Temyiz/İstinaf"],
      },
      feeData: {
        clientName: "Demo Müvekkil",
        billingType: "HOURLY" as const,
        hourlyRate: 2000,
        estimatedHours: 20,
        caseType: "COMMERCIAL",
      },
    };
  }

  private getConflictMessage(status: string): string {
    switch (status) {
      case "CONFIRMED_CONFLICT":
        return "KESİN ÇATIŞMA: Bu müvekkil/karşı taraf büromuzun mevcut müvekkiliyle çelişiyor. Dosya kabul edilemez.";
      case "POTENTIAL_CONFLICT":
        return "OLASI ÇATIŞMA: İsim benzerliği tespit edildi. Avukat manuel inceleme yapmalı.";
      default:
        return "Çatışma bulunamadı.";
    }
  }
}