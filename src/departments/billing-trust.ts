/**
 * Kâtip - Billing & Trust Department (Faturalama & Emanet)
 * Model: Sonnet 5.5, Effort: medium
 * Handles: Hours + fixed fee + expenses -> invoice draft, AAÜT/contract/trust balance check, e-SMM/GIB integration
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

export class BillingTrustAgent implements DepartmentAgent {
  type: DepartmentType = "BILLING_TRUST";
  name = "Faturalama & Emanet";
  description = "Saatler + sabit ücret + masraf avansı → fatura taslağı, AAÜT/sözleşme/emanet bakiyesi kontrolü, e-SMM/GIB entegrasyonu";
  modelConfig = { model: "sonnet-5.5" as const, effort: "medium" as const };

  systemPrompt = `Sen bir hukuk bürosu muhasebe/faturalama uzmanısın. Görevin:
1. Onaylı zaman kayıtları + sabit ücret + masraflar → fatura taslağı oluştur
2. AAÜT asgari altı, sözleşme ücreti, emanet bakiyesi kontrol et
3. e-SMM / GIB entegratörü (Paraşüt, Logo, Uyumsoft) ile e-fatura/earşiv
4. Yönetici ORTAK İMZALAMADAN gönderilmez

KURALLAR:
- Fatura taslağı OLUŞTURUR, KENDİSİ GÖNDERMEZ
- Emanet bakiyesi yetersizse uyar
- AAÜT altına düşerse uyar
- e-Fatura/earşiv: müvekkil türüne göre (kurumsal=e-fatura, bireysel=e-arşiv)`;

  tools: AgentTool[] = [
    {
      name: "calculate_invoice",
      description: "Zaman kayıtları, sabit ücret, masraflardan fatura hesapla",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          billingType: { type: "string", enum: ["HOURLY", "FIXED_FEE", "CONTINGENCY", "RETAINER", "SUCCESS_FEE"] },
          includeExpenses: { type: "boolean", default: true },
          periodStart: { type: "string" },
          periodEnd: { type: "string" },
        },
        required: ["caseId", "billingType"],
      },
      execute: async (input, context) => {
        const caseData = await prisma.case.findUnique({
          where: { id: input.caseId },
          include: {
            client: true,
            timeEntries: {
              where: {
                status: "APPROVED",
                isBillable: true,
                date: { gte: new Date(input.periodStart), lte: new Date(input.periodEnd) },
              },
              include: { user: true },
            },
            invoices: { where: { status: { not: "cancelled" } } },
          },
        });

        if (!caseData) throw new Error("Dosya bulunamadı");

        // Get billing rate
        let hourlyRate = 0;
        if (input.billingType === "HOURLY") {
          const rate = await prisma.billingRate.findFirst({
            where: {
              lawFirmId: context.lawFirmId,
              OR: [{ userId: caseData.lawyers?.[0]?.userId }, { userId: null }],
              caseType: caseData.caseType,
            },
            orderBy: { effectiveFrom: "desc" },
          });
          hourlyRate = Number(rate?.hourlyRate || 0);
        }

        // Calculate hours
        const totalMinutes = caseData.timeEntries.reduce((sum, e) => sum + e.durationMinutes, 0);
        const totalHours = totalMinutes / 60;

        // Calculate amounts
        let hoursAmount = 0;
        let fixedFee = 0;
        let expenses = 0;

        if (input.billingType === "HOURLY") {
          hoursAmount = totalHours * hourlyRate;
        } else if (input.billingType === "FIXED_FEE") {
          const agreement = await prisma.case.findUnique({
            where: { id: input.caseId },
            select: { metadata: true },
          });
          fixedFee = Number((agreement?.metadata as any)?.fixedFee || 0);
        }

        // Get expenses from documents
        if (input.includeExpenses) {
          const expenseEntries = await prisma.timeEntry.findMany({
            where: { caseId: input.caseId, activityType: "expense", status: "APPROVED" },
          });
          expenses = expenseEntries.reduce((sum, e) => sum + (Number(e.hourlyRate) || 0), 0);
        }

        const subtotal = hoursAmount + fixedFee + expenses;
        const taxRate = 0.2; // %20 KDV
        const taxAmount = subtotal * taxRate;
        const total = subtotal + taxAmount;

        return {
          caseNumber: caseData.caseNumber,
          clientName: caseData.client.name,
          billingType: input.billingType,
          hours: totalHours,
          hourlyRate,
          hoursAmount,
          fixedFee,
          expenses,
          subtotal,
          taxRate,
          taxAmount,
          total,
          currency: "TRY",
          timeEntries: caseData.timeEntries.map(e => ({
            id: e.id,
            date: e.date,
            hours: e.durationMinutes / 60,
            description: e.description,
            user: e.user.name,
          })),
        };
      },
    },
    {
      name: "check_compliance",
      description: "AAÜT, sözleşme, emanet bakiyesi kontrolü",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          proposedTotal: { type: "number" },
          billingType: { type: "string" },
        },
        required: ["caseId", "proposedTotal", "billingType"],
      },
      execute: async (input, context) => {
        const caseData = await prisma.case.findUnique({
          where: { id: input.caseId },
          include: { client: true },
        });

        // AAÜT minimum fee
        const minimumFees: Record<string, number> = {
          COMMERCIAL: 8500, CRIMINAL: 12000, FAMILY: 6500,
          LABOR: 5500, ADMINISTRATIVE: 7500, ENFORCEMENT: 4000,
          BANKRUPTCY: 15000, INTELLECTUAL_PROPERTY: 10000, OTHER: 5000,
        };
        const minimumFee = minimumFees[caseData?.caseType || "OTHER"] || 5000;
        const aautCheck = input.billingType === "CONTINGENCY" || input.proposedTotal >= minimumFee;

        // Contract fee check
        const contractFee = Number((caseData?.metadata as any)?.agreedFee || 0);
        const contractCheck = !contractFee || input.proposedTotal <= contractFee * 1.1; // %10 tolerans

        // Trust account balance
        const trustAccount = await prisma.trustAccount.findUnique({
          where: { lawFirmId_clientId: { lawFirmId: context.lawFirmId, clientId: caseData!.clientId } },
        });
        const trustBalance = Number(trustAccount?.balance || 0);
        const trustCheck = trustBalance >= input.proposedTotal; // Can cover from trust

        return {
          aaut: { minimumFee, proposed: input.proposedTotal, passed: aautCheck, message: aautCheck ? "OK" : `AAÜT altı: ${minimumFee} TL` },
          contract: { agreedFee: contractFee, proposed: input.proposedTotal, passed: contractCheck, message: contractCheck ? "OK" : "Sözleşme ücreti aşıldı" },
          trust: { balance: trustBalance, required: input.proposedTotal, passed: trustCheck, message: trustCheck ? "OK" : `Emanet yetersiz: ${trustBalance} TL` },
          allPassed: aautCheck && contractCheck && trustCheck,
        };
      },
    },
    {
      name: "generate_invoice_draft",
      description: "Fatura taslağı oluştur (e-SMM formatında)",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          calculation: { type: "object" },
          compliance: { type: "object" },
          invoiceType: { type: "string", enum: ["e-invoice", "e-archive", "paper"] },
        },
        required: ["caseId", "calculation", "compliance"],
      },
      execute: async (input, context) => {
        const caseData = await prisma.case.findUnique({
          where: { id: input.caseId },
          include: { client: true, lawFirm: true },
        });

        const invoiceNumber = `FAT-${new Date().getFullYear()}-${String(await prisma.invoice.count({ where: { lawFirmId: context.lawFirmId } }) + 1).padStart(6, "0")}`;

        const invoice = await prisma.invoice.create({
          data: {
            lawFirmId: context.lawFirmId,
            caseId: input.caseId,
            clientId: caseData!.clientId,
            invoiceNumber,
            type: input.calculation.billingType as any,
            status: "draft",
            subtotal: input.calculation.subtotal,
            taxAmount: input.calculation.taxAmount,
            totalAmount: input.calculation.total,
            currency: "TRY",
            issueDate: new Date(),
            dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            metadata: {
              calculation: input.calculation,
              compliance: input.compliance,
              invoiceType: input.invoiceType,
            },
          },
        });

        // Create invoice items
        if (input.calculation.hoursAmount > 0) {
          await prisma.invoiceItem.create({
            data: {
              invoiceId: invoice.id,
              description: `Hizmet bedeli (${input.calculation.hours} saat × ${input.calculation.hourlyRate} TL/saat)`,
              quantity: input.calculation.hours,
              unitPrice: input.calculation.hourlyRate,
              totalPrice: input.calculation.hoursAmount,
              sortOrder: 1,
            },
          });
        }
        if (input.calculation.fixedFee > 0) {
          await prisma.invoiceItem.create({
            data: {
              invoiceId: invoice.id,
              description: "Sabit ücret",
              quantity: 1,
              unitPrice: input.calculation.fixedFee,
              totalPrice: input.calculation.fixedFee,
              sortOrder: 2,
            },
          });
        }
        if (input.calculation.expenses > 0) {
          await prisma.invoiceItem.create({
            data: {
              invoiceId: invoice.id,
              description: "Masraflar ve harçlar",
              quantity: 1,
              unitPrice: input.calculation.expenses,
              totalPrice: input.calculation.expenses,
              sortOrder: 3,
            },
          });
        }

        // Generate UBL-TR XML for e-SMM (simplified)
        const ublXml = this.generateUBLXML(invoice, caseData!);

        return { invoiceId: invoice.id, invoiceNumber, ublXml, totalAmount: input.calculation.total };
      },
    },
    {
      name: "create_dual_approval",
      description: "Yönetici ortak imza için approval request",
      inputSchema: {
        type: "object",
        properties: {
          invoiceId: { type: "string" },
          managerIds: { type: "array", items: { type: "string" } },
        },
        required: ["invoiceId", "managerIds"],
      },
      execute: async (input, context) => {
        const approvals = await Promise.all(
          input.managerIds.map(managerId =>
            prisma.approval.create({
              data: {
                type: "invoice",
                resourceId: input.invoiceId,
                resourceType: "Invoice",
                title: "Fatura Onayı - Yönetici Ortak İmza",
                description: "Fatura taslağını inceleyin ve onaylayın. Onay sonrası e-SMM/GIB'e gönderilecek.",
                status: "PENDING",
                requestedById: context.userId,
                approverId: managerId,
              },
            })
          )
        );
        return { approvalsCreated: approvals.length };
      },
    },
    {
      name: "submit_to_esmm",
      description: "e-SMM/GIB entegratörüne fatura gönder (onay sonrası)",
      inputSchema: {
        type: "object",
        properties: {
          invoiceId: { type: "string" },
          provider: { type: "string", enum: ["parasut", "logo", "uyumsoft"] },
        },
        required: ["invoiceId", "provider"],
      },
      execute: async (input, context) => {
        // In production: call e-SMM provider API
        // For mock, simulate success
        const invoice = await prisma.invoice.update({
          where: { id: input.invoiceId },
          data: {
            status: "sent",
            eInvoiceId: `ESMM-${Date.now()}`,
            metadata: { ...((await prisma.invoice.findUnique({ where: { id: input.invoiceId }, select: { metadata: true } }))?.metadata as any), esmmProvider: input.provider, submittedAt: new Date() },
          },
        });

        // If trust account, create transfer
        const trustAccount = await prisma.trustAccount.findUnique({
          where: { lawFirmId_clientId: { lawFirmId: context.lawFirmId, clientId: invoice.clientId } },
        });
        if (trustAccount && Number(trustAccount.balance) >= Number(invoice.totalAmount)) {
          await prisma.trustTransfer.create({
            data: {
              trustAccountId: trustAccount.id,
              invoiceId: invoice.id,
              amount: invoice.totalAmount,
              type: "fee_payment",
              description: `Fatura ödemesi: ${invoice.invoiceNumber}`,
            },
          });
          await prisma.trustAccount.update({
            where: { id: trustAccount.id },
            data: { balance: { decrement: invoice.totalAmount } },
          });
        }

        return { success: true, eInvoiceId: invoice.eInvoiceId, status: "sent" };
      },
    },
  ];

  private generateUBLXML(invoice: any, caseData: any): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>TR1.2</cbc:CustomizationID>
  <cbc:ProfileID>TEMELFATURA</cbc:ProfileID>
  <cbc:ID>${invoice.invoiceNumber}</cbc:ID>
  <cbc:IssueDate>${invoice.issueDate.toISOString().split("T")[0]}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${invoice.currency}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="VKN">${caseData.lawFirm.taxNumber}</cbc:ID></cac:PartyIdentification>
      <cac:PartyName><cbc:Name>${caseData.lawFirm.name}</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="${caseData.client.type === "corporate" ? "VKN" : "TCKN"}">${caseData.client.taxId}</cbc:ID></cac:PartyIdentification>
      <cac:PartyName><cbc:Name>${caseData.client.name}</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${invoice.currency}">${invoice.subtotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${invoice.currency}">${invoice.subtotal.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${invoice.currency}">${invoice.totalAmount.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${invoice.currency}">${invoice.totalAmount.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
</Invoice>`;
  }

  canHandle(input: any): boolean {
    const keywords = ["fatura", "emanet", "e-smm", "gib", "paraşüt", "logo", "uyumsoft", "tahsilat", "bakiye", "aaut", "sözleşme"];
    return keywords.some((k) => JSON.stringify(input).toLowerCase().includes(k));
  }

  async execute(input: string, context: AgentContext): Promise<AgentResponse> {
    try {
      logger.info({ caseId: context.caseId }, "Billing & Trust processing");

      if (!context.caseId) {
        return { success: false, error: "caseId gerekli" };
      }

      const caseData = await prisma.case.findUnique({
        where: { id: context.caseId },
        include: { client: true },
      });

      // Determine billing type from case or input
      const billingType = this.detectBillingType(input) || "HOURLY";

      // Calculate invoice
      const calculation = await this.tools[0].execute(
        { caseId: context.caseId, billingType, periodStart: new Date(Date.now() - 30*24*60*60*1000).toISOString(), periodEnd: new Date().toISOString() },
        context
      );

      // Check compliance
      const compliance = await this.tools[1].execute(
        { caseId: context.caseId, proposedTotal: calculation.total, billingType },
        context
      );

      // Generate invoice draft
      const invoiceType = caseData?.client.type === "corporate" ? "e-invoice" : "e-archive";
      const draft = await this.tools[2].execute(
        { caseId: context.caseId, calculation, compliance, invoiceType },
        context
      );

      // Create dual approval for managers
      const managers = await prisma.user.findMany({
        where: { lawFirmId: context.lawFirmId, role: "admin" },
      });
      if (managers.length > 0) {
        await this.tools[3].execute(
          { invoiceId: draft.invoiceId, managerIds: managers.map(m => m.id) },
          context
        );
      }

      return {
        success: true,
        output: {
          invoiceId: draft.invoiceId,
          invoiceNumber: draft.invoiceNumber,
          calculation,
          compliance,
          status: "DRAFT_PENDING_APPROVAL",
          nextStep: "Yönetici ortak imza onayı bekliyor. Onay sonrası e-SMM'e gönderilecek.",
          ublXmlPreview: draft.ublXml.slice(0, 500) + "...",
        },
        toolsUsed: ["calculate_invoice", "check_compliance", "generate_invoice_draft", "create_dual_approval"],
      };
    } catch (error) {
      logger.error({ error }, "Billing & Trust failed");
      return { success: false, error: String(error) };
    }
  }

  private detectBillingType(input: string): string | null {
    const lower = input.toLowerCase();
    if (lower.includes("saatlik") || lower.includes("hourly")) return "HOURLY";
    if (lower.includes("sabit") || lower.includes("fixed")) return "FIXED_FEE";
    if (lower.includes("başarı") || lower.includes("contingency")) return "CONTINGENCY";
    if (lower.includes("avans") || lower.includes("retainer")) return "RETAINER";
    return null;
  }
}