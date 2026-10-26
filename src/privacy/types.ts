/**
 * Kâtip - Privacy Shield Types
 * Type definitions for the privacy protection layer
 */

export type SensitivityLevel = "L1_NORMAL" | "L2_SENSITIVE" | "L3_HIGHLY_CONFIDENTIAL";

export interface PiiEntity {
  type: string;
  value: string;
  start: number;
  end: number;
  confidence: number;
  pseudonym?: string;
}

export interface PseudonymMap {
  [pseudonym: string]: {
    original: string;
    type: string;
    occurrence: number;
  };
}

export interface PrivacyShieldResult {
  maskedText: string;
  pseudonymMap: PseudonymMap;
  entities: PiiEntity[];
  sensitivityLevel: SensitivityLevel;
  canSendToCloud: boolean;
}

export interface DeidentificationConfig {
  level: SensitivityLevel;
  customRecognizers?: CustomRecognizer[];
  language: "tr" | "en";
}

export interface CustomRecognizer {
  entityType: string;
  patterns: Array<{
    name: string;
    regex: string;
    score: number;
  }>;
  contextWords?: string[];
}

export interface ReidentificationRequest {
  maskedText: string;
  pseudonymMap: PseudonymMap;
}

export const TURKISH_PII_TYPES = {
  // Kimlik
  TCKN: "TCKN",           // TC Kimlik No
  VKN: "VKN",             // Vergi Kimlik No
  PASSPORT: "PASSPORT",   // Pasaport No
  DRIVING_LICENSE: "DRIVING_LICENSE", // Ehliyet No

  // Kişisel
  PERSON_NAME: "PERSON_NAME",
  PHONE_NUMBER: "PHONE_NUMBER",
  EMAIL: "EMAIL",
  ADDRESS: "ADDRESS",
  IBAN: "IBAN",
  CREDIT_CARD: "CREDIT_CARD",

  // Sağlık (KVKK özel nitelikli)
  HEALTH_RECORD: "HEALTH_RECORD",
  PATIENT_ID: "PATIENT_ID",

  // Hukuk-spesifik
  CASE_NUMBER: "CASE_NUMBER",       // Esas No
  COURT_NAME: "COURT_NAME",
  LAWYER_NAME: "LAWYER_NAME",
  JUDGE_NAME: "JUDGE_NAME",
  EXPERT_NAME: "EXPERT_NAME",
  WITNESS_NAME: "WITNESS_NAME",

  // Tarih
  DATE: "DATE",
  DATE_TIME: "DATE_TIME",
} as const;

export type TurkishPiiType = typeof TURKISH_PII_TYPES[keyof typeof TURKISH_PII_TYPES];

// Pseudonym format: ⟦TYPE_N⟧
export function generatePseudonym(type: string, index: number): string {
  return `⟦${type}_${index}⟧`;
}

export function parsePseudonym(pseudonym: string): { type: string; index: number } | null {
  const match = pseudonym.match(/^⟦(.+)_(\d+)⟧$/);
  if (!match) return null;
  return { type: match[1], index: parseInt(match[2], 10) };
}