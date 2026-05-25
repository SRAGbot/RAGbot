#!/usr/bin/env node
/**
 * setup-multi-ai.js
 * 
 * Setup script for multi-account AI failover.
 * Creates API tokens and configures accounts.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (q) => new Promise(resolve => rl.question(q, resolve));

async function setup() {
  console.log('🚀 Multi-Account AI Failover Setup\n');
  console.log('This will help you configure 3 Cloudflare accounts for AI redundancy.\n');
  
  const accounts = [];
  
  for (let i = 1; i <= 3; i++) {
    console.log(`\n📡 Account ${i} Configuration:`);
    const accountId = await question(`  Cloudflare Account ID ${i}: `);
    const email = await question(`  Email ${i}: `);
    const apiToken = await question(`  API Token ${i} (create at https://dash.cloudflare.com/profile/api-tokens): `);
    
    accounts.push({ id: i, accountId, email, apiToken });
    
    // Test the token
    console.log(`  Testing token for account ${i}...`);
    try {
      const test = execSync(`curl -s -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" -H "Authorization: Bearer ${apiToken}"`, { encoding: 'utf8' });
      const result = JSON.parse(test);
      if (result.success) {
        console.log(`  ✅ Account ${i} verified!`);
      } else {
        console.log(`  ⚠️  Token verification failed, but continuing...`);
      }
    } catch (e) {
      console.log(`  ⚠️  Could not verify token: ${e.message}`);
    }
  }
  
  // Update .env file
  let envContent = '';
  if (fs.existsSync('.env')) {
    envContent = fs.readFileSync('.env', 'utf8');
  }
  
  // Update or add variables
  const updates = {
    CF_ACCOUNT_ID_1: accounts[0].accountId,
    CF_API_TOKEN_1: accounts[0].apiToken,
    CF_ACCOUNT_ID_2: accounts[1].accountId,
    CF_API_TOKEN_2: accounts[1].apiToken,
    CF_ACCOUNT_ID_3: accounts[2].accountId,
    CF_API_TOKEN_3: accounts[2].apiToken,
  };
  
  for (const [key, value] of Object.entries(updates)) {
    if (envContent.includes(`${key}=`)) {
      envContent = envContent.replace(new RegExp(`${key}=.*`), `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  }
  
  fs.writeFileSync('.env', envContent);
  console.log('\n✅ .env updated with multi-account configuration');
  
  // Push secrets to Cloudflare
  console.log('\n🔐 Pushing secrets to Cloudflare primary account...');
  for (const [key, value] of Object.entries(updates)) {
    try {
      execSync(`echo "${value}" | wrangler secret put ${key}`, { stdio: 'pipe' });
      console.log(`  ✅ ${key} pushed`);
    } catch (e) {
      console.log(`  ⚠️  Could not push ${key}: ${e.message}`);
    }
  }
  
  console.log('\n✅ Multi-account AI setup complete!');
  console.log('\n📊 Architecture:');
  console.log('  • Primary AI: Direct binding (fastest)');
  console.log('  • Fallback 1: API calls to account 2');
  console.log('  • Fallback 2: API calls to account 3');
  console.log('\n  Failover: Automatic on 3 consecutive failures');
  console.log('  Recovery: Manual via /api/admin/ai/switch endpoint\n');
  
  rl.close();
}

setup().catch(console.error);