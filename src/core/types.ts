/**
 * Kâtip - Core Types
 * Shared types for the agent system
 */

export type DepartmentType =
  | "INTAKE_RECEPTION"
  | "CONFLICT_POWER_OF_ATTORNEY"
  | "DEADLINES_HEARINGS"
  | "RESEARCH_PRECEDENT"
  | "PETITION_REVIEW"
  | "EMAIL_CLIENT"
  | "TIME_TRACKING"
  | "BILLING_TRUST";

export type ModelType = "haiku-5.5" | "sonnet-5.5" | "opus-5.5";
export type EffortLevel = "low" | "medium" | "high";

export interface ModelConfig {
  model: ModelType;
  effort: EffortLevel;
  temperature?: number;
  maxTokens?: number;
}

export const DEPARTMENT_MODEL_CONFIG: Record<DepartmentType, ModelConfig> = {
  INTAKE_RECEPTION: { model: "haiku-5.5", effort: "low" },
  CONFLICT_POWER_OF_ATTORNEY: { model: "haiku-5.5", effort: "low" },
  DEADLINES_HEARINGS: { model: "sonnet-5.5", effort: "medium" },
  RESEARCH_PRECEDENT: { model: "opus-5.5", effort: "high" },
  PETITION_REVIEW: { model: "opus-5.5", effort: "high" },
  EMAIL_CLIENT: { model: "sonnet-5.5", effort: "medium" },
  TIME_TRACKING: { model: "haiku-5.5", effort: "low" },
  BILLING_TRUST: { model: "sonnet-5.5", effort: "medium" },
};

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: object;
  execute: (input: any, context: AgentContext) => Promise<any>;
}

export interface AgentContext {
  caseId?: string;
  lawFirmId: string;
  userId: string;
  sensitivityLevel: "L1_NORMAL" | "L2_SENSITIVE" | "L3_HIGHLY_CONFIDENTIAL";
  metadata: Record<string, any>;
}

export interface AgentResponse {
  success: boolean;
  output?: any;
  error?: string;
  toolsUsed?: string[];
  tokensUsed?: {
    prompt: number;
    completion: number;
    total: number;
  };
  estimatedCost?: number;
}

export interface DepartmentAgent {
  type: DepartmentType;
  name: string;
  description: string;
  systemPrompt: string;
  modelConfig: ModelConfig;
  tools: AgentTool[];
  canHandle: (input: any) => boolean;
  execute: (input: any, context: AgentContext) => Promise<AgentResponse>;
}

export interface RoutingDecision {
  department: DepartmentType;
  confidence: number;
  reasoning: string;
  requiresApproval: boolean;
}

export interface ApprovalRequest {
  id: string;
  type: string;
  resourceId: string;
  resourceType: string;
  title: string;
  description: string;
  department: DepartmentType;
  requestedBy: string;
  assignedTo?: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, any>;
}

export interface DailyBriefing {
  date: Date;
  lawFirmId: string;
  items: {
    hearingsToday: any[];
    deadlinesThisWeek: any[];
    overnightIntakes: any[];
    pendingApprovals: any[];
    unapprovedTimeEntries: any[];
    unpaidInvoices: any[];
  };
  generatedAt: Date;
}