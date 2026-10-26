/**
 * Kâtip - Core Orchestrator
 * Routes requests to appropriate department agents using Haiku 5.5 as router
 */

import { env } from "@/config/env";
import { logger, aiLogger } from "@/config/logger";
import { prisma } from "@/config/db";
import { privacyShield } from "@/privacy/shield";
import {
  DepartmentType,
  DepartmentAgent,
  AgentContext,
  AgentResponse,
  RoutingDecision,
  ModelConfig,
  DEPARTMENT_MODEL_CONFIG,
  DailyBriefing,
} from "./types";

// Import department agents (will create these next)
import { IntakeReceptionAgent } from "@/departments/intake-reception";
import { ConflictPowerOfAttorneyAgent } from "@/departments/conflict-power-of-attorney";
import { DeadlinesHearingsAgent } from "@/departments/deadlines-hearings";
import { ResearchPrecedentAgent } from "@/departments/research-precedent";
import { PetitionReviewAgent } from "@/departments/petition-review";
import { EmailClientAgent } from "@/departments/email-client";
import { TimeTrackingAgent } from "@/departments/time-tracking";
import { BillingTrustAgent } from "@/departments/billing-trust";

export class KatipCore {
  private routerModel: ModelConfig = { model: "haiku-5.5", effort: "low" };
  private departments: Map<DepartmentType, DepartmentAgent> = new Map();
  private initialized = false;

  constructor() {
    this.initializeDepartments();
  }

  private initializeDepartments() {
    const agents: DepartmentAgent[] = [
      new IntakeReceptionAgent(),
      new ConflictPowerOfAttorneyAgent(),
      new DeadlinesHearingsAgent(),
      new ResearchPrecedentAgent(),
      new PetitionReviewAgent(),
      new EmailClientAgent(),
      new TimeTrackingAgent(),
      new BillingTrustAgent(),
    ];

    for (const agent of agents) {
      this.departments.set(agent.type, agent);
    }

    this.initialized = true;
    logger.info({ departments: agents.map((a) => a.type) }, "Kâtip Core initialized with departments");
  }

  /**
   * Route incoming request to appropriate department
   * Uses Haiku 5.5 for fast, cheap routing
   */
  async route(input: string, context: AgentContext): Promise<RoutingDecision> {
    const routingPrompt = `Sen Kâtip hukuk bürosu AI sisteminin yönlendiricisisin. Gelen isteği analiz et ve hangi departmana gitmesi gerektiğini belirle.

DEPARTMANLAR:
1. INTAKE_RECEPTION - Kabuł & Resepsiyon: Yeni müvekkil kabulü, telefon karşılama, çatışma kontrolü yönlendirmesi, Cal.com randevusu
2. CONFLICT_POWER_OF_ATTORNEY - Çatışma & Vekalet: TCKN/VKN eşleşmesi, vekaletname/ücret sözleşmesi taslağı, AAÜT kontrolü
3. DEADLINES_HEARINGS - Süreler & Duruşma: UYAP evrak çıkarma, HMK süre hesaplama, 7/3/1 gün uyarısı, takvim
4. RESEARCH_PRECEDENT - Araştırma & İçtihat: Büro arşivi arama, Yargıtay/Danıştay/AYM, içtihat özeti, kaynak gösterimli
5. PETITION_REVIEW - Dilekçe & İnceleme: Dosya özeti + içtihat + şablon → dilekçe taslağı, OnlyOffice izlenen değişiklikler
6. EMAIL_CLIENT - E-posta & Müvekkil: Gelen kutusu sınıflandırma, büro tonunda yanıt taslağı, haftalık durum özeti
7. TIME_TRACKING - Zaman Kaydı: E-posta/toplantı/telefon → dosya eşleme, Kimai taslak, 18:00 onay ekranı
8. BILLING_TRUST - Faturalama & Emanet: Saatler + sabit ücret + masraf → fatura, AAÜT/emanet kontrolü, e-SMM

GÖREV: Sadece JSON döndür:
{
  "department": "DEPARTMENT_TYPE",
  "confidence": 0.95,
  "reasoning": "Kısa neden",
  "requiresApproval": true/false
}

İSTEK: "${input}"`;

    try {
      // In production, this would call Bedrock/Anthropic API
      // For now, use keyword-based routing as fallback
      return this.keywordRoute(input);
    } catch (error) {
      aiLogger.error({ error, input }, "Routing failed, using keyword fallback");
      return this.keywordRoute(input);
    }
  }

  private keywordRoute(input: string): RoutingDecision {
    const lower = input.toLowerCase();

    const keywords: Record<DepartmentType, string[]> = {
      INTAKE_RECEPTION: ["kabul", "yeni müvekkil", "telefon", "aranıyor", "randevu", "cal.com", "ilk görüşme"],
      CONFLICT_POWER_OF_ATTORNEY: ["çatışma", "vekalet", "vekaletname", "ücret sözleşmesi", "tckn", "vkn", "eşleşme"],
      DEADLINES_HEARINGS: ["süre", "duruşma", "uyap", "tevdi", "hüküm", "temyiz", "istinaf", "takvim", "hatırlatma"],
      RESEARCH_PRECEDENT: ["araştır", "içtihat", "yargıtay", "danıştay", "anayasa", "karar", "eminent", "hüküm"],
      PETITION_REVIEW: ["dilekçe", "taslak", "şablon", "inceleme", "antet", "imza", "uyap'a", "verelim"],
      EMAIL_CLIENT: ["e-posta", "email", "gelen kutusu", "yanıt", "müvekkil", "haftalık", "özet"],
      TIME_TRACKING: ["zaman", "saat", "kimai", "faturalanabilir", "toplantı", "not", "18:00", "onayla"],
      BILLING_TRUST: ["fatura", "emanet", "e-smm", "gib", "paraşüt", "logo", "uyumsoft", "tahsilat", "bakiye"],
    };

    let bestMatch: DepartmentType = "INTAKE_RECEPTION";
    let maxScore = 0;

    for (const [dept, kws] of Object.entries(keywords)) {
      const score = kws.filter((kw) => lower.includes(kw)).length;
      if (score > maxScore) {
        maxScore = score;
        bestMatch = dept as DepartmentType;
      }
    }

    return {
      department: bestMatch,
      confidence: maxScore > 0 ? 0.7 + maxScore * 0.05 : 0.5,
      reasoning: `Anahtar kelime eşleşmesi: ${maxScore}`,
      requiresApproval: this.requiresApproval(bestMatch),
    };
  }

  private requiresApproval(department: DepartmentType): boolean {
    // All departments except intake require approval for output
    return department !== "INTAKE_RECEPTION";
  }

  /**
   * Execute request through the appropriate department
   */
  async execute(input: string, context: AgentContext): Promise<AgentResponse> {
    const startTime = Date.now();

    // Apply privacy shield based on sensitivity level
    const privacyResult = await privacyShield.deidentify(input, {
      level: context.sensitivityLevel,
      language: "tr",
    });

    if (!privacyResult.canSendToCloud) {
      return {
        success: false,
        error: "L3 hassasiyetli içerik buluta gönderilemez. Yerel işlem gerekli.",
      };
    }

    // Route to department
    const routing = await this.route(privacyResult.maskedText, context);
    const department = this.departments.get(routing.department);

    if (!department) {
      return {
        success: false,
        error: `Departman bulunamadı: ${routing.department}`,
      };
    }

    aiLogger.info(
      { department: routing.department, confidence: routing.confidence, tokens: privacyResult.maskedText.length },
      "Routing to department"
    );

    // Execute department agent
    const result = await department.execute(privacyResult.maskedText, context);

    // Re-identify output if L2
    if (privacyResult.sensitivityLevel === "L2_SENSITIVE" && result.output) {
      const reidentified = privacyShield.reidentify({
        maskedText: typeof result.output === "string" ? result.output : JSON.stringify(result.output),
        pseudonymMap: privacyResult.pseudonymMap,
      });
      result.output = reidentified;
    }

    // Log AI interaction for cost tracking
    await this.logAIInteraction({
      department: routing.department,
      model: DEPARTMENT_MODEL_CONFIG[routing.department].model,
      effort: DEPARTMENT_MODEL_CONFIG[routing.department].effort,
      promptTokens: privacyResult.maskedText.length / 4, // rough estimate
      completionTokens: result.tokensUsed?.completion || 0,
      totalTokens: result.tokensUsed?.total || 0,
      estimatedCost: result.estimatedCost || 0,
      caseId: context.caseId,
    });

    aiLogger.info(
      {
        department: routing.department,
        duration: Date.now() - startTime,
        success: result.success,
        cost: result.estimatedCost
      },
      "Department execution complete"
    );

    return result;
  }

  /**
   * Generate daily 08:00 briefing for all lawyers
   */
  async generateDailyBriefing(lawFirmId: string, date: Date = new Date()): Promise<DailyBriefing> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const nextWeek = new Date(date);
    nextWeek.setDate(nextWeek.getDate() + 7);

    const [
      hearingsToday,
      deadlinesThisWeek,
      overnightIntakes,
      pendingApprovals,
      unapprovedTimeEntries,
      unpaidInvoices,
    ] = await Promise.all([
      // Bugünkü duruşmalar
      prisma.hearing.findMany({
        where: {
          case: { lawFirmId },
          hearingDate: { gte: startOfDay, lte: endOfDay },
        },
        include: { case: { include: { client: true } } },
        orderBy: { hearingDate: "asc" },
      }),
      // 7 gün içindeki süreler
      prisma.deadline.findMany({
        where: {
          case: { lawFirmId },
          dueDate: { gte: startOfDay, lte: nextWeek },
          status: { in: ["PENDING", "IN_PROGRESS"] },
        },
        include: { case: { include: { client: true } } },
        orderBy: { dueDate: "asc" },
      }),
      // Gece gelen aramalar/kabuller
      prisma.case.findMany({
        where: {
          lawFirmId,
          createdAt: { gte: new Date(date.getTime() - 24 * 60 * 60 * 1000) },
        },
        include: { client: true, lawyers: { include: { user: true } } },
        orderBy: { createdAt: "desc" },
      }),
      // Onay bekleyen taslaklar
      prisma.approval.findMany({
        where: {
          requestedBy: { lawFirmId },
          status: "PENDING",
        },
        include: { requestedBy: true, approver: true },
        orderBy: { requestedAt: "asc" },
      }),
      // Dünden onaylanmamış zaman kayıtları
      prisma.timeEntry.findMany({
        where: {
          case: { lawFirmId },
          status: "PENDING",
          date: { gte: new Date(date.getTime() - 24 * 60 * 60 * 1000) },
        },
        include: { case: { include: { client: true } }, user: true },
        orderBy: { date: "desc" },
      }),
      // Tahsil edilmemiş faturalar
      prisma.invoice.findMany({
        where: {
          lawFirmId,
          status: { in: ["sent", "overdue"] },
        },
        include: { client: true, case: true },
        orderBy: { dueDate: "asc" },
      }),
    ]);

    const briefing: DailyBriefing = {
      date,
      lawFirmId,
      items: {
        hearingsToday,
        deadlinesThisWeek,
        overnightIntakes,
        pendingApprovals,
        unapprovedTimeEntries,
        unpaidInvoices,
      },
      generatedAt: new Date(),
    };

    // Save to DB
    await prisma.dailyBriefing.upsert({
      where: { lawFirmId_date: { lawFirmId, date } },
      create: { lawFirmId, date, content: briefing as any },
      update: { content: briefing as any, generatedAt: new Date() },
    });

    return briefing;
  }

  /**
   * Log AI interaction for cost tracking
   */
  private async logAIInteraction(data: {
    department: string;
    model: string;
    effort: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
    caseId?: string;
  }) {
    try {
      await prisma.aIInteraction.create({
        data: {
          department: data.department,
          model: data.model,
          effort: data.effort,
          promptTokens: data.promptTokens,
          completionTokens: data.completionTokens,
          totalTokens: data.totalTokens,
          estimatedCost: data.estimatedCost,
          promptHash: "",
          responseHash: "",
          caseId: data.caseId,
        },
      });
    } catch (error) {
      aiLogger.error({ error }, "Failed to log AI interaction");
    }
  }

  /**
   * Get department by type
   */
  getDepartment(type: DepartmentType): DepartmentAgent | undefined {
    return this.departments.get(type);
  }

  /**
   * List all departments
   */
  listDepartments(): DepartmentAgent[] {
    return Array.from(this.departments.values());
  }
}

// Singleton
export const katipCore = new KatipCore();