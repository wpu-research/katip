/**
 * Kâtip - Petition & Review Department (Dilekçe & İnceleme)
 * Model: Opus 5.5, Effort: high
 * Handles: Case summary + precedent + office template -> petition draft, Style skill from good petitions, OnlyOffice tracked changes
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

export class PetitionReviewAgent implements DepartmentAgent {
  type: DepartmentType = "PETITION_REVIEW";
  name = "Dilekçe & İnceleme";
  description = "Dosya özeti + içtihat + büro şablonu → dilekçe taslağı, büro üslubu skill, OnlyOffice izlenen değişiklikler";
  modelConfig = { model: "opus-5.5" as const, effort: "high" as const };

  systemPrompt = `Sen bir hukuk bürosu senior avukatsın. Görevin:
1. Dosya özetini oku, ilgili içtihatları analiz et
2. Büronun iyi dilekçelerinden çıkarılmış ÜSLUP SKILL'ini uygula
3. Şablonu (docxtpl) doldur: antet, taraflar, konu, hakimgah, istek, gerekçe, imza
4. OnlyOffice'de izlenen değişikliklerle (track changes) sun

KURALLAR:
- Avukat ONAYLAR, e-imzalar ve UYAP'a KENDİSİ yükler
- Model taslak yazar, KARAR VERMEZ
- Her iddiayı içtihat/kanun ile destekle
- Büro formatına uygun: antetli, sayfalı, paragraf numaralı`;

  tools: AgentTool[] = [
    {
      name: "get_case_summary",
      description: "Dosya özeti ve ilgili belgeleri getir",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
        },
        required: ["caseId"],
      },
      execute: async (input, context) => {
        const caseData = await prisma.case.findUnique({
          where: { id: input.caseId },
          include: {
            client: true,
            parties: true,
            documents: { where: { type: { in: ["EVIDENCE", "CONTRACT", "COURT_DECISION"] } } },
            hearings: { orderBy: { hearingDate: "asc" } },
            deadlines: { where: { status: { not: "COMPLETED" } }, orderBy: { dueDate: "asc" } },
            researchMemos: { orderBy: { createdAt: "desc" }, take: 5 },
          },
        });
        return caseData;
      },
    },
    {
      name: "get_office_template",
      description: "Büro dilekçe şablonunu getir (docxtpl formatında)",
      inputSchema: {
        type: "object",
        properties: {
          lawFirmId: { type: "string" },
          petitionType: { type: "string" }, // "dava", "cevap", "itiraz", "temyiz", "istinaf", "icra"
        },
        required: ["lawFirmId", "petitionType"],
      },
      execute: async (input, context) => {
        const template = await prisma.template.findFirst({
          where: {
            lawFirmId: input.lawFirmId,
            type: "PETITION",
            name: { contains: input.petitionType },
            isActive: true,
          },
        });

        if (!template) {
          // Return default template structure
          return {
            content: this.getDefaultTemplate(input.petitionType),
            name: `Default ${input.petitionType}`,
          };
        }

        return { content: template.content, name: template.name };
      },
    },
    {
      name: "get_style_skill",
      description: "Büro dilekçe üslubu skill'ini getir (few-shot examples from good petitions)",
      inputSchema: {
        type: "object",
        properties: {
          lawFirmId: { type: "string" },
        },
        required: ["lawFirmId"],
      },
      execute: async (input, context) => {
        // In production, load from skill file or vector DB of good petitions
        return {
          styleRules: [
            "Antet: Büro logosu, adres, telefon, eposta, vergi dairesi/no",
            "Taraflar: Davacı/Davalı tam unvan, TCKN/VKN, adres, vekil avocat",
            "Hakimgah: Mahkeme adı tam, esas no boşluklu",
            "Konu: Kısa, net, hukuki nitelik",
            "İstek: Maddeler halinde, net, hmke uygun",
            "Gerekçe: 1. Olaylar, 2. Hukuki değerlendirme, 3. İhtihat/kanun, 4. Sonuç",
            "Dil: Resmi, objektif, lafazı gereksiz uzatmadan",
            "Kaynakça: Her iddiada dipnot/parantez içi atıf",
            "İmza: Avukat adı, baro no, tarih, damga",
          ],
          fewShotExamples: [
            "Örnek dava dilekçesi yapısı...",
            "Örnek cevap dilekçesi yapısı...",
          ],
        };
      },
    },
    {
      name: "generate_petition_draft",
      description: "Dilekçe taslağı üret (docxtpl + veriler)",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          templateContent: { type: "string" },
          styleRules: { type: "array", items: { type: "string" } },
          caseSummary: { type: "object" },
          citations: { type: "array", items: { type: "object" } },
          petitionType: { type: "string" },
        },
        required: ["caseId", "templateContent", "caseSummary", "petitionType"],
      },
      execute: async (input, context) => {
        // In production: use docxtpl to render template
        // For mock, generate structured text
        const cs = input.caseSummary as any;
        const client = cs?.client;
        const opposing = cs?.parties?.find((p: any) => p.isOpposing) || cs?.parties?.[0];

        const draft = `${client?.lawFirm?.name || "HUKUK BÜROSU"}
${client?.lawFirm?.address || "Adres"}
Tel: ${client?.lawFirm?.phone || ""} | E-posta: ${client?.lawFirm?.email || ""}
Vergi Dairesi/No: ${client?.lawFirm?.taxNumber || ""}

${new Date().toLocaleDateString("tr-TR")}

${cs?.courtName || "...... MAHKEMESİ"}
Esas No: ${cs?.caseNumber || "........../......."}

KONU: ${input.petitionType.toUpperCase()} DAVASI HAKKINDA

DAVACI: ${client?.name || "MÜVEKKİL ADI"}
TCKN/VKN: ${client?.taxId || "..........."}
Adres: ${client?.address || "..........."}
Vekili: ${cs?.lawyers?.[0]?.user?.name || "AVUKAT ADI"}, ${cs?.lawyers?.[0]?.user?.barNumber || "......."} No'lu Avukat

DAVALI: ${opposing?.name || "KARŞI TARAF ADI"}
TCKN/VKN: ${opposing?.taxId || "..........."}
Adres: ${opposing?.address || "..........."}

İSTEK:
1. .............................................................................
2. .............................................................................
3. .............................................................................

GEREKÇE:

I. OLAYLAR
${cs?.description || "Dosya konusu olaylar şöyledir: ..."}

II. HUKUKİ DEĞERLENDİRME
Bu çerçevede; ${input.citations?.[0] ? `Yargıtay ${input.citations[0].chamber} ${input.citations[0].decisionNumber} sayılı kararında` : "ilgili içtihatta"} "...ilgili hukuki kural..." hükümleriyle yol gösterilmiştir.

${input.citations?.map((c: any, i: number) => `${i + 1}. ${c.court} ${c.chamber} ${c.decisionNumber} (${c.date}): ${c.excerpt}`).join("\n\n") || "İlgili mevzuat ve içtihat araştırması yapılmaktadır."}

III. SONUÇ
Yukarıda açıklanan nedenlerle, davacının istemleri yerinde ve kabulüne değerdir.

EKLER:
1. Vekaletname
2. Ücret Sözleşmesi
3. Keşif/Müttefik Belgeleri
4. Diğer deliller

.........................................................
${cs?.lawyers?.[0]?.user?.name || "AVUKAT ADI"}
${cs?.lawyers?.[0]?.user?.barNumber || "......."} No'lu Avukat
İstanbul Barosu`;

        // Save petition draft
        const petition = await prisma.petition.create({
          data: {
            caseId: input.caseId,
            title: `${input.petitionType} Dilekçesi`,
            content: draft,
            status: "PENDING",
            modelUsed: "opus-5.5-high",
            metadata: { petitionType: input.petitionType },
          },
        });

        return { petitionId: petition.id, content: draft };
      },
    },
    {
      name: "create_approval_request",
      description: "Avukat onayı için approval request oluştur",
      inputSchema: {
        type: "object",
        properties: {
          petitionId: { type: "string" },
          lawyerIds: { type: "array", items: { type: "string" } },
        },
        required: ["petitionId", "lawyerIds"],
      },
      execute: async (input, context) => {
        const approvals = await Promise.all(
          input.lawyerIds.map((lawyerId) =>
            prisma.approval.create({
              data: {
                type: "petition",
                resourceId: input.petitionId,
                resourceType: "Petition",
                title: "Dilekçe Taslağı Onayı",
                description: "Oluşturulan dilekçe taslağını inceleyin, gerekli düzeltmeleri yapın ve onaylayın",
                status: "PENDING",
                requestedById: context.userId,
                approverId: lawyerId,
              },
            })
          )
        );
        return { approvalsCreated: approvals.length };
      },
    },
  ];

  canHandle(input: any): boolean {
    const keywords = ["dilekçe", "taslak", "şablon", "inceleme", "antet", "imza", "uyap'a", "verelim", "dava", "cevap", "itiraz", "temyiz", "istinaf"];
    return keywords.some((k) => JSON.stringify(input).toLowerCase().includes(k));
  }

  async execute(input: string, context: AgentContext): Promise<AgentResponse> {
    try {
      logger.info({ caseId: context.caseId }, "Petition & Review processing");

      if (!context.caseId) {
        return { success: false, error: "caseId gerekli" };
      }

      // Determine petition type from input
      const petitionType = this.detectPetitionType(input);

      // Get case summary
      const caseSummary = await this.tools[0].execute({ caseId: context.caseId }, context);

      // Get template
      const template = await this.tools[1].execute(
        { lawFirmId: context.lawFirmId, petitionType },
        context
      );

      // Get style skill
      const styleSkill = await this.tools[2].execute({ lawFirmId: context.lawFirmId }, context);

      // Get relevant research memos for citations
      const researchMemos = await prisma.researchMemo.findMany({
        where: { caseId: context.caseId },
        orderBy: { createdAt: "desc" },
        take: 5,
      });
      const citations = researchMemos.flatMap((m) => (m.citations as any[] || []));

      // Generate petition draft
      const draftResult = await this.tools[3].execute(
        {
          caseId: context.caseId,
          templateContent: template.content,
          styleRules: styleSkill.styleRules,
          caseSummary,
          citations,
          petitionType,
        },
        context
      );

      // Create approval request for lawyers
      const caseLawyers = await prisma.caseLawyer.findMany({
        where: { caseId: context.caseId },
        include: { user: true },
      });

      if (caseLawyers.length > 0) {
        await this.tools[4].execute(
          { petitionId: draftResult.petitionId, lawyerIds: caseLawyers.map((cl) => cl.userId) },
          context
        );
      }

      return {
        success: true,
        output: {
          petitionId: draftResult.petitionId,
          petitionType,
          draft: draftResult.content,
          status: "PENDING_APPROVAL",
          nextStep: "Avukat OnlyOffice'de izlenen değişikliklerle inceleyip onaylayacak",
        },
        toolsUsed: ["get_case_summary", "get_office_template", "get_style_skill", "generate_petition_draft", "create_approval_request"],
      };
    } catch (error) {
      logger.error({ error }, "Petition & Review failed");
      return { success: false, error: String(error) };
    }
  }

  private detectPetitionType(input: string): string {
    const lower = input.toLowerCase();
    if (lower.includes("temyiz")) return "temyiz";
    if (lower.includes("istinaf")) return "istinaf";
    if (lower.includes("itiraz")) return "itiraz";
    if (lower.includes("icra")) return "icra";
    if (lower.includes("cevap")) return "cevap";
    return "dava";
  }

  private getDefaultTemplate(type: string): string {
    return `[BÜRO ANTETİ]
Tarih: {{date}}

{{courtName}}
Esas No: {{esasNo}}

KONU: {{petitionType}} DAVASI

DAVACI: {{plaintiff}}
DAVALI: {{defendant}}

İSTEK:
{{#each requests}}
{{this}}
{{/each}}

GEREKÇE:
{{reasoning}}

EKLER:
{{#each attachments}}
{{this}}
{{/each}}

{{lawyerName}}
{{barNumber}} No'lu Avukat`;
  }
}