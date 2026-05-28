/**
 * ai-worker.js — AI-Powered Support Chatbot with Multi-Account Failover
 * Cloudflare Worker with RAG, voice, OCR/handwriting, KB CRUD
 * 
 * Supports 3 fallback Cloudflare accounts for AI workers only
 *
 * Bindings required (wrangler.toml):
 *   AI         — Workers AI (primary)
 *   VECTORIZE  — Vectorize index
 *   DB         — D1 database
 *   KV         — KV namespace (sessions + rate limiting)
 *   BUCKET     — R2 bucket (document storage) [Or B2 Bucket configured via env vars]
 *
 * Secrets (wrangler secret put):
 *   TG_BOT_TOKEN, TG_CHAT_ID, ADMIN_SECRET
 *   CF_ACCOUNT_ID_1, CF_ACCOUNT_ID_2, CF_ACCOUNT_ID_3 (for multi-account)
 *   CF_API_TOKEN_1, CF_API_TOKEN_2, CF_API_TOKEN_3
 *   B2_ENDPOINT, B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY, B2_BUCKET_NAME, B2_REGION
 */

import { AwsClient } from 'aws4fetch';

// ─── B2 Bucket Adapter ────────────────────────────────────────────────────────
class B2BucketAdapter {
  constructor(env) {
    this.env = env;
    this.aws = new AwsClient({
      accessKeyId: env.B2_ACCESS_KEY_ID,
      secretAccessKey: env.B2_SECRET_ACCESS_KEY,
      service: 's3',
      region: env.B2_REGION || 'us-east-005',
    });
    this.endpoint = env.B2_ENDPOINT; // e.g. https://s3.us-east-005.backblazeb2.com
    this.bucketName = env.B2_BUCKET_NAME;
  }

  async put(key, value, options = {}) {
    const url = `${this.endpoint}/${this.bucketName}/${key}`;
    const headers = {};
    if (options.httpMetadata?.contentType) {
      headers['Content-Type'] = options.httpMetadata.contentType;
    }
    const req = await this.aws.sign(url, {
      method: 'PUT',
      headers,
      body: value
    });
    const res = await fetch(req);
    if (!res.ok) throw new Error(`B2 put error: ${await res.text()}`);
    return res;
  }

  async get(key) {
    const url = `${this.endpoint}/${this.bucketName}/${key}`;
    const req = await this.aws.sign(url, { method: 'GET' });
    const res = await fetch(req);
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`B2 get error: ${await res.text()}`);
    }
    return {
      text: async () => res.text()
    };
  }

  async delete(key) {
    const url = `${this.endpoint}/${this.bucketName}/${key}`;
    const req = await this.aws.sign(url, { method: 'DELETE' });
    const res = await fetch(req);
    if (!res.ok && res.status !== 404) throw new Error(`B2 delete error: ${await res.text()}`);
    return res;
  }
}

// ─── CORS headers ─────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Secret',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ success: false, error: msg }, status);
}

// ─── Helper Functions ─────────────────────────────────────────────────────────
function truncateContext(context, maxLength = 3000) {
  if (!context || context.length <= maxLength) return context;
  return context.slice(0, maxLength) + '\n… (truncated)';
}

async function validateVectorize(env) {
  if (!env.VECTORIZE) return false;
  try {
    await env.VECTORIZE.query(new Array(768).fill(0), { topK: 1 });
    return true;
  } catch (e) {
    console.warn('Vectorize validation failed:', e.message);
    return false;
  }
}

// ─── Multi-Account AI Client ─────────────────────────────────────────────────
class MultiAccountAI {
  constructor(env) {
    this.env = env;
    this.accounts = [];
    this.currentAccount = 0;
    this.failureCounts = new Map();
    
    if (env.AI) {
      this.accounts.push({
        name: 'primary',
        binding: env.AI,
        accountId: env.CF_ACCOUNT_ID_1,
        apiToken: env.CF_API_TOKEN_1,
        type: 'binding'
      });
    }
    
    if (env.CF_API_TOKEN_2 && env.CF_ACCOUNT_ID_2) {
      this.accounts.push({
        name: 'fallback1',
        accountId: env.CF_ACCOUNT_ID_2,
        apiToken: env.CF_API_TOKEN_2,
        type: 'api'
      });
    }
    
    if (env.CF_API_TOKEN_3 && env.CF_ACCOUNT_ID_3) {
      this.accounts.push({
        name: 'fallback2',
        accountId: env.CF_ACCOUNT_ID_3,
        apiToken: env.CF_API_TOKEN_3,
        type: 'api'
      });
    }
  }
  
  async run(model, input, retryCount = 0) {
    const maxRetries = this.accounts.length * 2;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const account = this.accounts[this.currentAccount];
      
      try {
        let result;
        
        if (account.type === 'binding') {
          result = await account.binding.run(model, input);
        } else {
          result = await this.callAccountAPI(account, model, input);
        }
        
        this.failureCounts.set(account.name, 0);
        return result;
        
      } catch (error) {
        console.error(`AI failed on ${account.name}:`, error.message);
        
        const failures = (this.failureCounts.get(account.name) || 0) + 1;
        this.failureCounts.set(account.name, failures);
        
        if (failures >= 3) {
          this.currentAccount = (this.currentAccount + 1) % this.accounts.length;
        }
        
        await new Promise(r => setTimeout(r, Math.min(100 * Math.pow(2, attempt), 1000)));
      }
    }
    
    throw new Error('All AI accounts failed');
  }
  
  async callAccountAPI(account, model, input) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${account.accountId}/ai/run/${model}`;
    
    let body;
    if (input.messages) {
      body = input;
    } else if (input.text) {
      body = input;
    } else if (input.audio) {
      body = { audio: input.audio };
    } else if (input.image) {
      body = { image: input.image, prompt: input.prompt, max_tokens: input.max_tokens };
    } else {
      body = input;
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${account.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error ${response.status}: ${error}`);
    }
    
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.errors?.[0]?.message || 'Unknown API error');
    }
    
    return data.result;
  }
  
  async healthCheck() {
    const results = [];
    for (const account of this.accounts) {
      try {
        const start = Date.now();
        await this.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1
        });
        results.push({
          name: account.name,
          status: 'healthy',
          latency: Date.now() - start,
          type: account.type
        });
      } catch (error) {
        results.push({
          name: account.name,
          status: 'unhealthy',
          error: error.message,
          type: account.type
        });
      }
    }
    return results;
  }
  
  getActiveAccount() {
    return this.accounts[this.currentAccount];
  }
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
async function checkRateLimit(env, ip, sessionId = null) {
  const ipKey = `rate:ip:${ip}`;
  const sessionKey = sessionId ? `rate:session:${sessionId}` : null;
  const max = parseInt(env.RATE_LIMIT_MAX || '100');
  const ttl = parseInt(env.RATE_LIMIT_WINDOW || '3600');
  
  const ipCount = parseInt((await env.KV.get(ipKey)) || '0');
  if (ipCount >= max) return false;
  
  if (sessionKey) {
    const sessionCount = parseInt((await env.KV.get(sessionKey)) || '0');
    if (sessionCount >= max) return false;
    await env.KV.put(sessionKey, String(sessionCount + 1), { expirationTtl: ttl });
  }
  
  await env.KV.put(ipKey, String(ipCount + 1), { expirationTtl: ttl });
  return true;
}

// ─── Admin auth ───────────────────────────────────────────────────────────────
function isAdmin(req, env) {
  const header = req.headers.get('X-Admin-Secret') || '';
  const query = new URL(req.url).searchParams.get('secret') || '';
  return (header || query) === (env.ADMIN_SECRET || '');
}

// ─── Embedding helper ─────────────────────────────────────────────────────────
async function embed(env, text) {
  const multiAI = env.__multiAI || new MultiAccountAI(env);
  env.__multiAI = multiAI;
  
  const model = env.EMBEDDING_MODEL || '@cf/baai/bge-base-en-v1.5';
  const result = await multiAI.run(model, { text: [text] });
  return result.data[0];
}

// ─── Chunk text for vectorize ─────────────────────────────────────────────────
function chunkText(text, size = 512, overlap = 64) {
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += size - overlap) {
    chunks.push(words.slice(i, i + size).join(' '));
    if (i + size >= words.length) break;
  }
  return chunks;
}

// ─── Retrieve RAG context ─────────────────────────────────────────────────────
async function retrieveContext(env, query, topK = 5) {
  if (!env.VECTORIZE) {
    return '';
  }
  
  try {
    const vector = await embed(env, query);
    const results = await env.VECTORIZE.query(vector, { topK, returnMetadata: true });
    
    if (!results.matches || results.matches.length === 0) {
      return '';
    }
    
    const validMatches = results.matches.filter(m => m.score > 0.5);
    
    if (validMatches.length === 0) {
      return '';
    }
    
    const bestMatch = validMatches[0];
    
    await env.DB.prepare(
      'INSERT INTO kb_search_log (query, top_doc_id, score, session_id, created_at) VALUES (?,?,?,?,?)'
    ).bind(query.slice(0, 500), bestMatch.metadata?.docId || 'unknown', bestMatch.score || 0, null, Date.now()).run().catch(() => {});
    
    const context = validMatches
      .map(m => m.metadata?.text || '')
      .filter(Boolean)
      .join('\n\n---\n\n');
    
    return truncateContext(context, 3000);
  } catch (e) {
    console.error('RAG retrieval error:', e);
    return '';
  }
}

// ─── Generate AI response ─────────────────────────────────────────────────────
async function generateAIResponse(env, messages, context = '') {
  const multiAI = env.__multiAI || new MultiAccountAI(env);
  env.__multiAI = multiAI;
  
  const model = env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';

  const system = `You are a helpful, professional support assistant.
${context ? `Use this knowledge base context to answer accurately:\n\n${context}\n\n` : ''}
If the context doesn't cover the question, answer from general knowledge but be honest about uncertainty.
Keep responses concise and friendly. Never make up specific prices, dates, or contact details not in context.`;

  const response = await multiAI.run(model, {
    messages: [
      { role: 'system', content: system },
      ...messages,
    ],
    max_tokens: parseInt(env.MAX_TOKENS || '1000'),
  });

  return response.response || response.result?.response || 'I apologize, I could not generate a response.';
}

// ─── Streaming AI response ────────────────────────────────────────────────────
async function generateAIResponseStream(env, messages, context = '') {
  const multiAI = env.__multiAI || new MultiAccountAI(env);
  env.__multiAI = multiAI;
  
  const model = env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';
  
  const system = `You are a helpful, professional support assistant.
${context ? `Use this knowledge base context to answer accurately:\n\n${context}\n\n` : ''}
If the context doesn't cover the question, answer from general knowledge but be honest about uncertainty.
Keep responses concise and friendly. Never make up specific prices, dates, or contact details not in context.`;

  const account = multiAI.getActiveAccount();
  
  if (account.type === 'binding') {
    return await account.binding.run(model, {
      messages: [
        { role: 'system', content: system },
        ...messages,
      ],
      max_tokens: parseInt(env.MAX_TOKENS || '1000'),
      stream: true,
    });
  } else {
    const response = await multiAI.run(model, {
      messages: [
        { role: 'system', content: system },
        ...messages,
      ],
      max_tokens: parseInt(env.MAX_TOKENS || '1000'),
    });
    
    const text = response.response || response.result?.response || '';
    const encoder = new TextEncoder();
    const chunks = text.split(/(?<=[.!?])\s+/);
    
    const stream = new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk + ' '));
          await new Promise(r => setTimeout(r, 50));
        }
        controller.close();
      }
    });
    
    return stream;
  }
}

// ─── Telegram notification ────────────────────────────────────────────────────
async function notifyTelegram(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch { /* non-critical */ }
}

// ─── Session helpers ──────────────────────────────────────────────────────────
async function getSession(env, sessionId) {
  const raw = await env.KV.get(`session:${sessionId}`);
  return raw ? JSON.parse(raw) : { messages: [], created: Date.now() };
}

async function saveSession(env, sessionId, session) {
  await env.KV.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: 86400,
  });
}

// ─── Intent detection ─────────────────────────────────────────────────────────
function detectIntent(message) {
  const m = message.toLowerCase();
  const intents = [
    { name: 'pricing', patterns: ['price', 'cost', 'fee', 'how much', 'rate', 'charge', 'plan'], confidence: 0.9 },
    { name: 'support', patterns: ['help', 'issue', 'problem', 'error', 'broken', 'not working', 'fix'], confidence: 0.85 },
    { name: 'schedule', patterns: ['schedule', 'book', 'appointment', 'meeting', 'session', 'time'], confidence: 0.9 },
    { name: 'services', patterns: ['service', 'offer', 'provide', 'do you', 'can you'], confidence: 0.75 },
    { name: 'technical', patterns: ['windows', 'mac', 'linux', 'software', 'install', 'setup', 'configure'], confidence: 0.8 },
    { name: 'greeting', patterns: ['hello', 'hi', 'hey', 'good morning', 'good afternoon'], confidence: 0.95 },
    { name: 'complaint', patterns: ['unhappy', 'disappointed', 'terrible', 'awful', 'complaint', 'refund'], confidence: 0.9 },
  ];

  for (const intent of intents) {
    if (intent.patterns.some(p => m.includes(p))) {
      return { name: intent.name, confidence: intent.confidence };
    }
  }
  return { name: 'general', confidence: 0.5 };
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTE HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/ai/status ─────────────────────────────────────────────────
async function handleAIStatus(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  
  const multiAI = env.__multiAI || new MultiAccountAI(env);
  env.__multiAI = multiAI;
  
  const status = await multiAI.healthCheck();
  const active = multiAI.getActiveAccount();
  
  return json({
    success: true,
    activeAccount: active,
    accounts: status,
    totalAccounts: multiAI.accounts.length,
    timestamp: Date.now()
  });
}

// ── POST /api/admin/ai/switch ─────────────────────────────────────────────────
async function handleAISwitch(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  
  const body = await req.json().catch(() => null);
  const accountName = body?.account;
  
  const multiAI = env.__multiAI || new MultiAccountAI(env);
  env.__multiAI = multiAI;
  
  const index = multiAI.accounts.findIndex(a => a.name === accountName);
  if (index === -1) {
    return err(`Account "${accountName}" not found. Available: ${multiAI.accounts.map(a => a.name).join(', ')}`);
  }
  
  multiAI.currentAccount = index;
  multiAI.failureCounts.clear();
  
  return json({
    success: true,
    activeAccount: multiAI.getActiveAccount(),
    message: `Switched to ${accountName}`
  });
}

// ── POST /api/chat ────────────────────────────────────────────────────────────
async function handleChat(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const body = await req.json().catch(() => null);
  if (!body?.message) return err('message is required');
  
  const sessionId = body.sessionId || crypto.randomUUID();
  
  const allowed = await checkRateLimit(env, ip, sessionId);
  if (!allowed) return err('Rate limit exceeded', 429);

  const session = await getSession(env, sessionId);
  session.messages.push({ role: 'user', content: body.message });
  if (session.messages.length > 20) session.messages = session.messages.slice(-20);

  const context = await retrieveContext(env, body.message);
  const intent = detectIntent(body.message);
  
  const beforeAccount = (env.__multiAI || new MultiAccountAI(env)).getActiveAccount();
  const reply = await generateAIResponse(env, session.messages, context);
  const afterAccount = (env.__multiAI || new MultiAccountAI(env)).getActiveAccount();
  const aiAccountUsed = afterAccount.name;
  
  session.messages.push({ role: 'assistant', content: reply });
  await saveSession(env, sessionId, session);

  await env.DB.prepare(
    'INSERT INTO conversations (session_id, message, response, intent, confidence, input_type, ai_account, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(sessionId, body.message, reply, intent.name, intent.confidence, 'text', aiAccountUsed, Date.now()).run();

  return json({ success: true, reply, sessionId, intent, aiAccount: aiAccountUsed });
}

// ── POST /api/chat/stream ─────────────────────────────────────────────────────
async function handleChatStream(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const body = await req.json().catch(() => null);
  if (!body?.message) return err('message required');
  
  const sessionId = body.sessionId || crypto.randomUUID();
  const allowed = await checkRateLimit(env, ip, sessionId);
  if (!allowed) return err('Rate limit exceeded', 429);
  
  const session = await getSession(env, sessionId);
  session.messages.push({ role: 'user', content: body.message });
  if (session.messages.length > 20) session.messages = session.messages.slice(-20);
  
  const context = await retrieveContext(env, body.message);
  const intent = detectIntent(body.message);
  
  const aiStream = await generateAIResponseStream(env, session.messages, context);
  
  let fullResponse = '';
  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      fullResponse += text;
      controller.enqueue(chunk);
    }
  });
  
  aiStream.pipeTo(writable);
  
  const afterAccount = (env.__multiAI || new MultiAccountAI(env)).getActiveAccount();
  const aiAccountUsed = afterAccount.name;
  
  setTimeout(async () => {
    session.messages.push({ role: 'assistant', content: fullResponse });
    await saveSession(env, sessionId, session);
    await env.DB.prepare(
      'INSERT INTO conversations (session_id, message, response, intent, confidence, input_type, ai_account, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(sessionId, body.message, fullResponse, intent.name, intent.confidence, 'text', aiAccountUsed, Date.now()).run();
  }, 0);
  
  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain', ...CORS }
  });
}

// ── POST /api/chat/voice ──────────────────────────────────────────────────────
async function handleVoiceChat(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  
  let audioData, sessionId, mimeType;
  const ct = req.headers.get('Content-Type') || '';

  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('audio');
    if (!file) return err('audio file required');
    const buf = await file.arrayBuffer();
    audioData = [...new Uint8Array(buf)];
    sessionId = form.get('sessionId') || crypto.randomUUID();
    mimeType = file.type || 'audio/webm';
  } else {
    const body = await req.json().catch(() => null);
    if (!body?.audio) return err('audio (base64) required');
    const bin = atob(body.audio);
    audioData = [...new Uint8Array(bin.length)].map((_, i) => bin.charCodeAt(i));
    sessionId = body.sessionId || crypto.randomUUID();
    mimeType = body.mimeType || 'audio/webm';
  }
  
  const allowed = await checkRateLimit(env, ip, sessionId);
  if (!allowed) return err('Rate limit exceeded', 429);

  const multiAI = env.__multiAI || new MultiAccountAI(env);
  env.__multiAI = multiAI;
  
  let transcript;
  try {
    const whisperResult = await multiAI.run('@cf/openai/whisper', { audio: audioData });
    transcript = whisperResult.text?.trim();
    if (!transcript) return err('Could not transcribe audio');
  } catch (e) {
    return err(`Transcription failed: ${e.message}`);
  }

  const session = await getSession(env, sessionId);
  session.messages.push({ role: 'user', content: transcript });
  if (session.messages.length > 20) session.messages = session.messages.slice(-20);

  const context = await retrieveContext(env, transcript);
  const intent = detectIntent(transcript);
  const reply = await generateAIResponse(env, session.messages, context);
  const aiAccountUsed = multiAI.getActiveAccount().name;

  session.messages.push({ role: 'assistant', content: reply });
  await saveSession(env, sessionId, session);

  await env.DB.prepare(
    'INSERT INTO conversations (session_id, message, response, intent, confidence, input_type, ai_account, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(sessionId, `[VOICE] ${transcript}`, reply, intent.name, intent.confidence, 'voice', aiAccountUsed, Date.now()).run();

  return json({ success: true, transcript, reply, sessionId, intent, aiAccount: aiAccountUsed });
}

// ── POST /api/chat/ocr ────────────────────────────────────────────────────────
async function handleOCRChat(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  
  let imageBase64, mimeType, sessionId, prompt;
  const ct = req.headers.get('Content-Type') || '';

  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('image');
    if (!file) return err('image file required');
    const buf = await file.arrayBuffer();
    imageBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    mimeType = file.type || 'image/jpeg';
    sessionId = form.get('sessionId') || crypto.randomUUID();
    prompt = form.get('prompt') || 'What does this document say? Extract all text including any handwriting.';
  } else {
    const body = await req.json().catch(() => null);
    if (!body?.image) return err('image (base64) required');
    imageBase64 = body.image;
    mimeType = body.mimeType || 'image/jpeg';
    sessionId = body.sessionId || crypto.randomUUID();
    prompt = body.prompt || 'What does this document say? Extract all text including any handwriting.';
  }
  
  const allowed = await checkRateLimit(env, ip, sessionId);
  if (!allowed) return err('Rate limit exceeded', 429);
  
  if (mimeType === 'application/pdf') {
    return err('PDF support coming soon. Please upload an image file (JPEG, PNG, etc.)');
  }

  const multiAI = env.__multiAI || new MultiAccountAI(env);
  env.__multiAI = multiAI;
  
  let extractedText;
  try {
    const visionResult = await multiAI.run('@cf/llava-hf/llava-1.5-7b-hf', {
      image: [...atob(imageBase64)].map(c => c.charCodeAt(0)),
      prompt: `${prompt}\n\nPlease transcribe ALL text visible in the image, including:\n- Printed/typed text\n- Handwritten text\n- Signatures\n- Stamps or labels\nFormat the output clearly, marking handwritten sections with [Handwritten: ...]`,
      max_tokens: 1024,
    });
    extractedText = visionResult.description || visionResult.response || '';
    if (!extractedText) return err('Could not extract text from image');
  } catch (e) {
    return err(`OCR failed: ${e.message}`);
  }

  const session = await getSession(env, sessionId);
  const userMsg = `I've shared an image/document. Here's the extracted content:\n\n${extractedText}\n\nCan you help me with this?`;
  session.messages.push({ role: 'user', content: userMsg });
  if (session.messages.length > 20) session.messages = session.messages.slice(-20);

  const context = await retrieveContext(env, extractedText);
  const reply = await generateAIResponse(env, session.messages, context);
  const aiAccountUsed = multiAI.getActiveAccount().name;

  session.messages.push({ role: 'assistant', content: reply });
  await saveSession(env, sessionId, session);

  await env.DB.prepare(
    'INSERT INTO conversations (session_id, message, response, intent, confidence, input_type, ai_account, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(sessionId, `[OCR] ${extractedText.slice(0, 200)}`, reply, 'document', 0.9, 'ocr', aiAccountUsed, Date.now()).run();

  return json({ success: true, extractedText, reply, sessionId, aiAccount: aiAccountUsed });
}

// ── GET /api/conversations/:sessionId ─────────────────────────────────────────
async function getConversationHistory(req, env, sessionId) {
  const { results } = await env.DB.prepare(
    'SELECT message, response, intent, input_type, ai_account, created_at FROM conversations WHERE session_id = ? ORDER BY created_at ASC'
  ).bind(sessionId).all();
  
  return json({ success: true, sessionId, messages: results });
}

// ── POST /api/feedback ────────────────────────────────────────────────────────
async function handleFeedback(req, env) {
  const body = await req.json().catch(() => null);
  if (!body?.rating || !body?.sessionId) return err('rating and sessionId required');
  if (body.rating < 1 || body.rating > 5) return err('rating must be 1-5');
  
  await env.DB.prepare(
    'INSERT INTO feedback (session_id, rating, comment, created_at) VALUES (?,?,?,?)'
  ).bind(body.sessionId, body.rating, body.comment || null, Date.now()).run();
  
  return json({ success: true });
}

// ── POST /api/kb/search ───────────────────────────────────────────────────────
async function handleKBSearch(req, env) {
  const body = await req.json().catch(() => null);
  if (!body?.query) return err('query required');
  
  const topK = body.topK || 5;
  
  if (!env.VECTORIZE) {
    return err('Vectorize not configured', 503);
  }
  
  try {
    const vector = await embed(env, body.query);
    const results = await env.VECTORIZE.query(vector, { topK, returnMetadata: true });
    
    if (results.matches && results.matches.length > 0) {
      await env.DB.prepare(
        'INSERT INTO kb_search_log (query, top_doc_id, score, session_id, created_at) VALUES (?,?,?,?,?)'
      ).bind(body.query.slice(0, 500), results.matches[0].metadata?.docId || 'unknown', results.matches[0].score || 0, body.sessionId || null, Date.now()).run().catch(() => {});
    }
    
    return json({
      success: true,
      query: body.query,
      results: results.matches.map(m => ({
        score: m.score,
        text: m.metadata?.text,
        docId: m.metadata?.docId,
        title: m.metadata?.title,
        category: m.metadata?.category,
        chunkIndex: m.metadata?.chunkIndex
      }))
    });
  } catch (e) {
    return err(`Search failed: ${e.message}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  KNOWLEDGE BASE — COMPLETE CRUD HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

// ── POST /api/admin/kb/upload ─────────────────────────────────────────────────
async function handleKBUpload(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);

  const body = await req.json().catch(() => null);
  if (!body?.title || !body?.document) return err('title and document are required');

  const { title, category = 'general', tags = '', document: content } = body;
  const chunks = chunkText(content);
  const docId = crypto.randomUUID();
  const now = Date.now();
  const contentPreview = content.slice(0, 300);

  await env.DB.prepare(
    `INSERT INTO knowledge_documents (doc_id, title, category, tags, chunk_count, content_preview, uploaded_at, last_modified, uploaded_by, status) 
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(docId, title, category, tags, chunks.length, contentPreview, now, now, 'api', 'active').run();

  if (env.BUCKET) {
    try {
      await env.BUCKET.put(`kb/${docId}.txt`, content, {
        httpMetadata: { contentType: 'text/plain' },
        customMetadata: { title, category, docId, tags },
      });
    } catch (e) {
      console.warn('R2 storage skipped:', e.message);
    }
  }

  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    const vector = await embed(env, chunks[i]);
    vectors.push({
      id: `${docId}-${i}`,
      values: vector,
      metadata: { text: chunks[i], title, category, docId, chunkIndex: i, tags },
    });
  }

  for (let i = 0; i < vectors.length; i += 100) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + 100));
  }

  return json({ success: true, docId, chunks: chunks.length, title });
}

// ── GET /api/admin/kb ─────────────────────────────────────────────────────────
async function handleKBList(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);

  const url = new URL(req.url);
  const category = url.searchParams.get('category');
  const status = url.searchParams.get('status') || 'active';
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  let query = 'SELECT * FROM knowledge_documents WHERE status = ?';
  let params = [status];

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }

  query += ' ORDER BY uploaded_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const { results } = await env.DB.prepare(query).bind(...params).all();
  const { results: countRes } = await env.DB.prepare(
    'SELECT COUNT(*) as total FROM knowledge_documents WHERE status = ?'
  ).bind(status).all();

  return json({ success: true, documents: results, total: countRes[0]?.total || 0 });
}

// ── GET /api/admin/kb/:docId ──────────────────────────────────────────────────
async function handleKBGet(req, env, docId) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);

  const { results } = await env.DB.prepare(
    'SELECT * FROM knowledge_documents WHERE doc_id = ?'
  ).bind(docId).all();

  if (!results.length) return err('Document not found', 404);

  const doc = results[0];
  let content = null;
  if (env.BUCKET) {
    try {
      const obj = await env.BUCKET.get(`kb/${docId}.txt`);
      if (obj) content = await obj.text();
    } catch { /* R2 optional */ }
  }

  return json({ success: true, document: doc, content });
}

// ── PUT /api/admin/kb/:docId ──────────────────────────────────────────────────
async function handleKBUpdate(req, env, docId) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);

  const body = await req.json().catch(() => null);
  if (!body) return err('Request body required');

  const { results } = await env.DB.prepare(
    'SELECT * FROM knowledge_documents WHERE doc_id = ?'
  ).bind(docId).all();
  if (!results.length) return err('Document not found', 404);

  const existing = results[0];
  const title = body.title || existing.title;
  const category = body.category || existing.category;
  const tags = body.tags || existing.tags;

  await env.DB.prepare(
    'UPDATE knowledge_documents SET title=?, category=?, tags=?, last_modified=? WHERE doc_id=?'
  ).bind(title, category, tags, Date.now(), docId).run();

  if (body.document) {
    const oldChunkCount = existing.chunk_count || 0;
    const oldIds = Array.from({ length: oldChunkCount }, (_, i) => `${docId}-${i}`);
    if (oldIds.length) {
      try { await env.VECTORIZE.deleteByIds(oldIds); } catch { /* best effort */ }
    }

    const chunks = chunkText(body.document);
    const vectors = [];

    for (let i = 0; i < chunks.length; i++) {
      const vector = await embed(env, chunks[i]);
      vectors.push({
        id: `${docId}-${i}`,
        values: vector,
        metadata: { text: chunks[i], title, category, docId, chunkIndex: i, tags },
      });
    }

    for (let i = 0; i < vectors.length; i += 100) {
      await env.VECTORIZE.upsert(vectors.slice(i, i + 100));
    }

    if (env.BUCKET) {
      try {
        await env.BUCKET.put(`kb/${docId}.txt`, body.document, {
          httpMetadata: { contentType: 'text/plain' },
          customMetadata: { title, category, docId, tags },
        });
      } catch { /* R2 optional */ }
    }

    await env.DB.prepare(
      'UPDATE knowledge_documents SET chunk_count=?, content_preview=? WHERE doc_id=?'
    ).bind(chunks.length, body.document.slice(0, 300), docId).run();
  }

  return json({ success: true, docId, title, category });
}

// ── DELETE /api/admin/kb/:docId ───────────────────────────────────────────────
async function handleKBDelete(req, env, docId) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);

  const { results } = await env.DB.prepare(
    'SELECT * FROM knowledge_documents WHERE doc_id = ?'
  ).bind(docId).all();
  if (!results.length) return err('Document not found', 404);

  const doc = results[0];

  await env.DB.prepare(
    "UPDATE knowledge_documents SET status='archived' WHERE doc_id=?"
  ).bind(docId).run();

  const ids = Array.from({ length: doc.chunk_count || 0 }, (_, i) => `${docId}-${i}`);
  if (ids.length) {
    try { await env.VECTORIZE.deleteByIds(ids); } catch { /* best effort */ }
  }

  if (env.BUCKET) {
    try { await env.BUCKET.delete(`kb/${docId}.txt`); } catch { /* R2 optional */ }
  }

  return json({ success: true, docId, deleted: true });
}

// ── DELETE /api/admin/kb/bulk ─────────────────────────────────────────────────
async function handleKBBulkDelete(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  
  const body = await req.json().catch(() => null);
  if (!body?.docIds || !Array.isArray(body.docIds)) return err('docIds array required');
  
  const results = [];
  for (const docId of body.docIds) {
    try {
      const { results: existing } = await env.DB.prepare(
        'SELECT * FROM knowledge_documents WHERE doc_id = ?'
      ).bind(docId).all();
      
      if (existing.length) {
        await env.DB.prepare("UPDATE knowledge_documents SET status='archived' WHERE doc_id=?").bind(docId).run();
        results.push({ docId, success: true });
      } else {
        results.push({ docId, success: false, error: 'Not found' });
      }
    } catch (e) {
      results.push({ docId, success: false, error: e.message });
    }
  }
  
  return json({ success: true, results });
}

// ── POST /api/admin/kb/:docId/restore ────────────────────────────────────────
async function handleKBRestore(req, env, docId) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);

  const { results } = await env.DB.prepare(
    'SELECT * FROM knowledge_documents WHERE doc_id = ?'
  ).bind(docId).all();
  if (!results.length) return err('Document not found', 404);
  if (results[0].status === 'active') return err('Document is already active');

  let content = null;
  if (env.BUCKET) {
    try {
      const obj = await env.BUCKET.get(`kb/${docId}.txt`);
      if (obj) content = await obj.text();
    } catch { /* R2 optional */ }
  }

  if (content) {
    const chunks = chunkText(content);
    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
      const vector = await embed(env, chunks[i]);
      vectors.push({
        id: `${docId}-${i}`,
        values: vector,
        metadata: { text: chunks[i], title: results[0].title, category: results[0].category, docId, chunkIndex: i, tags: results[0].tags },
      });
    }
    for (let i = 0; i < vectors.length; i += 100) {
      await env.VECTORIZE.upsert(vectors.slice(i, i + 100));
    }
    await env.DB.prepare('UPDATE knowledge_documents SET chunk_count=? WHERE doc_id=?').bind(chunks.length, docId).run();
  }

  await env.DB.prepare(
    "UPDATE knowledge_documents SET status='active', last_modified=? WHERE doc_id=?"
  ).bind(Date.now(), docId).run();

  return json({ success: true, docId, restored: true });
}

// ── POST /api/admin/kb/bulk-upload ───────────────────────────────────────────
async function handleKBBulkUpload(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);

  const body = await req.json().catch(() => null);
  if (!Array.isArray(body?.documents)) return err('documents array required');

  const results = [];
  for (const doc of body.documents) {
    try {
      const fakeReq = new Request(req.url, {
        method: 'POST',
        headers: { ...Object.fromEntries(req.headers), 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      });
      const res = await handleKBUpload(fakeReq, env);
      const data = await res.json();
      results.push({ ...data, title: doc.title });
    } catch (e) {
      results.push({ success: false, title: doc.title, error: e.message });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  return json({ success: true, results, succeeded, failed: results.length - succeeded });
}

// ── GET /api/admin/submissions ────────────────────────────────────────────────
async function handleSubmissionsList(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  
  const url = new URL(req.url);
  const status = url.searchParams.get('status') || 'pending';
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const offset = parseInt(url.searchParams.get('offset') || '0');
  
  const { results } = await env.DB.prepare(
    'SELECT * FROM submissions WHERE status = ? ORDER BY submitted_at DESC LIMIT ? OFFSET ?'
  ).bind(status, limit, offset).all();
  
  return json({ success: true, submissions: results });
}

// ── PUT /api/admin/submissions/:id ────────────────────────────────────────────
async function handleSubmissionUpdate(req, env, id) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  
  const body = await req.json().catch(() => null);
  if (!body) return err('Request body required');
  
  const { status, notes } = body;
  const resolved_at = status === 'resolved' ? Date.now() : null;
  
  await env.DB.prepare(
    'UPDATE submissions SET status = ?, notes = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?'
  ).bind(status || 'pending', notes || null, resolved_at, parseInt(id)).run();
  
  return json({ success: true, id });
}

// ── GET /api/admin/export/conversations ───────────────────────────────────────
async function handleExportConversations(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  
  const url = new URL(req.url);
  const format = url.searchParams.get('format') || 'json';
  const limit = parseInt(url.searchParams.get('limit') || '1000');
  
  const { results } = await env.DB.prepare(
    'SELECT * FROM conversations ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all();
  
  if (format === 'csv') {
    const headers = ['id', 'session_id', 'message', 'response', 'intent', 'confidence', 'input_type', 'ai_account', 'created_at'];
    const csvRows = [headers.join(',')];
    for (const row of results) {
      csvRows.push(headers.map(h => JSON.stringify(row[h] || '')).join(','));
    }
    return new Response(csvRows.join('\n'), {
      headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=conversations.csv', ...CORS }
    });
  }
  
  return json({ success: true, conversations: results });
}

// ── GET /api/admin/conversations ──────────────────────────────────────────────
async function handleAdminConversations(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get('limit') || '100');
  const offset = parseInt(url.searchParams.get('offset') || '0');
  
  const { results } = await env.DB.prepare(
    'SELECT * FROM conversations ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all();
  
  const { results: countRes } = await env.DB.prepare(
    'SELECT COUNT(*) as total FROM conversations'
  ).all();
  
  return json({ success: true, conversations: results, total: countRes[0]?.total || 0 });
}

// ── GET /api/health/detailed ──────────────────────────────────────────────────
async function handleDetailedHealth(req, env) {
  const multiAI = env.__multiAI || new MultiAccountAI(env);
  env.__multiAI = multiAI;
  
  const aiStatus = await multiAI.healthCheck();
  const vectorizeOk = await validateVectorize(env);
  let dbOk = true;
  try {
    await env.DB.prepare('SELECT 1').run();
  } catch { dbOk = false; }
  
  return json({
    ok: true,
    timestamp: Date.now(),
    components: {
      ai: aiStatus,
      vectorize: vectorizeOk ? 'healthy' : 'unhealthy',
      database: dbOk ? 'healthy' : 'unhealthy',
      kv: !!env.KV,
      r2: !!env.BUCKET
    },
    activeAccount: multiAI.getActiveAccount().name
  });
}

// ── POST /api/telegram/webhook ────────────────────────────────────────────────
async function handleTelegramWebhook(req, env) {
  const body = await req.json().catch(() => null);
  if (!body?.message) return json({ ok: true });
  
  const chatId = body.message.chat.id;
  const text = body.message.text;
  
  if (text?.startsWith('/start')) {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '🤖 Welcome to AI Support Bot!\n\nSend me any question and I\'ll help you based on our knowledge base.\n\nYou can also send voice messages or images with text!'
      })
    });
  } else if (text) {
    const sessionId = `telegram:${chatId}`;
    const session = await getSession(env, sessionId);
    session.messages.push({ role: 'user', content: text });
    if (session.messages.length > 20) session.messages = session.messages.slice(-20);
    
    const context = await retrieveContext(env, text);
    const reply = await generateAIResponse(env, session.messages, context);
    
    session.messages.push({ role: 'assistant', content: reply });
    await saveSession(env, sessionId, session);
    
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply })
    });
  }
  
  return json({ ok: true });
}

// ── Form submission ──────────────────────────────────────────────────────────
async function handleSubmission(req, env) {
  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.email) return err('name and email are required');

  const ip = req.headers.get('CF-Connecting-IP') || '';
  const cf = req.cf || {};

  const result = await env.DB.prepare(
    `INSERT INTO submissions
      (flow, name, email, phone, contact_method, contact_detail, summary, session_id, timezone, country, ip, submitted_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    body.flow || 'inquiry', body.name, body.email, body.phone || '',
    body.contactMethod || '', body.contactDetail || '',
    body.summary || '', body.sessionId || '',
    cf.timezone || '', cf.country || '', ip, Date.now(), 'pending'
  ).run();

  await notifyTelegram(env,
    `📬 <b>New ${body.flow || 'inquiry'} submission</b>\n` +
    `👤 ${body.name} &lt;${body.email}&gt;\n` +
    `📝 ${body.summary?.slice(0, 200) || 'No summary'}`
  );

  return json({ success: true, id: result.meta?.last_row_id });
}

// ─── Analytics ────────────────────────────────────────────────────────────────
async function handleAnalytics(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);

  const [convRes, subRes, feedRes, intentRes, inputTypeRes, kbStatsRes, aiAccountRes] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as total, COUNT(DISTINCT session_id) as sessions FROM conversations').all(),
    env.DB.prepare('SELECT status, COUNT(*) as count FROM submissions GROUP BY status').all(),
    env.DB.prepare('SELECT AVG(rating) as avg_rating, COUNT(*) as total FROM feedback').all(),
    env.DB.prepare('SELECT intent, COUNT(*) as count FROM conversations WHERE intent IS NOT NULL GROUP BY intent ORDER BY count DESC LIMIT 10').all(),
    env.DB.prepare('SELECT input_type, COUNT(*) as count FROM conversations GROUP BY input_type').all(),
    env.DB.prepare('SELECT COUNT(*) as total_searches, AVG(score) as avg_score FROM kb_search_log').all(),
    env.DB.prepare('SELECT ai_account, COUNT(*) as count FROM conversations WHERE ai_account IS NOT NULL GROUP BY ai_account').all(),
  ]);

  return json({
    success: true,
    conversations: convRes.results[0],
    submissions: subRes.results,
    feedback: feedRes.results[0],
    topIntents: intentRes.results,
    inputTypes: inputTypeRes.results,
    kbSearch: kbStatsRes.results[0],
    aiAccountUsage: aiAccountRes.results,
  });
}

// ─── HTML chat UI ─────────────────────────────────────────────────────────────
function buildHtml(env) {
  const workerUrl = env.WORKER_API_URL || '';
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Support Chat (Multi-Account HA)</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f5f7fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  #chat { background: white; border-radius: 16px; box-shadow: 0 4px 32px rgba(0,0,0,.12); width: 420px; max-width: 98vw; display: flex; flex-direction: column; height: 640px; }
  #chat-header { background: #2563eb; color: white; padding: 18px 20px; border-radius: 16px 16px 0 0; font-weight: 600; display: flex; align-items: center; justify-content: space-between; }
  #chat-header .title { display: flex; align-items: center; gap: 10px; }
  #chat-header .dot { width: 10px; height: 10px; background: #4ade80; border-radius: 50%; }
  #ai-status { font-size: 10px; background: rgba(255,255,255,0.2); padding: 4px 8px; border-radius: 12px; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 80%; padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.5; }
  .msg.user { background: #2563eb; color: white; align-self: flex-end; border-bottom-right-radius: 4px; }
  .msg.bot { background: #f1f5f9; color: #1e293b; align-self: flex-start; border-bottom-left-radius: 4px; }
  .msg.bot.loading { color: #94a3b8; font-style: italic; }
  .ai-badge { font-size: 9px; opacity: 0.6; margin-top: 4px; }
  #input-area { padding: 12px; border-top: 1px solid #e2e8f0; display: flex; gap: 8px; align-items: center; }
  #msg-input { flex: 1; border: 1px solid #e2e8f0; border-radius: 24px; padding: 10px 16px; font-size: 14px; outline: none; }
  #msg-input:focus { border-color: #2563eb; }
  .btn { border: none; border-radius: 50%; width: 38px; height: 38px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; }
  #send-btn { background: #2563eb; color: white; }
  #voice-btn { background: #f1f5f9; color: #475569; }
  #voice-btn.recording { background: #ef4444; color: white; animation: pulse 1s infinite; }
  #img-btn { background: #f1f5f9; color: #475569; }
  #file-input { display: none; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.6} }
</style>
</head>
<body>
<div id="chat">
  <div id="chat-header">
    <div class="title"><div class="dot"></div>AI Support</div>
    <div id="ai-status">🟢 Primary AI</div>
  </div>
  <div id="messages">
    <div class="msg bot">Hello! How can I help you today? (High-availability AI cluster active)</div>
  </div>
  <div id="input-area">
    <button class="btn" id="img-btn" title="Upload image or document">📎</button>
    <input type="file" id="file-input" accept="image/*">
    <button class="btn" id="voice-btn" title="Voice input">🎤</button>
    <input id="msg-input" type="text" placeholder="Type a message..." autocomplete="off">
    <button class="btn" id="send-btn">➤</button>
  </div>
</div>

<script>
const BASE = '${workerUrl}';
const api = path => (BASE || '') + path;
let sessionId = null;
let mediaRecorder, audioChunks = [], isRecording = false;

const messages = document.getElementById('messages');
const input = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
const voiceBtn = document.getElementById('voice-btn');
const imgBtn = document.getElementById('img-btn');
const fileInput = document.getElementById('file-input');
const aiStatus = document.getElementById('ai-status');

function addMsg(text, role, loading = false, aiAccount = null) {
  const d = document.createElement('div');
  d.className = 'msg ' + role + (loading ? ' loading' : '');
  d.textContent = text;
  if (aiAccount && role === 'bot') {
    const badge = document.createElement('div');
    badge.className = 'ai-badge';
    badge.textContent = '🤖 ' + aiAccount;
    d.appendChild(badge);
  }
  messages.appendChild(d);
  messages.scrollTop = messages.scrollHeight;
  return d;
}

async function sendText(text) {
  if (!text.trim()) return;
  input.value = '';
  addMsg(text, 'user');
  const loading = addMsg('Thinking...', 'bot', true);
  try {
    const res = await fetch(api('/api/chat'), {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ message: text, sessionId })
    });
    const data = await res.json();
    sessionId = data.sessionId;
    loading.textContent = data.reply || 'Sorry, something went wrong.';
    loading.classList.remove('loading');
    if (data.aiAccount) {
      const badge = document.createElement('div');
      badge.className = 'ai-badge';
      badge.textContent = '🤖 ' + data.aiAccount;
      loading.appendChild(badge);
      aiStatus.textContent = data.aiAccount === 'primary' ? '🟢 Primary AI' : '🟡 Fallback AI';
    }
  } catch {
    loading.textContent = 'Connection error. Please try again.';
    loading.classList.remove('loading');
  }
}

sendBtn.onclick = () => sendText(input.value);
input.onkeydown = e => e.key === 'Enter' && sendText(input.value);
imgBtn.onclick = () => fileInput.click();

fileInput.onchange = async () => {
  const file = fileInput.files[0];
  if (!file) return;
  addMsg('📎 Uploading: ' + file.name, 'user');
  const loading = addMsg('Analysing document...', 'bot', true);
  try {
    const form = new FormData();
    form.append('image', file);
    if (sessionId) form.append('sessionId', sessionId);
    const res = await fetch(api('/api/chat/ocr'), { method: 'POST', body: form });
    const data = await res.json();
    sessionId = data.sessionId;
    if (data.extractedText) {
      const preview = document.createElement('div');
      preview.className = 'msg bot';
      preview.style.fontSize = '12px';
      preview.style.color = '#64748b';
      preview.textContent = '📄 Extracted: ' + data.extractedText.slice(0, 120) + (data.extractedText.length > 120 ? '…' : '');
      messages.insertBefore(preview, loading);
    }
    loading.textContent = data.reply || 'Could not process image.';
    loading.classList.remove('loading');
    if (data.aiAccount) {
      const badge = document.createElement('div');
      badge.className = 'ai-badge';
      badge.textContent = '🤖 ' + data.aiAccount;
      loading.appendChild(badge);
    }
  } catch {
    loading.textContent = 'Upload failed. Please try again.';
    loading.classList.remove('loading');
  }
  fileInput.value = '';
};

voiceBtn.onclick = async () => {
  if (isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    voiceBtn.classList.remove('recording');
    voiceBtn.textContent = '🎤';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      addMsg('🎤 Voice message sent', 'user');
      const loading = addMsg('Transcribing...', 'bot', true);
      try {
        const form = new FormData();
        form.append('audio', blob, 'voice.webm');
        if (sessionId) form.append('sessionId', sessionId);
        const res = await fetch(api('/api/chat/voice'), { method: 'POST', body: form });
        const data = await res.json();
        sessionId = data.sessionId;
        if (data.transcript) {
          const t = document.createElement('div');
          t.className = 'msg bot';
          t.style.fontSize = '12px';
          t.style.color = '#64748b';
          t.textContent = '📝 Heard: ' + data.transcript;
          messages.insertBefore(t, loading);
        }
        loading.textContent = data.reply || 'Could not process audio.';
        loading.classList.remove('loading');
        if (data.aiAccount) {
          const badge = document.createElement('div');
          badge.className = 'ai-badge';
          badge.textContent = '🤖 ' + data.aiAccount;
          loading.appendChild(badge);
        }
      } catch {
        loading.textContent = 'Audio processing failed.';
        loading.classList.remove('loading');
      }
    };
    mediaRecorder.start();
    isRecording = true;
    voiceBtn.classList.add('recording');
    voiceBtn.textContent = '⏹';
  } catch {
    alert('Microphone access denied.');
  }
};
</script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTER - COMPLETE VERSION
// ═════════════════════════════════════════════════════════════════════════════
export default {
  async fetch(req, env) {
    // Intercept BUCKET if B2 is configured
    if (env.B2_ACCESS_KEY_ID && env.B2_SECRET_ACCESS_KEY && env.B2_ENDPOINT && env.B2_BUCKET_NAME) {
      env.BUCKET = new B2BucketAdapter(env);
    }

    // Environment validation on first request
    if (!env.__validated) {
      const requiredBindings = ['AI', 'DB', 'KV'];
      const missing = requiredBindings.filter(b => !env[b]);
      if (missing.length) {
        console.error(`Missing bindings: ${missing.join(', ')}`);
      }
      
      if (!env.VECTORIZE) {
        console.warn('⚠️ VECTORIZE not bound - RAG features will be disabled');
      }
      
      if (!env.BUCKET) {
        console.warn('⚠️ BUCKET (R2 or B2) not configured - document storage disabled');
      }
      
      env.__validated = true;
    }
    
    // Initialize multi-AI client
    if (!env.__multiAI) {
      env.__multiAI = new MultiAccountAI(env);
    }
    
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Public UI
    if (method === 'GET' && path === '/') return buildHtml(env);

    // AI Admin (multi-account management)
    if (method === 'GET' && path === '/api/admin/ai/status') return handleAIStatus(req, env);
    if (method === 'POST' && path === '/api/admin/ai/switch') return handleAISwitch(req, env);

    // Chat endpoints
    if (method === 'POST' && path === '/api/chat') return handleChat(req, env);
    if (method === 'POST' && path === '/api/chat/stream') return handleChatStream(req, env);
    if (method === 'POST' && path === '/api/chat/voice') return handleVoiceChat(req, env);
    if (method === 'POST' && path === '/api/chat/ocr') return handleOCRChat(req, env);

    // Conversation history
    if (method === 'GET' && path.startsWith('/api/conversations/')) {
      const sessionId = path.split('/')[3];
      return getConversationHistory(req, env, sessionId);
    }

    // Feedback
    if (method === 'POST' && path === '/api/feedback') return handleFeedback(req, env);

    // KB Search (public)
    if (method === 'POST' && path === '/api/kb/search') return handleKBSearch(req, env);

    // Form submission
    if (method === 'POST' && path === '/api/submit') return handleSubmission(req, env);

    // Telegram webhook
    if (method === 'POST' && path === '/api/telegram/webhook') return handleTelegramWebhook(req, env);

    // KB CRUD (Admin)
    if (method === 'POST' && path === '/api/admin/kb/upload') return handleKBUpload(req, env);
    if (method === 'POST' && path === '/api/admin/kb/bulk-upload') return handleKBBulkUpload(req, env);
    if (method === 'DELETE' && path === '/api/admin/kb/bulk') return handleKBBulkDelete(req, env);
    if (method === 'GET' && path === '/api/admin/kb') return handleKBList(req, env);
    
    // KB single document routes
    if (method === 'GET' && path.match(/^\/api\/admin\/kb\/[^/]+$/)) {
      const docId = path.split('/')[4];
      return handleKBGet(req, env, docId);
    }
    if (method === 'PUT' && path.match(/^\/api\/admin\/kb\/[^/]+$/)) {
      const docId = path.split('/')[4];
      return handleKBUpdate(req, env, docId);
    }
    if (method === 'DELETE' && path.match(/^\/api\/admin\/kb\/[^/]+$/)) {
      const docId = path.split('/')[4];
      return handleKBDelete(req, env, docId);
    }
    if (method === 'POST' && path.match(/^\/api\/admin\/kb\/[^/]+\/restore$/)) {
      const docId = path.split('/')[4];
      return handleKBRestore(req, env, docId);
    }

    // Submissions admin
    if (method === 'GET' && path === '/api/admin/submissions') return handleSubmissionsList(req, env);
    if (method === 'PUT' && path.match(/^\/api\/admin\/submissions\/\d+$/)) {
      const id = path.split('/')[4];
      return handleSubmissionUpdate(req, env, id);
    }

    // Export
    if (method === 'GET' && path === '/api/admin/export/conversations') return handleExportConversations(req, env);

    // Admin conversations list
    if (method === 'GET' && path === '/api/admin/conversations') return handleAdminConversations(req, env);

    // Analytics
    if (method === 'GET' && path === '/api/admin/analytics') return handleAnalytics(req, env);

    // Health checks
    if (path === '/api/health') {
      const multiAI = env.__multiAI;
      const status = await multiAI.healthCheck();
      return json({ ok: true, ts: Date.now(), aiStatus: status, active: multiAI.getActiveAccount().name });
    }
    
    if (path === '/api/health/detailed') return handleDetailedHealth(req, env);

    return new Response('Not Found', { status: 404 });
  },
  
  async scheduled(event, env, ctx) {
    // Cron trigger for cleanup (runs daily at midnight)
    console.log('Running scheduled cleanup...');
    ctx.waitUntil(Promise.resolve());
  }
};