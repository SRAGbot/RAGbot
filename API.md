# API Documentation

## Base URL
`https://your-worker.workers.dev`

## Authentication
Admin endpoints require `X-Admin-Secret` header or `?secret=` query param.

## Public Endpoints

### Chat
- `POST /api/chat` - Send a message
- `POST /api/chat/stream` - Streaming response
- `POST /api/chat/voice` - Voice input (multipart or base64)
- `POST /api/chat/ocr` - Image OCR + chat

### Other
- `GET /api/conversations/:sessionId` - Get conversation history
- `POST /api/feedback` - Submit rating
- `POST /api/kb/search` - Search knowledge base
- `POST /api/submit` - Contact form submission
- `GET /api/health` - Health check

## Admin Endpoints

### Knowledge Base
- `GET /api/admin/kb` - List documents
- `GET /api/admin/kb/:docId` - Get document
- `POST /api/admin/kb/upload` - Upload document
- `POST /api/admin/kb/bulk-upload` - Bulk upload
- `PUT /api/admin/kb/:docId` - Update document
- `DELETE /api/admin/kb/:docId` - Delete document
- `DELETE /api/admin/kb/bulk` - Bulk delete
- `POST /api/admin/kb/:docId/restore` - Restore document

### Submissions
- `GET /api/admin/submissions` - List form submissions
- `PUT /api/admin/submissions/:id` - Update submission status

### Analytics & Export
- `GET /api/admin/analytics` - Dashboard stats
- `GET /api/admin/export/conversations?format=csv` - Export data

### Webhook
- `POST /api/telegram/webhook` - Telegram bot webhook

## Example Requests

```bash
# Chat
curl -X POST https://worker/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"What are your prices?","sessionId":"optional"}'

# Search KB
curl -X POST https://worker/api/kb/search \
  -H "Content-Type: application/json" \
  -d '{"query":"pricing","topK":5}'

# Upload document (admin)
curl -X POST https://worker/api/admin/kb/upload \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"title":"FAQ","category":"support","document":"Content here..."}'