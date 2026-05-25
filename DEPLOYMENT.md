# AI-Powered Support Chatbot — Complete Deployment Guide

## What's Included

| File | Purpose |
|---|---|
| `ai-worker.js` | **Main Cloudflare Worker** (was missing — now provided) |
| `schema.sql` | D1 database schema |
| `wrangler.toml` | Cloudflare configuration |
| `.env.example` | All environment variables documented |
| `setup.js` | One-time setup: patches wrangler.toml + generates .dev.vars |
| `upload-knowledge.js` | KB upload script (interactive / file / samples) |
| `kb-admin.js` | **Full KB CRUD CLI** (list, get, upload, update, delete, restore, stats) |
| `.gitignore` | Keeps secrets out of git |

---

## Capabilities

| Feature | How |
|---|---|
| **AI Chat** | `POST /api/chat` — RAG-powered with session memory |
| **Voice input** | `POST /api/chat/voice` — Whisper STT → chat pipeline |
| **OCR / Handwriting** | `POST /api/chat/ocr` — LLaVA vision model, handles typed + handwritten text |
| **KB Upload** | `POST /api/admin/kb/upload` |
| **KB List** | `GET /api/admin/kb` |
| **KB Get** | `GET /api/admin/kb/:docId` — includes raw content from R2 |
| **KB Update** | `PUT /api/admin/kb/:docId` — re-vectorizes if content changes |
| **KB Delete** | `DELETE /api/admin/kb/:docId` — soft delete + removes vectors |
| **KB Restore** | `POST /api/admin/kb/:docId/restore` — re-vectorizes from R2 |
| **KB Bulk Upload** | `POST /api/admin/kb/bulk-upload` |
| **Analytics** | `GET /api/admin/analytics` |
| **Telegram alerts** | On every form submission |

---

## Prerequisites

- Cloudflare account (Workers AI requires paid plan or Beta access)
- Node.js 18+
- Wrangler CLI

---

## Step 1: Install Wrangler and Login

```bash
npm install -g wrangler
wrangler login
```

---

## Step 2: Create Cloudflare Resources

Run each command and copy the IDs into your `.env` file.

### 2.1 D1 Database

```bash
wrangler d1 create support-db
# Copy "database_id" → CF_D1_DATABASE_ID in .env
```

### 2.2 KV Namespace (sessions + rate limiting)

```bash
wrangler kv:namespace create SESSIONS
# Copy "id" → CF_KV_NAMESPACE_ID in .env

wrangler kv:namespace create SESSIONS_PREVIEW
# Copy "id" → CF_KV_PREVIEW_NAMESPACE_ID in .env  (used by wrangler dev)
```

### 2.3 Vectorize Index (RAG)

```bash
wrangler vectorize create support-knowledge-base \
  --dimensions=768 \
  --metric=cosine
# Uses @cf/baai/bge-base-en-v1.5 embeddings (768 dimensions)
```

### 2.4 R2 Bucket (stores original documents + audio for restore)

```bash
wrangler r2 bucket create support-documents
```

### 2.5 Get Your Account ID

```bash
wrangler whoami
# Copy account_id → CF_ACCOUNT_ID in .env
```

---

## Step 3: Configure Environment

```bash
# Copy example to real .env
cp .env.example .env

# Edit .env — fill in all CF_* values from Step 2
# Also set:
#   TG_BOT_TOKEN   — from @BotFather on Telegram
#   TG_CHAT_ID     — from @userinfobot
#   ADMIN_SECRET   — any strong random string (protects /api/admin/* routes)
#   WORKER_URL     — leave blank until after first deploy
```

---

## Step 4: Run Setup Script

```bash
# Patches wrangler.toml with your real IDs from .env
# Generates .dev.vars for local wrangler dev
node setup.js

# After verifying wrangler.toml looks right, push secrets to Cloudflare:
node setup.js --secrets
```

---

## Step 5: Apply Database Schema

```bash
wrangler d1 execute support-db --file=schema.sql
```

---

## Step 6: Deploy

```bash
# Production
wrangler deploy

# Development (uses .dev.vars for secrets)
wrangler dev
```

After deploying, copy the worker URL (e.g. `https://ai-support-chatbot.yourname.workers.dev`) into `.env` as `WORKER_URL`, then run `node setup.js` again to update `.dev.vars`.

---

## Step 7: Set ADMIN_SECRET

```bash
wrangler secret put ADMIN_SECRET
# Enter the same value you put in .env ADMIN_SECRET
```

This protects all `/api/admin/*` endpoints. Pass it as:
- Header: `X-Admin-Secret: <value>`
- Query param: `?secret=<value>`

---

## Step 8: Populate Knowledge Base

### Option A — Built-in samples (quickest)

```bash
node upload-knowledge.js --samples
# Uploads: FAQ, Services, Pricing, Technical Requirements
```

### Option B — Your own files

```bash
node upload-knowledge.js ./docs/my-guide.txt support
node upload-knowledge.js ./docs/pricing.md pricing
```

### Option C — Entire folder

```bash
node upload-knowledge.js --interactive
# Choose option 3, enter directory path
```

### Option D — KB Admin CLI

```bash
node kb-admin.js upload ./docs/faq.txt support --tags=faq,billing
node kb-admin.js bulk ./docs/ general
```

---

## Knowledge Base Management (Full CRUD)

### List all documents

```bash
node kb-admin.js list
node kb-admin.js list --category=support
node kb-admin.js list --status=archived
```

### Get a document (with content)

```bash
node kb-admin.js get <docId>
```

### Update a document

```bash
# Update title/category only
node kb-admin.js update <docId> --title="New Title" --category=billing

# Replace content (re-vectorizes automatically)
node kb-admin.js update <docId> --file=./updated-faq.txt
```

### Delete (soft archive)

```bash
node kb-admin.js delete <docId>
# Removes from knowledge base + Vectorize, keeps in D1 as 'archived'
```

### Restore archived document

```bash
node kb-admin.js restore <docId>
# Re-reads from R2, re-vectorizes, marks active
```

### Or use the REST API directly

```bash
# List
curl -H "X-Admin-Secret: $ADMIN_SECRET" https://your-worker.workers.dev/api/admin/kb

# Upload
curl -X POST -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"title":"My Guide","category":"support","document":"Content here..."}' \
  https://your-worker.workers.dev/api/admin/kb/upload

# Update
curl -X PUT -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"title":"Updated Title","document":"New content..."}' \
  https://your-worker.workers.dev/api/admin/kb/<docId>

# Delete
curl -X DELETE -H "X-Admin-Secret: $ADMIN_SECRET" \
  https://your-worker.workers.dev/api/admin/kb/<docId>

# Restore
curl -X POST -H "X-Admin-Secret: $ADMIN_SECRET" \
  https://your-worker.workers.dev/api/admin/kb/<docId>/restore
```

---

## Voice Input

The chatbot accepts voice from the browser microphone (built into the chat UI) or via API:

```bash
# Via API (multipart)
curl -X POST -F "audio=@recording.webm" -F "sessionId=abc123" \
  https://your-worker.workers.dev/api/chat/voice

# Response
{ "transcript": "what are your prices?", "reply": "...", "sessionId": "..." }
```

Uses `@cf/openai/whisper` — supports English + multilingual.

---

## OCR & Handwriting Recognition

Send any image containing typed or handwritten text. Uses `@cf/llava-hf/llava-1.5-7b-hf` (vision model).

Supported input types:
- Photos of handwritten notes
- Scanned documents
- Screenshots with text
- Mixed printed + handwritten documents
- Whiteboard photos
- Business cards / forms

```bash
# Via API (multipart)
curl -X POST -F "image=@handwritten-note.jpg" \
  -F "sessionId=abc123" \
  -F "prompt=Extract all text including handwriting" \
  https://your-worker.workers.dev/api/chat/ocr

# Response
{
  "extractedText": "Meeting notes: ...\n[Handwritten: Call John re: pricing]",
  "reply": "I can see your meeting notes mention...",
  "sessionId": "..."
}
```

The chat UI supports this natively — click 📎 to attach any image or document.

---

## Testing Checklist

- [ ] `GET /api/health` returns `{ ok: true }`
- [ ] Chat UI loads at `/`
- [ ] Text chat works, AI responds
- [ ] Knowledge base returns relevant context
- [ ] Voice input transcribes and responds
- [ ] Image/OCR upload extracts text and responds
- [ ] Admin: list KB documents
- [ ] Admin: upload a document, verify chunks
- [ ] Admin: update document, verify re-vectorized
- [ ] Admin: delete document, verify removed
- [ ] Admin: restore document, verify re-vectorized
- [ ] Form submission works
- [ ] Telegram notification arrives
- [ ] Session persists across messages
- [ ] Rate limiting kicks in after 100 req/hour
- [ ] Analytics endpoint returns data
- [ ] Mobile responsive chat UI

---

## Monitoring

```bash
# Live logs
wrangler tail

# Analytics
node kb-admin.js stats

# Raw D1 queries
wrangler d1 execute support-db --command="SELECT * FROM intent_analytics LIMIT 10"
wrangler d1 execute support-db --command="SELECT * FROM input_type_breakdown"
wrangler d1 execute support-db --command="SELECT * FROM kb_usage_stats"
wrangler d1 execute support-db --command="SELECT * FROM submissions ORDER BY submitted_at DESC LIMIT 10"
```

---

## Backup & Recovery

```bash
# Backup D1
wrangler d1 export support-db --output=backup-$(date +%Y%m%d).sql

# Restore
wrangler d1 execute support-db --file=backup-20250101.sql
```

R2 stores original document content — KB documents can always be re-vectorized from R2 via the restore command.

---

## AI Models Used

| Task | Model | Notes |
|---|---|---|
| Text generation | `@cf/meta/llama-3.1-8b-instruct` | Change via `AI_MODEL` var |
| Embeddings (RAG) | `@cf/baai/bge-base-en-v1.5` | 768-dim, must match Vectorize index |
| Voice (STT) | `@cf/openai/whisper` | Multilingual |
| OCR / Vision | `@cf/llava-hf/llava-1.5-7b-hf` | Typed + handwriting |

To use a more powerful text model:
```toml
# wrangler.toml [vars]
AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
```

---

## Costs (Cloudflare Free Tier)

| Service | Free Limit |
|---|---|
| Workers | 100,000 req/day |
| Workers AI | 10,000 neurons/day (~1,000 chats) |
| D1 | 5GB, 5M reads/day |
| KV | 100K reads/day, 1K writes/day |
| Vectorize | 30M queried vectors/month |
| R2 | 10GB, 1M Class A ops/month |

Voice and OCR calls use significantly more AI neurons than text-only chat.

---

## Advanced: Custom Domain

```bash
# 1. Add domain to Cloudflare dashboard
# 2. Uncomment in wrangler.toml:
#   routes = [{ pattern = "chat.yourdomain.com", custom_domain = true }]
# 3. Deploy
wrangler deploy
```

---

## Troubleshooting

| Error | Solution |
|---|---|
| `AI binding not found` | Ensure Workers AI is enabled on your plan |
| `Vectorize index not found` | Run `wrangler vectorize create support-knowledge-base --dimensions=768 --metric=cosine` |
| `Session not persisting` | Check KV namespace ID in wrangler.toml |
| `No context from knowledge base` | Upload documents first; check Vectorize query scores |
| `401 Unauthorized` | Set `ADMIN_SECRET` in `.env` and via `wrangler secret put ADMIN_SECRET` |
| `Voice transcription failed` | Whisper requires audio as raw bytes array; check multipart upload |
| `OCR returned empty` | LLaVA requires image as byte array; check base64 encoding |
| `Bulk upload slow` | Normal — each doc embeds chunks sequentially; use `--samples` for testing |

---

## Security Checklist

- [ ] `.env` and `.dev.vars` in `.gitignore`
- [ ] `ADMIN_SECRET` is a strong random string (32+ chars)
- [ ] Rate limiting enabled (default: 100 req/hr/IP)
- [ ] CORS configured for your domain in production
- [ ] Admin endpoints require `X-Admin-Secret` header
- [ ] Input sanitized (worker strips dangerous content)
- [ ] Secrets set via `wrangler secret put` not in `wrangler.toml`
