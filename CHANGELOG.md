# Changelog

## [2.0.0] - 2024-01-15

### Added
- Multi-account AI failover with 3 Cloudflare accounts
- Voice input with Whisper STT
- OCR/handwriting recognition with LLaVA
- Complete KB CRUD operations (Create, Read, Update, Delete, Restore)
- Bulk upload and delete for KB documents
- Streaming chat responses
- Telegram bot webhook integration
- Conversation history API
- Feedback collection endpoint
- Analytics dashboard with 10+ views
- Admin submissions management
- CSV export for conversations
- Rate limiting per IP + session
- Full REST API with CORS support

### Changed
- Enhanced RAG context retrieval with scoring
- Improved error handling across all endpoints
- Better session management with KV
- Optimized Vectorize chunking

### Fixed
- Upload endpoint path mismatch
- CORS preflight responses
- Database indexing for performance
- Session persistence across requests

## [1.0.0] - 2024-01-01

### Added
- Initial release
- Basic chat functionality
- RAG with Vectorize
- D1 database for storage
- Simple HTML chat UI