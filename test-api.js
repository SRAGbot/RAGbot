#!/usr/bin/env node
/**
 * test-api.js — API Testing Utility
 * Tests all critical endpoints of the deployed worker
 */

const fs = require('fs');

// Load .env
function loadEnv() {
  if (!fs.existsSync('.env')) return {};
  const lines = fs.readFileSync('.env', 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    env[key.trim()] = rest.join('=').trim();
  }
  return env;
}

const env = loadEnv();
const BASE_URL = process.env.WORKER_URL || env.WORKER_URL || 'http://localhost:8787';
const ADMIN_SECRET = process.env.ADMIN_SECRET || env.ADMIN_SECRET || '';

async function testEndpoint(name, url, options = {}) {
  process.stdout.write(`Testing ${name}... `);
  try {
    const res = await fetch(`${BASE_URL}${url}`, options);
    const data = await res.json().catch(() => ({ status: res.status }));
    if (res.ok) {
      console.log(`✅ ${res.status}`);
      return { success: true, data };
    } else {
      console.log(`❌ ${res.status}: ${data.error || 'Unknown error'}`);
      return { success: false, error: data.error };
    }
  } catch (error) {
    console.log(`❌ ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function runTests() {
  console.log('\n🧪 API Testing Suite\n');
  console.log(`📍 Base URL: ${BASE_URL}\n`);
  console.log('═'.repeat(50));

  const results = [];

  // 1. Health check
  results.push(await testEndpoint('Health Check', '/api/health'));

  // 2. Chat endpoint (requires message)
  results.push(await testEndpoint('Chat (test message)', '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Hello, this is a test' })
  }));

  // 3. KB Search (public)
  results.push(await testEndpoint('KB Search', '/api/kb/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'pricing', topK: 3 })
  }));

  // 4. Admin endpoints (if ADMIN_SECRET is set)
  if (ADMIN_SECRET) {
    results.push(await testEndpoint('Admin Analytics', '/api/admin/analytics', {
      headers: { 'X-Admin-Secret': ADMIN_SECRET }
    }));

    results.push(await testEndpoint('Admin KB List', '/api/admin/kb', {
      headers: { 'X-Admin-Secret': ADMIN_SECRET }
    }));

    results.push(await testEndpoint('AI Status', '/api/admin/ai/status', {
      headers: { 'X-Admin-Secret': ADMIN_SECRET }
    }));
  } else {
    console.log('\n⚠️  ADMIN_SECRET not set - skipping admin tests\n');
  }

  // Summary
  console.log('\n' + '═'.repeat(50));
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(console.error);