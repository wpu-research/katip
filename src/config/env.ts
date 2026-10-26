/**
 * Kâtip - Environment Configuration
 * Validates and exports all environment variables
 */

import { z } from "zod";

const EnvSchema = z.object({
  // Application
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis (for BullMQ queues)
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  // AWS Bedrock (Claude models in eu-central-1)
  AWS_REGION: z.string().default("eu-central-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  BEDROCK_CLAUDE_OPUS_MODEL_ID: z.string().default("anthropic.claude-opus-5-5-20261001-v1:0"),
  BEDROCK_CLAUDE_SONNET_MODEL_ID: z.string().default("anthropic.claude-sonnet-5-5-20261001-v1:0"),
  BEDROCK_CLAUDE_HAIKU_MODEL_ID: z.string().default("anthropic.claude-haiku-5-5-20261001-v1:0"),

  // Anthropic API (fallback with ZDR)
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_API_URL: z.string().url().default("https://api.anthropic.com"),

  // Email (Microsoft 365 / Gmail)
  EMAIL_PROVIDER: z.enum(["m365", "gmail"]).default("m365"),
  M365_CLIENT_ID: z.string().optional(),
  M365_CLIENT_SECRET: z.string().optional(),
  M365_TENANT_ID: z.string().optional(),
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),

  // Calendar
  CAL_COM_API_KEY: z.string().optional(),
  CAL_COM_BASE_URL: z.string().url().default("https://api.cal.com"),

  // UYAP (Turkish judiciary system)
  UYAP_BASE_URL: z.string().url().default("https://uyap.gov.tr"),
  UYAP_USERNAME: z.string().optional(),
  UYAP_PASSWORD: z.string().optional(),

  // e-SMM / GIB (Turkish e-invoicing)
  E_SMM_PROVIDER: z.enum(["parasut", "logo", "uyumsoft"]).default("parasut"),
  E_SMM_API_KEY: z.string().optional(),
  E_SMM_API_SECRET: z.string().optional(),

  // SIP / Telefon
  SIP_PROVIDER: z.enum(["verimor", "netgsm"]).default("verimor"),
  SIP_USERNAME: z.string().optional(),
  SIP_PASSWORD: z.string().optional(),
  SIP_DOMAIN: z.string().optional(),

  // LiveKit (WebRTC for phone receptionist)
  LIVEKIT_URL: z.string().url().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),

  // Whisper (Speech-to-text)
  WHISPER_MODEL: z.string().default("large-v3"),
  WHISPER_DEVICE: z.enum(["cpu", "cuda"]).default("cpu"),
  WHISPER_COMPUTE_TYPE: z.enum(["float16", "int8", "float32"]).default("float16"),

  // OCR / Paperless-ngx
  PAPERLESS_URL: z.string().url().default("http://localhost:8000"),
  PAPERLESS_API_TOKEN: z.string().optional(),

  // Nextcloud / OnlyOffice
  NEXTCLOUD_URL: z.string().url().optional(),
  NEXTCLOUD_USERNAME: z.string().optional(),
  NEXTCLOUD_PASSWORD: z.string().optional(),
  ONLYOFFICE_URL: z.string().url().optional(),
  ONLYOFFICE_JWT_SECRET: z.string().optional(),

  // Authentik SSO
  AUTHENTIK_URL: z.string().url().optional(),
  AUTHENTIK_CLIENT_ID: z.string().optional(),
  AUTHENTIK_CLIENT_SECRET: z.string().optional(),

  // Kimai (Time tracking)
  KIMAI_URL: z.string().url().default("http://localhost:8001"),
  KIMAI_API_TOKEN: z.string().optional(),

  // Embedding model (bge-m3)
  EMBEDDING_MODEL: z.string().default("bge-m3"),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(1024),
  EMBEDDING_DEVICE: z.enum(["cpu", "cuda"]).default("cpu"),

  // Presidio (PII detection)
  PRESIDIO_ANALYZER_URL: z.string().url().default("http://localhost:5001"),
  PRESIDIO_ANONYMIZER_URL: z.string().url().default("http://localhost:5002"),

  // Turkish NER (custom)
  TR_NER_MODEL_PATH: z.string().optional(),

  // KVKK / Legal
  KVKK_DATA_CONTROLLER: z.string().optional(),
  LAW_FIRM_NAME: z.string().default("Demo Hukuk Bürosu"),
  LAW_FIRM_TAX_NUMBER: z.string().optional(),
  LAW_FIRM_BAR_ASSOCIATION: z.string().default("İstanbul Barosu"),

  // Monitoring
  SENTRY_DSN: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let envCache: Env | null = null;

export function getEnv(): Env {
  if (envCache) return envCache;

  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Environment validation failed:");
    console.error(result.error.flatten().fieldErrors);
    process.exit(1);
  }

  envCache = result.data;
  return envCache;
}

export const env = getEnv();