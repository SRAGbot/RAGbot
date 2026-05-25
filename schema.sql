-- ============================================================
-- Complete D1 Database Schema for AI-Powered Support Chatbot
-- Run with: wrangler d1 execute support-db --file=schema.sql
-- ============================================================

-- ============================================================
-- 1. CONVERSATIONS TABLE (main chat history)
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT    NOT NULL,
    message     TEXT    NOT NULL,
    response    TEXT    NOT NULL,
    intent      TEXT,
    confidence  REAL,
    input_type  TEXT    DEFAULT 'text',
    ai_account  TEXT,
    media_ref   TEXT,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at);
CREATE INDEX IF NOT EXISTS idx_conv_intent ON conversations(intent);
CREATE INDEX IF NOT EXISTS idx_conv_input_type ON conversations(input_type);
CREATE INDEX IF NOT EXISTS idx_conv_ai_account ON conversations(ai_account);

-- ============================================================
-- 2. SUBMISSIONS TABLE (contact/lead forms)
-- ============================================================
CREATE TABLE IF NOT EXISTS submissions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    flow           TEXT    NOT NULL,
    name           TEXT    NOT NULL,
    email          TEXT    NOT NULL,
    phone          TEXT,
    contact_method TEXT,
    contact_detail TEXT,
    summary        TEXT    NOT NULL,
    session_id     TEXT,
    timezone       TEXT,
    country        TEXT,
    ip             TEXT,
    submitted_at   INTEGER NOT NULL,
    status         TEXT    DEFAULT 'pending',
    resolved_at    INTEGER,
    notes          TEXT,
    assigned_to    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sub_session ON submissions(session_id);
CREATE INDEX IF NOT EXISTS idx_sub_submitted ON submissions(submitted_at);
CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_sub_email ON submissions(email);
CREATE INDEX IF NOT EXISTS idx_sub_flow ON submissions(flow);

-- ============================================================
-- 3. KNOWLEDGE BASE DOCUMENTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_documents (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id          TEXT    NOT NULL UNIQUE,
    title           TEXT    NOT NULL,
    category        TEXT    DEFAULT 'general',
    tags            TEXT,
    chunk_count     INTEGER DEFAULT 0,
    content_preview TEXT,
    uploaded_at     INTEGER NOT NULL,
    last_modified   INTEGER,
    uploaded_by     TEXT,
    status          TEXT    DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_kb_doc_id ON knowledge_documents(doc_id);
CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_documents(category);
CREATE INDEX IF NOT EXISTS idx_kb_status ON knowledge_documents(status);
CREATE INDEX IF NOT EXISTS idx_kb_uploaded ON knowledge_documents(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_kb_title ON knowledge_documents(title);

-- ============================================================
-- 4. KB SEARCH LOG TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS kb_search_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    query      TEXT    NOT NULL,
    top_doc_id TEXT,
    score      REAL,
    session_id TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_log_created ON kb_search_log(created_at);
CREATE INDEX IF NOT EXISTS idx_kb_log_doc ON kb_search_log(top_doc_id);
CREATE INDEX IF NOT EXISTS idx_kb_log_score ON kb_search_log(score);

-- ============================================================
-- 5. FEEDBACK TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    rating     INTEGER,
    comment    TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);

-- ============================================================
-- 6. OCR JOBS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS ocr_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT    NOT NULL UNIQUE,
    session_id   TEXT,
    status       TEXT    DEFAULT 'pending',
    r2_key       TEXT,
    result       TEXT,
    error        TEXT,
    created_at   INTEGER NOT NULL,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ocr_job_id ON ocr_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_ocr_status ON ocr_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ocr_session ON ocr_jobs(session_id);

-- ============================================================
-- 7. ADMIN USERS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE,
    email       TEXT    NOT NULL UNIQUE,
    role        TEXT    DEFAULT 'editor',
    created_at  INTEGER NOT NULL,
    last_login  INTEGER,
    last_ip     TEXT,
    is_active   INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_admin_username ON admin_users(username);
CREATE INDEX IF NOT EXISTS idx_admin_email ON admin_users(email);
CREATE INDEX IF NOT EXISTS idx_admin_role ON admin_users(role);

-- ============================================================
-- 8. ANALYTICS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS analytics (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT    NOT NULL,
    session_id TEXT,
    user_id    TEXT,
    metadata   TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics(session_id);

-- ============================================================
-- 9. API KEYS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS api_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id      TEXT    NOT NULL UNIQUE,
    key_secret  TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    permissions TEXT    DEFAULT 'read',
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER,
    last_used_at INTEGER,
    is_active   INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_api_key_id ON api_keys(key_id);
CREATE INDEX IF NOT EXISTS idx_api_active ON api_keys(is_active);

-- ============================================================
-- 10. SYSTEM SETTINGS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS system_settings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key TEXT    NOT NULL UNIQUE,
    setting_value TEXT,
    setting_type TEXT    DEFAULT 'string',
    description TEXT,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
);

INSERT OR IGNORE INTO system_settings (setting_key, setting_value, setting_type, description, updated_at, updated_by)
VALUES 
    ('maintenance_mode', 'false', 'boolean', 'Puts the system in maintenance mode', CAST(strftime('%s','now') AS INTEGER) * 1000, 'system'),
    ('max_message_length', '2000', 'number', 'Maximum allowed message length in characters', CAST(strftime('%s','now') AS INTEGER) * 1000, 'system'),
    ('rate_limit_default', '100', 'number', 'Default rate limit per IP per hour', CAST(strftime('%s','now') AS INTEGER) * 1000, 'system'),
    ('enable_voice', 'true', 'boolean', 'Enable voice input feature', CAST(strftime('%s','now') AS INTEGER) * 1000, 'system'),
    ('enable_ocr', 'true', 'boolean', 'Enable OCR/handwriting feature', CAST(strftime('%s','now') AS INTEGER) * 1000, 'system'),
    ('welcome_message', 'Hello! How can I help you today?', 'string', 'Default welcome message', CAST(strftime('%s','now') AS INTEGER) * 1000, 'system');

-- ============================================================
-- VIEWS FOR ANALYTICS (SQLite 3.25+ compatible)
-- ============================================================

CREATE VIEW IF NOT EXISTS recent_conversations AS
SELECT
    c.session_id,
    COUNT(*)              AS message_count,
    MAX(c.created_at)     AS last_message_at,
    MIN(c.created_at)     AS first_message_at,
    s.name,
    s.email,
    s.status              AS submission_status,
    SUM(CASE WHEN c.input_type = 'voice' THEN 1 ELSE 0 END) AS has_voice,
    SUM(CASE WHEN c.input_type = 'ocr' THEN 1 ELSE 0 END) AS has_ocr
FROM conversations c
LEFT JOIN submissions s ON c.session_id = s.session_id
GROUP BY c.session_id
ORDER BY last_message_at DESC;

CREATE VIEW IF NOT EXISTS intent_analytics AS
SELECT
    intent,
    COUNT(*)              AS count,
    AVG(confidence)       AS avg_confidence,
    DATE(created_at / 1000, 'unixepoch') AS date,
    COUNT(DISTINCT session_id) AS unique_sessions
FROM conversations
WHERE intent IS NOT NULL AND intent != 'general'
GROUP BY intent, date
ORDER BY date DESC, count DESC;

CREATE VIEW IF NOT EXISTS input_type_breakdown AS
SELECT
    input_type,
    COUNT(*) AS count,
    ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM conversations), 2) AS percentage,
    DATE(created_at / 1000, 'unixepoch') AS date
FROM conversations
GROUP BY input_type, date
ORDER BY date DESC, input_type;

CREATE VIEW IF NOT EXISTS ai_account_usage AS
SELECT 
    ai_account,
    COUNT(*) AS total_calls,
    ROUND(AVG(confidence), 2) AS avg_confidence,
    COUNT(DISTINCT session_id) AS unique_sessions,
    DATE(created_at / 1000, 'unixepoch') AS date
FROM conversations 
WHERE ai_account IS NOT NULL
GROUP BY ai_account, date
ORDER BY date DESC, total_calls DESC;

CREATE VIEW IF NOT EXISTS kb_usage_stats AS
SELECT
    kd.title,
    kd.category,
    kd.doc_id,
    COUNT(ksl.id) AS search_hits,
    ROUND(AVG(ksl.score), 3) AS avg_relevance_score,
    MAX(ksl.score) AS max_relevance_score,
    MAX(ksl.created_at) AS last_used
FROM knowledge_documents kd
LEFT JOIN kb_search_log ksl ON kd.doc_id = ksl.top_doc_id
WHERE kd.status = 'active'
GROUP BY kd.doc_id
ORDER BY search_hits DESC, avg_relevance_score DESC;

CREATE VIEW IF NOT EXISTS daily_active_users AS
SELECT
    DATE(created_at / 1000, 'unixepoch') AS date,
    COUNT(DISTINCT session_id) AS active_sessions,
    COUNT(*) AS total_messages,
    ROUND(AVG(LENGTH(message)), 0) AS avg_message_length
FROM conversations
GROUP BY date
ORDER BY date DESC;

CREATE VIEW IF NOT EXISTS feedback_summary AS
SELECT
    DATE(created_at / 1000, 'unixepoch') AS date,
    COUNT(*) AS total_feedback,
    ROUND(AVG(rating), 2) AS avg_rating,
    SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) AS positive_count,
    SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) AS negative_count,
    ROUND(SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS satisfaction_rate
FROM feedback
GROUP BY date
ORDER BY date DESC;

CREATE VIEW IF NOT EXISTS response_time_analysis AS
SELECT
    DATE(c1.created_at / 1000, 'unixepoch') AS date,
    AVG(c2.created_at - c1.created_at) AS avg_response_time_ms,
    MIN(c2.created_at - c1.created_at) AS min_response_time_ms,
    MAX(c2.created_at - c1.created_at) AS max_response_time_ms
FROM conversations c1
JOIN conversations c2 ON c1.session_id = c2.session_id 
    AND c2.created_at > c1.created_at
    AND c1.input_type != 'assistant'
    AND c2.input_type = 'assistant'
GROUP BY date
ORDER BY date DESC;

CREATE VIEW IF NOT EXISTS hourly_activity AS
SELECT
    CAST(strftime('%H', datetime(created_at / 1000, 'unixepoch')) AS INTEGER) AS hour,
    COUNT(*) AS message_count,
    COUNT(DISTINCT session_id) AS session_count
FROM conversations
GROUP BY hour
ORDER BY hour;

CREATE VIEW IF NOT EXISTS submission_conversion AS
SELECT
    DATE(submitted_at / 1000, 'unixepoch') AS date,
    COUNT(*) AS total_submissions,
    SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) AS contacted,
    SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
    ROUND(SUM(CASE WHEN status IN ('contacted', 'resolved') THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS conversion_rate
FROM submissions
GROUP BY date
ORDER BY date DESC;

-- ============================================================
-- INITIAL SEED DATA
-- ============================================================

INSERT OR IGNORE INTO admin_users (username, email, role, created_at, is_active)
VALUES ('admin', 'admin@example.com', 'admin', CAST(strftime('%s','now') AS INTEGER) * 1000, 1);