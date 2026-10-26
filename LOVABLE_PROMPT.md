# Kâtip — Hukuk Bürosu AI Sistemi (Lovable Prompt)

## Proje Özeti
**Kâtip**, hukuk bürolarının dava, müvekkil, belge, faturalandırma ve AI destekli araştırma/dilekçe süreçlerini tek platformda yönetmesini sağlayan tam teşekküllü bir yazılım. PostgreSQL 17 + pgvector + pg_trgm altyapısıyla vektör arama ve tam metin arama destekler.

---

## Teknik Stack
- **Backend**: Fastify + TypeScript (tsx watch)
- **Veritabanı**: PostgreSQL 17 + Prisma ORM
- **AI Entegrasyonu**: Anthropic Claude SDK, AWS Bedrock
- **Kuyruk**: BullMQ + Redis (ioredis)
- **Vektör Arama**: pgvector (bge-m3 embedding, 1024-dim)
- **Tam Metin Arama**: pg_trgm (tsvector)
- **Validasyon**: Valibot + Zod
- **Test**: Vitest
- **Paket Yöneticisi**: pnpm workspace

---

## Veritabanı Şeması (Prisma) — Önemli Modeller

### Core
- `User` — Avukat/stajer/sekreter/admin rolleri
- `LawFirm` — Büro ayarları, vergi no, baro
- `Client` — Bireysel/kurumsal müvekkiller, hassasiyet seviyesi (L1/L2/L3)
- `Case` — Dava dosyaları, dava numarası, mahkeme, tür, durum
- `CaseLawyer` — Dava-avukat atama (lead/assisting/supervising)
- `Party` — Taraflar (davacı/davalı/müdahil/şahit/uzman), çelişki kontrolü için TCKN/VKN

### Belgeler & Arşiv
- `Document` — OCR metni, SHA256 hash (deduplication), Nextcloud path, **embedding (vector(1024))**, **pgTrgmVector (tsvector)**, pseudonymMap (L2 için)
- `Template` — docxtpl şablonları (dilekçe/sözleşme vb.)

### İcra & Takip
- `Hearing` — Düşüşma tarihleri, türleri, sanal/link
- `Deadline` — HMK hesaplamalı tarihler, kritik bayrağı, hatırlatma

### Zaman & Faturalandırma
- `TimeEntry` — Dakika bazlı, aktivite türü, faturalandırılabilir, onay akışı
- `BillingRate` — Kullanıcı/dava türü/rol bazlı saatlik ücret, para birimi, tarih aralığı
- `Invoice` — e-Fatura (GIB/e-SMM) entegrasyonu, kalemler, ödeme durumu
- `TrustAccount` — Müşteri vekalet hesapları (IBAN, bakiye)
- `TrustTransfer` — Yatırım/çekim/avukatlık bedeli/ masraf

### AI & Araştırma
- `ResearchMemo` — Soru/cevap, atıflar (mahkeme/karar no/tarih/URL/alıntı), model, güven skoru
- `ResearchDocument` — Memo-belge ilişki, alakalı skor
- `Petition` — Şablondan üretilen dilekçeler, onay durumu, UYAP tescil no
- `PetitionDocument` — Dilekçe-ek belge ilişki (kanıt/referans/ek)

### Uyum & Denetim
- `ConflictCheck` — TCKN/VKN/İsim bazlı çelişki taraması, durum (CLEAR/POTENTIAL/CONFIRMED)
- `Approval` — Genel onay akışı (dilekçe/fatura/zaman girişi/e-posta/sözleşme)
- `AuditLog` — Değişmez hash chain (create/read/update/delete/export/ai_call)
- `AIInteraction` — Maliyet takibi (model, effort, token, estimatedCost, prompt/response hash)

### Operasyonel
- `DailyBriefing` — Günlük özet (yapılandırılmış JSON), alıcılar
- `Notification` — Düşüşma/sonuç/hatırlatma/onay bildirimleri, öncelik

---

## API Endpoints (Mevcut)

| Method | Path | Açıklama |
|--------|------|----------|
| GET | `/health` | Sağlık kontrolü |
| GET | `/health/privacy` | Gizlilik kalkanı sağlık |
| POST | `/api/ai/process` | Ana AI endpoint — departmanlara yönlendirir |
| POST | `/api/ai/route` | Sadece routing (debug) |
| GET | `/api/briefing/daily` | Günlük özet |
| GET | `/api/departments` | Departman listesi + model config |
| POST | `/api/cases` | Dava + müvekkil oluştur |
| GET | `/api/cases/:id` | Dava detayı (tüm ilişkiler) |
| GET | `/api/approvals` | Onay bekleyenler |
| POST | `/api/approvals/:id/respond` | Onay/red/değişiklik |
| GET | `/api/time-entries/daily` | Günlük zaman girişleri (onay ekranı) |
| POST | `/api/time-entries/bulk` | Toplu onay/red/düzenle |
| GET | `/api/documents` | Belge listesi (filtre: caseId, type) |
| GET | `/api/invoices` | Fatura listesi |
| POST | `/api/conflict-check` | Çelişki kontrolü (departman aracı) |
| GET | `/api/research` | Araştırma notları |
| GET | `/api/petitions` | Dilekçeler |
| GET | `/api/notifications` | Bildirimler |
| POST | `/api/notifications/:id/read` | Okundu işaretle |

---

## AI Departmanları (Katip Core)
Her departman kendi model/effort/prompt config'ine sahiptir:
- `INTAKE` — Müvekkil/dava kabul
- `CONFLICT_POWER_OF_ATTORNEY` — Çelişki/vekaletname kontrolü
- `DEADLINES_CALENDAR` — HMK süre hesapları, takvim
- `LEGAL_RESEARCH` — Mevzuat/emzal/yargıtay danıştay arama
- `PETITION_DRAFTING` — Dilekçe taslağı (şablon + belge referansları)
- `EMAIL_CORRESPONDENCE` — Resmi yazışma
- `TIME_BILLING` — Zaman girişi çıkarma/önerebilme
- `HEARING_PREPARATION` — Düşüşma hazırlığı (dava özeti, belgeler, sorular)

---

## Geliştirme Komutları
```bash
# Bağımlılıklar
pnpm install

# Veritabı push (geliştirme)
pnpm db:push

# Prisma Studio
pnpm db:studio

# Seed verisi
pnpm db:seed

# Geliştirme sunucusu
pnpm dev          # tsx watch src/index.ts

# Build
pnpm build        # tsc

# Test
pnpm test         # vitest run
```

---

## Ortam Değişkenleri (.env)
```env
DATABASE_URL=postgresql://user:pass@localhost:5432/katip_dev
# AI
ANTHROPIC_API_KEY=sk-ant-...
AWS_BEDROCK_REGION=us-east-1
# Redis (BullMQ)
REDIS_URL=redis://localhost:6379
# Nextcloud (belge depolama)
NEXTCLOUD_URL=https://cloud.example.com
NEXTCLOUD_USER=...
NEXTCLOUD_PASS=...
# UYAP entegrasyonu (ileride)
UYAP_CLIENT_ID=...
UYAP_CLIENT_SECRET=...
```

---

## Lovable İçin Kurulum Talimatları

### 1. Projeyi Oluştur
```
lovable create katip --template node-typescript
cd katip
```

### 2. Paketleri Yükle
```bash
pnpm add -w fastify @fastify/cors @fastify/swagger @fastify/swagger-ui \
  @prisma/client prisma bullmq ioredis pgvector pg \
  @anthropic-ai/sdk @anthropic-ai/claude-agent-sdk @aws-sdk/client-bedrock-runtime \
  valibot zod neverthrow date-fns date-fns-tz pino pino-pretty clsx uuid jose otplib xlsx \
  argon2 better-sqlite3 drizzle-orm drizzle-zol postgres @types/pg @types/node @types/uuid

pnpm add -D -w typescript tsx vitest @types/better-sqlite3 rimraf
```

### 3. Prisma Şemasını Kopyala
`prisma/schema.prisma` dosyasını projeye kopyalayıp `pnpm db:push` çalıştır.

### 4. Çekirdek Dosyaları Oluştur
- `src/config/env.ts` — env validasyonu (valibot/zod)
- `src/config/db.ts` — Prisma client singleton
- `src/core/katip-core.ts` — Departman orchestrator, routing, execute()
- `src/departments/*.ts` — Her departman için sınıf + tool tanımları
- `src/index.ts` — Fastify server + route kayıtları (yukarıdaki endpointler)

### 5. Geliştirme
```bash
pnpm dev
# API: http://localhost:3001
# Swagger: http://localhost:3001/docs
```

---

## Kritik İpuçları (Lovable'a)

1. **Hassasiyet Seviyeleri (L1/L2/L3)** — L2 belgelerde `pseudonymMap` JSON alanı şart; L3'te embedding/indexlenmez, yalnız yetkili erişir.
2. **Çelişki Kontrolü** — Her dava/müvekkil oluşturulmasında otomatik tetiklenmeli (TCKN/VKN + isim bazlı).
3. **HMK Süre Hesabı** — `Deadline.calculatedDate` alanı resmi tatil, hafta sonu, mahkeme tatili hesaplayarak doldurulmalı.
4. **e-Fatura** — GIB/e-SMM entegrasyonu `Invoice.eInvoiceId` alanında saklanır; `WEBHOOK_REQUIRE_SIG` ile güvenlik.
5. **AI Maliyet Takibi** — Her AI çağrısı `AIInteraction` tablosına yazılır (model, token, maliyet, hash).
6. **Denetim İzlemesi** — `AuditLog.hash` zinciri (prevHash) ile değiştirilemez log.
7. **Vektör Arama** — `Document.embedding` (pgvector) + `pgTrgmVector` (tsvector) hibrit arama için her ikisi de indexlenir.
8. **Onay Akışı** — `Approval` generic resourceId/resourceType ile her kaynak türü için çalışır.

---

## İlerleme Durumu
- ✅ Prisma şeması tamamlandı
- ✅ Fastify server + temel route'lar
- ✅ KatipCore routing + execute taslağı
- ⏳ Departman tool implementasyonları (biraz)
- ⏳ Prisma seed verisi
- ⏳ Nextcloud/Odeme/UYAP entegrasyonları
- ⏳ Frontend (Next.js panel - ayrı repo/web app)

---

## Lovable'a Sorulabilecek Örnekler
- "Prisma şemasından Fastify route'ları otomatik üret"
- "pgvector + pg_trgm hibrit arama endpoint'i yaz"
- "HMK m.104/105/106 süre hesaplayan Deadline service'i oluştur"
- "docxtpl şablonundan dilekçe üreten Petition service"
- "BullMQ kuyruğu ile async AI çağrısı + progress bildirimi"
- "AuditLog hash chain (Merkle tree benzeri) implementasyonu"
- "L2 hassasiyetli belgelerde pseudonymization middleware'i"

---

**Not**: Bu proje `apps/katip/` klasöründe idi, `~/Downloads/katip/` konumuna taşındı. Kipay (ödeme gateway) projesi ayrıdır (`apps/api`, `apps/web`, `apps/gateway`).