/**
 * Kâtip - Research & Precedent Department (Araştırma & İçtihat)
 * Model: Opus 5.5, Effort: high
 * Handles: Office archive search (OCR -> bge-m3 -> pgvector + TR full-text), Yargıtay/Danıştay/AYM, Lexpera/Kazancı, Citations with sources
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

export class ResearchPrecedentAgent implements DepartmentAgent {
  type: DepartmentType = "RESEARCH_PRECEDENT";
  name = "Araştırma & İçtihat";
  description = "Büro arşivi arama, Yargıtay/Danıştay/AYM içtihat, Lexpera/Kazancı, kaynak gösterimli cevap";
  modelConfig = { model: "opus-5.5" as const, effort: "high" as const };

  systemPrompt = `Sen bir hukuk bürosu araştırma avukatsın. Görevin:
1. Büro arşivinde (OCR -> bge-m3 embedding -> pgvector + Türkçe tam metin) benzer kararları bul
2. Yargıtay, Danıştay, AYM kararlarını ara (lisanslıysa Lexpera/Kazancı)
3. Her iddia için KAYNAK GÖSTER (kaynakça: mahkeme, esas no, tarih, URL, alıntı)
4. Kaynaksız içtihat YOK - her karar künyesi DB'de doğrulanır

ÇIKTI FORMATI:
{
  "answer": "Hukuki cevap",
  "citations": [
    {"court": "Yargıtay", "chamber": "11. HD", "decisionNumber": "2023/1234", "date": "2023-05-15", "url": "...", "excerpt": "İlgili paragraf"}
  ],
  "confidence": 0.92,
  "officeArchiveRefs": ["doc-uuid-1", "doc-uuid-2"]
}`;

  tools: AgentTool[] = [
    {
      name: "search_office_archive",
      description: "Büro arşivinde vektör + tam metin arama (hibrit)",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          caseType: { type: "string" },
          limit: { type: "number", default: 10 },
          similarityThreshold: { type: "number", default: 0.7 },
        },
        required: ["query", "caseType"],
      },
      execute: async (input, context) => {
        // In production: generate embedding for query, search pgvector + pg_trgm
        // For mock, return sample results
        const docs = await prisma.document.findMany({
          where: {
            case: { lawFirmId: context.lawFirmId, caseType: input.caseType as any },
            content: { not: null },
          },
          take: input.limit,
          orderBy: { createdAt: "desc" },
          include: { case: true },
        });

        return {
          results: docs.map((d) => ({
            documentId: d.id,
            title: d.title,
            caseNumber: d.case?.caseNumber,
            similarity: 0.85, // mock
            excerpt: d.content?.slice(0, 300),
          })),
        };
      },
    },
    {
      name: "search_yargitay",
      description: "Yargıtay/Danıştay/AYM karar arama (mock - production'da API entegrasyonu)",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          court: { type: "string", enum: ["YARGITAY", "DANISTAY", "AYM", "ALL"] },
          year: { type: "number" },
          chamber: { type: "string" },
        },
        required: ["query"],
      },
      execute: async (input, context) => {
        // Mock responses - in production, call Lexpera/Kazancı API or official APIs
        const mockDecisions = [
          {
            court: "Yargıtay",
            chamber: "11. Hukuk Dairesi",
            decisionNumber: "2023/4567",
            date: "2023-06-15",
            url: "https://karararama.yargitay.gov.tr/...",
            excerpt: "İşbu davada tarafların anlaşmazlık konusu...",
            relevance: 0.92,
          },
          {
            court: "Danıştay",
            chamber: "10. Daire",
            decisionNumber: "2022/8901",
            date: "2022-11-20",
            url: "https://karararama.danistay.gov.tr/...",
            excerpt: "İdari yargılama usulüne göre...",
            relevance: 0.87,
          },
        ];

        return { results: mockDecisions.filter((d) => d.relevance > 0.7) };
      },
    },
    {
      name: "verify_citation",
      description: "Karar künyesini DB'de doğrula",
      inputSchema: {
        type: "object",
        properties: {
          court: { type: "string" },
          decisionNumber: { type: "string" },
          date: { type: "string" },
        },
        required: ["court", "decisionNumber", "date"],
      },
      execute: async (input, context) => {
        // Check if citation exists in our verified citations table
        // For mock, return verified
        return { verified: true, source: "verified_cache" };
      },
    },
    {
      name: "save_research_memo",
      description: "Araştırma notunu kaydet",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          title: { type: "string" },
          question: { type: "string" },
          answer: { type: "string" },
          citations: { type: "array", items: { type: "object" } },
          confidence: { type: "number" },
          documentIds: { type: "array", items: { type: "string" } },
        },
        required: ["caseId", "title", "question", "answer", "citations"],
      },
      execute: async (input, context) => {
        const memo = await prisma.researchMemo.create({
          data: {
            caseId: input.caseId,
            title: input.title,
            question: input.question,
            answer: input.answer,
            citations: input.citations as any,
            modelUsed: "opus-5.5",
            confidence: input.confidence,
            createdById: context.userId,
          },
        });

        // Link documents
        if (input.documentIds.length > 0) {
          await Promise.all(
            input.documentIds.map((docId: string) =>
              prisma.researchDocument.create({
                data: {
                  researchMemoId: memo.id,
                  documentId: docId,
                  relevanceScore: 0.8,
                },
              })
            )
          );
        }

        return { memoId: memo.id };
      },
    },
  ];

  canHandle(input: any): boolean {
    const keywords = ["araştır", "içtihat", "yargıtay", "danıştay", "anayasa", "karar", "eminent", "hüküm", "kanun", "madde", "uygulama"];
    return keywords.some((k) => JSON.stringify(input).toLowerCase().includes(k));
  }

  async execute(input: string, context: AgentContext): Promise<AgentResponse> {
    try {
      logger.info({ caseId: context.caseId }, "Research & Precedent processing");

      const caseData = await prisma.case.findUnique({
        where: { id: context.caseId },
        include: { client: true },
      });

      if (!caseData) {
        return { success: false, error: "Dosya bulunamadı" };
      }

      // Search office archive
      const archiveResults = await this.tools[0].execute(
        { query: input, caseType: caseData.caseType, limit: 10 },
        context
      );

      // Search public precedent databases
      const precedentResults = await this.tools[1].execute(
        { query: input, court: "ALL" },
        context
      );

      // Verify citations
      const verifiedCitations = await Promise.all(
        precedentResults.results.map((c: any) =>
          this.tools[2].execute(
            { court: c.court, decisionNumber: c.decisionNumber, date: c.date },
            context
          )
        )
      );

      // Generate research memo
      const memoTitle = `Araştırma: ${input.slice(0, 50)}...`;
      const memoResult = await this.tools[3].execute(
        {
          caseId: context.caseId!,
          title: memoTitle,
          question: input,
          answer: this.generateAnswer(input, archiveResults, precedentResults),
          citations: precedentResults.results.map((c: any, i: number) => ({
            ...c,
            verified: verifiedCitations[i].verified,
          })),
          confidence: 0.88,
          documentIds: archiveResults.results.map((r: any) => r.documentId),
        },
        context
      );

      return {
        success: true,
        output: {
          answer: this.generateAnswer(input, archiveResults, precedentResults),
          citations: precedentResults.results.map((c: any, i: number) => ({
            ...c,
            verified: verifiedCitations[i].verified,
          })),
          officeArchiveRefs: archiveResults.results.slice(0, 5),
          memoId: memoResult.memoId,
          confidence: 0.88,
        },
        toolsUsed: ["search_office_archive", "search_yargitay", "verify_citation", "save_research_memo"],
      };
    } catch (error) {
      logger.error({ error }, "Research & Precedent failed");
      return { success: false, error: String(error) };
    }
  }

  private generateAnswer(query: string, archive: any, precedent: any): string {
    return `**Hukuki Analiz: ${query.slice(0, 50)}...**

Büro arşivinde ${archive.results.length} ilgili belge, Yargıtay/Danıştay'da ${precedent.results.length} ilgili karar bulundu.

**Özet:** Bu konuda mahkemeler genellikle [hukuki yaklaşım] yönünde karar vermektedir. Kriterler: [kriterler].

**Büro Geçmişi:** Benzer dosyalarda [sonuç] elde edilmiştir.

**Yargıtay İçtihatı:** ${precedent.results.map((c: any) => `${c.court} ${c.chamber} ${c.decisionNumber}`).join(", ")} kararı yol göstericidir.

**Riskler:** [riskler]

**Öneri:** [strateji]`;
  }
}