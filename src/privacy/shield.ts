/**
 * Kâtip - Privacy Shield Service
 * Handles PII detection, pseudonymization (L2), and blocking (L3)
 * Uses Microsoft Presidio + Turkish NER custom recognizers
 */

import { env } from "@/config/env";
import { logger, privacyLogger } from "@/config/logger";
import {
  SensitivityLevel,
  PiiEntity,
  PseudonymMap,
  PrivacyShieldResult,
  DeidentificationConfig,
  ReidentificationRequest,
  TurkishPiiType,
  TURKISH_PII_TYPES,
  generatePseudonym,
  parsePseudonym,
} from "./types";

export class PrivacyShield {
  private analyzerUrl: string;
  private anonymizerUrl: string;
  private customRecognizers: DeidentificationConfig["customRecognizers"] = [];
  private entityCounters: Map<string, number> = new Map();

  constructor() {
    this.analyzerUrl = env.PRESIDIO_ANALYZER_URL;
    this.anonymizerUrl = env.PRESIDIO_ANONYMIZER_URL;
    this.initializeCustomRecognizers();
  }

  private initializeCustomRecognizers() {
    this.customRecognizers = [
      // TC Kimlik No: 11 haneli, son rakam kontrol basamağı
      {
        entityType: TURKISH_PII_TYPES.TCKN,
        patterns: [
          {
            name: "TCKN Pattern",
            regex: "\\b[1-9]\\d{9}[02468]\\b",
            score: 0.95,
          },
        ],
        contextWords: ["tc", "kimlik", "kimlik no", "tc kimlik", "t.c."],
      },
      // Vergi Kimlik No: 10 haneli
      {
        entityType: TURKISH_PII_TYPES.VKN,
        patterns: [
          {
            name: "VKN Pattern",
            regex: "\\b\\d{10}\\b",
            score: 0.8,
          },
        ],
        contextWords: ["vergi", "vkn", "vergi no", "vergi kimlik"],
      },
      // IBAN: TR + 24 karakter
      {
        entityType: TURKISH_PII_TYPES.IBAN,
        patterns: [
          {
            name: "TR IBAN Pattern",
            regex: "\\bTR\\d{2}[A-Z0-9]{20}\\b",
            score: 0.98,
          },
        ],
        contextWords: ["iban", "hesap no", "hesap numarası"],
      },
      // Türk telefon numarası
      {
        entityType: TURKISH_PII_TYPES.PHONE_NUMBER,
        patterns: [
          {
            name: "TR Phone Pattern",
            regex: "\\b(\\+90|0)?5\\d{9}\\b",
            score: 0.9,
          },
        ],
        contextWords: ["telefon", "tel", "cep", "gsm"],
      },
      // Esas No: YYYY/NNNNN veya YYYY/NNNNN.ESAS
      {
        entityType: TURKISH_PII_TYPES.CASE_NUMBER,
        patterns: [
          {
            name: "Case Number Pattern",
            regex: "\\b(20\\d{2}|19\\d{2})\\/\\d{1,6}(?:\\.\\w+)?\\b",
            score: 0.9,
          },
        ],
        contextWords: ["esas", "esas no", "dosya no", "dosya"],
      },
      // Mahkeme adı
      {
        entityType: TURKISH_PII_TYPES.COURT_NAME,
        patterns: [
          {
            name: "Court Name Pattern",
            regex: "\\b\\w+\\s+(Asliye|Çocuk|Aile|İş|İcra|İflas|Ticaret|Ceza|Hukuk|İdare|Anayasa)\\s+(Mahkemesi|Mahkeme)\\b",
            score: 0.85,
          },
        ],
        contextWords: ["mahkeme", "mahkemesi"],
      },
    ];
  }

  private resetCounters() {
    this.entityCounters.clear();
  }

  private getNextIndex(type: string): number {
    const current = this.entityCounters.get(type) || 0;
    const next = current + 1;
    this.entityCounters.set(type, next);
    return next;
  }

  /**
   * Analyze text for PII entities using Presidio
   */
  async analyze(text: string, language = "tr"): Promise<PiiEntity[]> {
    try {
      const response = await fetch(`${this.analyzerUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          language,
          entities: undefined, // Use all entities
          correlation_id: crypto.randomUUID(),
          score_threshold: 0.5,
          return_decision_process: false,
          // Add custom recognizers
          ad_hoc_recognizers: this.customRecognizers.map((r) => ({
            entity_type: r.entityType,
            patterns: r.patterns,
            context_words: r.contextWords,
          })),
        }),
      });

      if (!response.ok) {
        throw new Error(`Presidio analyzer error: ${response.statusText}`);
      }

      const data = await response.json();
      return data.map((entity: any) => ({
        type: entity.entity_type,
        value: text.slice(entity.start, entity.end),
        start: entity.start,
        end: entity.end,
        confidence: entity.score,
      }));
    } catch (error) {
      privacyLogger.error({ error, text: text.slice(0, 100) }, "PII analysis failed");
      // Fallback: basic regex-based detection
      return this.fallbackAnalyze(text);
    }
  }

  /**
   * Fallback analysis using regex patterns
   */
  private fallbackAnalyze(text: string): PiiEntity[] {
    const entities: PiiEntity[] = [];

    // Email
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    let match;
    while ((match = emailRegex.exec(text)) !== null) {
      entities.push({
        type: TURKISH_PII_TYPES.EMAIL,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
        confidence: 0.95,
      });
    }

    // TCKN
    const tcknRegex = /\b[1-9]\d{9}[02468]\b/g;
    while ((match = tcknRegex.exec(text)) !== null) {
      entities.push({
        type: TURKISH_PII_TYPES.TCKN,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
        confidence: 0.9,
      });
    }

    // IBAN
    const ibanRegex = /\bTR\d{2}[A-Z0-9]{20}\b/g;
    while ((match = ibanRegex.exec(text)) !== null) {
      entities.push({
        type: TURKISH_PII_TYPES.IBAN,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
        confidence: 0.98,
      });
    }

    return entities;
  }

  /**
   * Anonymize text using Presidio
   */
  async anonymize(text: string, entities: PiiEntity[]): Promise<string> {
    try {
      const response = await fetch(`${this.anonymizerUrl}/anonymize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          analyzer_results: entities.map((e) => ({
            entity_type: e.type,
            start: e.start,
            end: e.end,
            score: e.confidence,
          })),
          operators: {
            DEFAULT: {
              type: "replace",
              new_value: "{{ENTITY_TYPE}}",
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Presidio anonymizer error: ${response.statusText}`);
      }

      const data = await response.json();
      return data.text;
    } catch (error) {
      privacyLogger.error({ error }, "Anonymization failed, using local replacement");
      return this.localAnonymize(text, entities);
    }
  }

  /**
   * Local anonymization with pseudonyms (L2)
   */
  private localAnonymize(text: string, entities: PiiEntity[]): string {
    let result = text;
    const sortedEntities = [...entities].sort((a, b) => b.start - a.start);

    for (const entity of sortedEntities) {
      const pseudonym = generatePseudonym(entity.type, this.getNextIndex(entity.type));
      entity.pseudonym = pseudonym;
      result = result.slice(0, entity.start) + pseudonym + result.slice(entity.end);
    }

    return result;
  }

  /**
   * Main deidentification function - handles L1/L2/L3
   */
  async deidentify(
    text: string,
    config: DeidentificationConfig
  ): Promise<PrivacyShieldResult> {
    this.resetCounters();
    const { level, language = "tr" } = config;

    // L3: Nothing goes to cloud
    if (level === "L3_HIGHLY_CONFIDENTIAL") {
      return {
        maskedText: "[L3: İÇERİK BULUTA GÖNDERİLMEZ]",
        pseudonymMap: {},
        entities: [],
        sensitivityLevel: level,
        canSendToCloud: false,
      };
    }

    // Analyze for PII
    const entities = await this.analyze(text, language);

    if (entities.length === 0) {
      return {
        maskedText: text,
        pseudonymMap: {},
        entities: [],
        sensitivityLevel: level,
        canSendToCloud: true,
      };
    }

    // L1: Send as-is (but log what would be masked)
    if (level === "L1_NORMAL") {
      privacyLogger.info(
        { entityCount: entities.length, types: entities.map((e) => e.type) },
        "L1: Text sent to cloud with PII (logged for audit)"
      );
      return {
        maskedText: text,
        pseudonymMap: {},
        entities,
        sensitivityLevel: level,
        canSendToCloud: true,
      };
    }

    // L2: Pseudonymize
    const pseudonymMap: PseudonymMap = {};
    const maskedText = await this.anonymizeWithPseudonyms(text, entities, pseudonymMap);

    privacyLogger.info(
      { entityCount: entities.length, pseudonymCount: Object.keys(pseudonymMap).length },
      "L2: Text pseudonymized for cloud"
    );

    return {
      maskedText,
      pseudonymMap,
      entities,
      sensitivityLevel: level,
      canSendToCloud: true,
    };
  }

  /**
   * Anonymize with pseudonyms instead of generic placeholders
   */
  private async anonymizeWithPseudonyms(
    text: string,
    entities: PiiEntity[],
    pseudonymMap: PseudonymMap
  ): Promise<string> {
    // Try Presidio first with custom operators
    try {
      const operators: Record<string, any> = {};
      for (const entity of entities) {
        const pseudonym = generatePseudonym(entity.type, this.getNextIndex(entity.type));
        entity.pseudonym = pseudonym;
        pseudonymMap[pseudonym] = {
          original: entity.value,
          type: entity.type,
          occurrence: this.entityCounters.get(entity.type) || 1,
        };
        operators[entity.type] = {
          type: "replace",
          new_value: pseudonym,
        };
      }

      const response = await fetch(`${this.anonymizerUrl}/anonymize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          analyzer_results: entities.map((e) => ({
            entity_type: e.type,
            start: e.start,
            end: e.end,
            score: e.confidence,
          })),
          operators,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.text;
      }
    } catch (error) {
      privacyLogger.warn({ error }, "Presidio anonymize with pseudonyms failed, using local");
    }

    // Fallback to local
    return this.localAnonymize(text, entities);
  }

  /**
   * Re-identify text using pseudonym map (local only)
   */
  reidentify(request: ReidentificationRequest): string {
    let result = request.maskedText;

    // Sort pseudonyms by length (longest first) to avoid partial replacements
    const pseudonyms = Object.keys(request.pseudonymMap).sort((a, b) => b.length - a.length);

    for (const pseudonym of pseudonyms) {
      const { original } = request.pseudonymMap[pseudonym];
      result = result.split(pseudonym).join(original);
    }

    return result;
  }

  /**
   * Determine sensitivity level based on document content and metadata
   */
  static determineSensitivityLevel(
    documentType: string,
    caseType?: string,
    userTaggedL3 = false
  ): SensitivityLevel {
    // User explicitly tagged as L3
    if (userTaggedL3) return "L3_HIGHLY_CONFIDENTIAL";

    // Case types that are inherently sensitive (KVKK m.6 özel nitelikli)
    const sensitiveCaseTypes = ["CRIMINAL", "FAMILY"];
    if (caseType && sensitiveCaseTypes.includes(caseType)) {
      return "L2_SENSITIVE";
    }

    // Document types that may contain sensitive data
    const sensitiveDocTypes = ["EVIDENCE", "CORRESPONDENCE", "COURT_DECISION"];
    if (sensitiveDocTypes.includes(documentType)) {
      return "L2_SENSITIVE";
    }

    return "L1_NORMAL";
  }

  /**
   * Health check for Presidio services
   */
  async healthCheck(): Promise<{ analyzer: boolean; anonymizer: boolean }> {
    const [analyzerOk, anonymizerOk] = await Promise.all([
      fetch(`${this.analyzerUrl}/health`).then((r) => r.ok).catch(() => false),
      fetch(`${this.anonymizerUrl}/health`).then((r) => r.ok).catch(() => false),
    ]);

    return { analyzer: analyzerOk, anonymizer: anonymizerOk };
  }
}

// Singleton instance
export const privacyShield = new PrivacyShield();