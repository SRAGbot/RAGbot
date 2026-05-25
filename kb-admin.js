#!/usr/bin/env node
/**
 * kb-admin.js — Knowledge Base Admin CLI
 *
 * Full CRUD for KB articles from the terminal.
 * Reads WORKER_URL and ADMIN_SECRET from .env
 *
 * Usage:
 *   node kb-admin.js list [--category=X] [--status=archived]
 *   node kb-admin.js get <docId>
 *   node kb-admin.js upload <file> [category] [--tags=tag1,tag2]
 *   node kb-admin.js upload-samples
 *   node kb-admin.js bulk <directory> [category]
 *   node kb-admin.js update <docId> [--title=X] [--file=path] [--category=X]
 *   node kb-admin.js delete <docId>
 *   node kb-admin.js restore <docId>
 *   node kb-admin.js search <query>
 *   node kb-admin.js stats
 */

const fs   = require('fs');
const path = require('path');

// ─── Load .env ────────────────────────────────────────────────────────────────
function loadEnv() {
  if (!fs.existsSync('.env')) return {};
  return Object.fromEntries(
    fs.readFileSync('.env', 'utf8').split('\n')
      .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
      .map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim()]; })
  );
}

const env     = loadEnv();
const BASE    = process.env.WORKER_URL   || env.WORKER_URL   || 'http://localhost:8787';
const SECRET  = process.env.ADMIN_SECRET || env.ADMIN_SECRET || '';

if (!SECRET) {
  console.warn('⚠️  ADMIN_SECRET not set in .env — admin endpoints will return 401\n');
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type':   'application/json',
      'X-Admin-Secret': SECRET,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  return data;
}

async function publicApi(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  return data;
}

// ─── Parse CLI flags ──────────────────────────────────────────────────────────
function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [k, ...v] = arg.slice(2).split('=');
      flags[k] = v.join('=') || true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdList({ flags }) {
  const params = new URLSearchParams();
  if (flags.category) params.set('category', flags.category);
  if (flags.status)   params.set('status', flags.status);
  if (flags.limit)    params.set('limit', flags.limit);

  const data = await api('GET', `/api/admin/kb?${params}`);
  if (!data.success) return console.error('❌', data.error);

  console.log(`\n📚 Knowledge Base Documents (${data.total} total)\n`);
  console.log('─'.repeat(80));

  if (!data.documents.length) {
    console.log('  No documents found.');
    return;
  }

  for (const doc of data.documents) {
    const status = doc.status === 'active' ? '🟢' : '🔴';
    console.log(`${status} ${doc.title}`);
    console.log(`   ID: ${doc.doc_id}  |  Category: ${doc.category}  |  Chunks: ${doc.chunk_count}`);
    if (doc.content_preview) console.log(`   Preview: ${doc.content_preview.slice(0, 80)}…`);
    console.log(`   Uploaded: ${new Date(doc.uploaded_at).toLocaleString()}`);
    console.log();
  }
}

async function cmdGet({ positional }) {
  const docId = positional[0];
  if (!docId) return console.error('Usage: node kb-admin.js get <docId>');

  const data = await api('GET', `/api/admin/kb/${docId}`);
  if (!data.success) return console.error('❌', data.error);

  const doc = data.document;
  console.log(`\n📄 ${doc.title}`);
  console.log('─'.repeat(60));
  console.log(`ID       : ${doc.doc_id}`);
  console.log(`Category : ${doc.category}`);
  console.log(`Status   : ${doc.status}`);
  console.log(`Chunks   : ${doc.chunk_count}`);
  console.log(`Uploaded : ${new Date(doc.uploaded_at).toLocaleString()}`);
  if (doc.last_modified) console.log(`Modified : ${new Date(doc.last_modified).toLocaleString()}`);
  if (data.content) {
    console.log(`\nContent (${data.content.length} chars):`);
    console.log('─'.repeat(60));
    console.log(data.content.slice(0, 800));
    if (data.content.length > 800) console.log('\n… (truncated, use --full flag to see all)');
  }
}

async function cmdUpload({ positional, flags }) {
  const filePath = positional[0];
  if (!filePath) return console.error('Usage: node kb-admin.js upload <file> [category]');
  if (!fs.existsSync(filePath)) return console.error(`❌ File not found: ${filePath}`);

  const content  = fs.readFileSync(filePath, 'utf8');
  const title    = flags.title    || path.basename(filePath, path.extname(filePath));
  const category = positional[1]  || flags.category || 'general';
  const tags     = flags.tags     || '';

  console.log(`\n📤 Uploading: ${title} (${content.length} chars)…`);

  const data = await api('POST', '/api/admin/kb/upload', { title, category, document: content, tags });
  if (!data.success) return console.error('❌', data.error);

  console.log(`✅ Uploaded! Doc ID: ${data.docId}  |  Chunks: ${data.chunks}`);
}

async function cmdUpdate({ positional, flags }) {
  const docId = positional[0];
  if (!docId) return console.error('Usage: node kb-admin.js update <docId> [--title=X] [--file=path] [--category=X]');

  const body = {};
  if (flags.title)    body.title    = flags.title;
  if (flags.category) body.category = flags.category;
  if (flags.tags)     body.tags     = flags.tags;
  if (flags.file) {
    if (!fs.existsSync(flags.file)) return console.error(`❌ File not found: ${flags.file}`);
    body.document = fs.readFileSync(flags.file, 'utf8');
    console.log(`📝 Replacing content from: ${flags.file}`);
  }

  if (!Object.keys(body).length) return console.error('❌ Provide at least one of --title, --category, --file');

  console.log(`\n🔄 Updating ${docId}…`);
  const data = await api('PUT', `/api/admin/kb/${docId}`, body);
  if (!data.success) return console.error('❌', data.error);

  console.log(`✅ Updated: ${data.title} (${data.category})`);
}

async function cmdDelete({ positional }) {
  const docId = positional[0];
  if (!docId) return console.error('Usage: node kb-admin.js delete <docId>');

  // Confirm
  const { createInterface } = require('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(res => rl.question(`⚠️  Archive "${docId}"? This removes it from the knowledge base. (y/N): `, ans => {
    rl.close();
    if (ans.toLowerCase() !== 'y') { console.log('Cancelled.'); process.exit(0); }
    res();
  }));

  const data = await api('DELETE', `/api/admin/kb/${docId}`);
  if (!data.success) return console.error('❌', data.error);
  console.log(`✅ Archived. Use "restore ${docId}" to bring it back.`);
}

async function cmdRestore({ positional }) {
  const docId = positional[0];
  if (!docId) return console.error('Usage: node kb-admin.js restore <docId>');

  console.log(`\n🔄 Restoring ${docId}…`);
  const data = await api('POST', `/api/admin/kb/${docId}/restore`);
  if (!data.success) return console.error('❌', data.error);
  console.log(`✅ Restored and re-vectorized.`);
}

async function cmdBulk({ positional, flags }) {
  const dirPath = positional[0];
  if (!dirPath) return console.error('Usage: node kb-admin.js bulk <directory> [category]');

  const category = positional[1] || flags.category || 'general';
  const files    = fs.readdirSync(dirPath).filter(f => /\.(txt|md|text)$/i.test(f));

  console.log(`\n📦 Bulk uploading ${files.length} files from ${dirPath}…\n`);

  const documents = files.map(f => ({
    title:    path.basename(f, path.extname(f)),
    category,
    document: fs.readFileSync(path.join(dirPath, f), 'utf8'),
  }));

  const data = await api('POST', '/api/admin/kb/bulk-upload', { documents });
  if (!data.success) return console.error('❌', data.error);

  console.log(`\n📊 Bulk Upload Results:`);
  for (const r of data.results) {
    const icon = r.success ? '✅' : '❌';
    console.log(`  ${icon} ${r.title}${r.chunks ? ` (${r.chunks} chunks)` : ''}${r.error ? ': ' + r.error : ''}`);
  }
  console.log(`\n  Succeeded: ${data.succeeded}  |  Failed: ${data.failed}`);
}

async function cmdSearch({ positional }) {
  const query = positional.join(' ');
  if (!query) return console.error('Usage: node kb-admin.js search <query>');
  
  console.log(`\n🔍 Searching for: "${query}"\n`);
  
  const data = await publicApi('POST', '/api/kb/search', { query, topK: 10 });
  if (!data.success) return console.error('❌', data.error);
  
  if (!data.results || data.results.length === 0) {
    console.log('  No results found.');
    return;
  }
  
  console.log('─'.repeat(60));
  for (const r of data.results) {
    console.log(`\n📌 Score: ${(r.score * 100).toFixed(1)}%`);
    console.log(`   Source: ${r.title || 'Unknown'} (${r.category || 'general'})`);
    console.log(`   Text: ${r.text?.slice(0, 200)}${r.text?.length > 200 ? '…' : ''}`);
  }
}

async function cmdStats() {
  const data = await api('GET', '/api/admin/analytics');
  if (!data.success) return console.error('❌', data.error);

  console.log('\n📊 Analytics Summary\n' + '─'.repeat(40));
  console.log(`Conversations : ${data.conversations?.total || 0}`);
  console.log(`Sessions      : ${data.conversations?.sessions || 0}`);
  console.log(`Avg Rating    : ${data.feedback?.avg_rating?.toFixed(1) || 'N/A'}`);
  console.log(`\nInput Types:`);
  for (const i of (data.inputTypes || [])) {
    console.log(`  ${i.input_type.padEnd(10)} ${i.count}`);
  }
  console.log(`\nTop Intents:`);
  for (const i of (data.topIntents || [])) {
    console.log(`  ${i.intent.padEnd(15)} ${i.count}`);
  }
  console.log(`\nKB Search:`);
  console.log(`  Total searches: ${data.kbSearch?.total_searches || 0}`);
  console.log(`  Avg score: ${(data.kbSearch?.avg_score * 100).toFixed(1)}%`);
}

async function cmdUploadSamples() {
  console.log('\n📚 Uploading built-in samples via API…\n');
  const { execSync } = require('child_process');
  try {
    execSync(`WORKER_URL=${BASE} node upload-knowledge.js --samples`, { stdio: 'inherit' });
  } catch {
    console.log('Run: node upload-knowledge.js --samples');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const [,, command, ...rest] = process.argv;
  const parsed = parseArgs(rest);

  console.log(`🔗 Worker: ${BASE}`);

  const commands = {
    list:           cmdList,
    get:            cmdGet,
    upload:         cmdUpload,
    'upload-samples': cmdUploadSamples,
    bulk:           cmdBulk,
    update:         cmdUpdate,
    delete:         cmdDelete,
    restore:        cmdRestore,
    search:         cmdSearch,
    stats:          cmdStats,
  };

  if (!command || command === '--help' || command === '-h') {
    console.log(`
KB Admin CLI

Commands:
  list [--category=X] [--status=archived] [--limit=N]
  get <docId>
  upload <file> [category] [--title=X] [--tags=a,b]
  upload-samples
  bulk <directory> [category]
  update <docId> [--title=X] [--file=path] [--category=X]
  delete <docId>
  restore <docId>
  search <query>
  stats

Config (.env):
  WORKER_URL     Deployed worker URL
  ADMIN_SECRET   Admin secret key
`);
    return;
  }

  const handler = commands[command];
  if (!handler) return console.error(`❌ Unknown command: ${command}\nRun --help for usage.`);

  await handler(parsed).catch(e => console.error('❌ Error:', e.message));
})();