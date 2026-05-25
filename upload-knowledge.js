#!/usr/bin/env node

/**
 * upload-knowledge.js — Knowledge Base Upload Utility
 * 
 * Upload documents to the AI Support Chatbot knowledge base.
 * Supports single files, bulk directories, and sample documents.
 * Reads WORKER_URL and ADMIN_SECRET from .env automatically.
 *
 * Usage:
 *   node upload-knowledge.js              — interactive mode
 *   node upload-knowledge.js --samples    — upload built-in sample docs
 *   node upload-knowledge.js ./faq.txt support
 *   node upload-knowledge.js ./docs/ --category=pricing --tags=billing
 *   node upload-knowledge.js --help
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

// ─── Load .env (no external deps needed) ─────────────────────────────────────
function loadEnv(filePath = '.env') {
  if (!fs.existsSync(filePath)) {
    console.warn('⚠️  .env file not found, using defaults');
    return {};
  }
  
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const env = {};
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    env[key.trim()] = rest.join('=').trim();
  }
  
  return env;
}

const localEnv = loadEnv('.env');

// ─── Configuration ────────────────────────────────────────────────────────────
const WORKER_URL = process.env.WORKER_URL || localEnv.WORKER_URL || 'http://localhost:8787';
const ADMIN_SECRET = process.env.ADMIN_SECRET || localEnv.ADMIN_SECRET || '';
const UPLOAD_ENDPOINT = `${WORKER_URL}/api/admin/kb/upload`;
const BULK_UPLOAD_ENDPOINT = `${WORKER_URL}/api/admin/kb/bulk-upload`;

console.log(`🔗  Worker URL: ${WORKER_URL}`);
console.log(`📤  Upload endpoint: ${UPLOAD_ENDPOINT}`);
if (!ADMIN_SECRET) {
  console.warn('⚠️  ADMIN_SECRET not set — uploads may fail with 401 Unauthorized\n');
} else {
  console.log('✅  Admin secret configured\n');
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────
async function uploadDocument(title, category, content, tags = '') {
  try {
    process.stdout.write(`  Uploading: ${title}... `);

    const response = await fetch(UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Secret': ADMIN_SECRET,
      },
      body: JSON.stringify({ 
        title, 
        category, 
        document: content,
        tags: tags 
      }),
    });

    const result = await response.json();

    if (result.success) {
      console.log(`✅  (${result.chunks} chunks, ID: ${result.docId})`);
      return { success: true, docId: result.docId, chunks: result.chunks };
    } else {
      console.log(`❌  ${result.error}`);
      return { success: false, error: result.error };
    }
  } catch (error) {
    console.log(`❌  ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function uploadFromFile(filePath, category = 'general', tags = '') {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`❌  File not found: ${filePath}`);
      return { success: false, error: 'File not found' };
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const title = path.basename(filePath, path.extname(filePath));
    const stats = fs.statSync(filePath);
    
    console.log(`\n📄  File: ${path.basename(filePath)} (${(stats.size / 1024).toFixed(2)} KB, ${content.length} chars)`);
    
    return await uploadDocument(title, category, content, tags);
  } catch (error) {
    console.error(`❌  Error reading file: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function uploadFromContent(title, content, category = 'general', tags = '') {
  console.log(`\n📝  Document: ${title} (${content.length} chars)`);
  return await uploadDocument(title, category, content, tags);
}

// ─── Sample documents ─────────────────────────────────────────────────────────
const SAMPLE_DOCUMENTS = {
  'faq': {
    title: 'Frequently Asked Questions',
    category: 'faq',
    tags: 'faq,help,quick',
    content: `# Frequently Asked Questions

## General Questions

**Q: What services do you offer?**
A: We offer web development, software development, IT support, cloud consulting, and technical training.

**Q: How can I contact support?**
A: You can contact support through our chat widget, email support@example.com, or call +1 (555) 123-4567.

**Q: What are your business hours?**
A: Monday-Friday, 9 AM - 6 PM EST. Emergency support available 24/7 for enterprise clients.

## Technical Support

**Q: How do I schedule a remote support session?**
A: Click the "Quick Support" button in the chat widget. We support AnyDesk, TeamViewer, Zoom, and Google Meet.

**Q: What information should I provide?**
A: Your operating system, browser version, error messages, screenshots, and steps to reproduce the issue.

**Q: How long does support take?**
A: Initial response within 1-2 hours during business hours. Most issues resolved within 24 hours.

## Pricing

**Q: How much does support cost?**
A: Hourly rates: $50-75/hour. Monthly plans: Basic $200/mo (5 hours), Professional $500/mo (15 hours).

**Q: Do you offer free consultations?**
A: Yes, initial 30-minute consultation is free.

**Q: What payment methods do you accept?**
A: Credit cards, PayPal, bank transfer, and net-30 terms for businesses.

## Technical Requirements

**Q: What are the system requirements?**
A: Windows 10+, macOS 10.14+, or Linux. 4GB RAM minimum, 5 Mbps internet, modern browser.

**Q: Do I need to install software?**
A: For remote support, you need AnyDesk or TeamViewer. For web services, nothing to install.

## Security

**Q: Is my data secure?**
A: Yes, we use encryption, secure connections, and follow industry best practices.

**Q: Do you comply with GDPR?**
A: Yes, we are fully GDPR compliant.`
  },

  'pricing': {
    title: 'Pricing Plans',
    category: 'pricing',
    tags: 'pricing,billing,plans',
    content: `# Pricing Plans

## Hourly Support
- **Rate:** $50-75 per hour
- **Minimum:** 1 hour
- **Response time:** Within 2 hours
- **Best for:** One-time fixes, consultations

## Monthly Plans

### Basic Plan — $200/month
- 5 hours of support
- Email and chat support
- Response within 4 hours
- No rollover hours

### Professional Plan — $500/month
- 15 hours of support
- Phone, email, chat support
- Response within 2 hours
- Quarterly system health check
- Up to 5 hours rollover

### Enterprise Plan — Custom pricing
- Unlimited support hours
- Dedicated support representative
- 24/7 emergency support
- On-site support available
- Custom SLA agreements

## Project-Based Pricing

| Project Size | Price Range |
|-------------|-------------|
| Small | $500 - $2,000 |
| Medium | $2,000 - $10,000 |
| Large | $10,000+ |

## Payment Terms
- 50% upfront for new projects
- Net 30 for monthly plans
- Major credit cards accepted
- PayPal and bank transfer available

## Money-Back Guarantee
If you're not satisfied in the first month, we'll provide a full refund, no questions asked.`
  },

  'services': {
    title: 'Our Services',
    category: 'services',
    tags: 'services,offerings,solutions',
    content: `# Our Services

## Web Development
- Custom website design and development
- E-commerce solutions (Shopify, WooCommerce)
- Content Management Systems (WordPress, Drupal)
- Progressive Web Apps (PWA)
- Website maintenance and optimization

## Software Development
- Custom software solutions
- Desktop and mobile applications
- API development and integration
- Database design and optimization
- Legacy system modernization

## IT Support & Consulting
- Remote technical support
- System troubleshooting
- Network setup and configuration
- Cloud migration (AWS, Azure, GCP)
- IT infrastructure consulting
- Cybersecurity assessments

## Digital Solutions
- Digital transformation consulting
- Automation and workflow optimization
- Business process improvement
- DevOps implementation
- CI/CD pipeline setup

## Training & Workshops
- Technical training sessions
- Software tutorials and workshops
- Best practices training
- Team skill development

## Why Choose Us?
✓ 10+ years of experience
✓ Quick response times
✓ Flexible support options
✓ Competitive pricing
✓ Client-focused approach
✓ Ongoing support and maintenance`
  },

  'technical-requirements': {
    title: 'Technical Requirements',
    category: 'technical',
    tags: 'requirements,system,compatibility',
    content: `# Technical Requirements

## For Remote Support Sessions

### Minimum System Requirements
- **Operating System:** Windows 10+, macOS 10.14+, or modern Linux
- **RAM:** 4GB minimum, 8GB recommended
- **Internet:** Stable connection, 5 Mbps or higher
- **Screen Resolution:** 1280x720 minimum

### Supported Remote Software
- AnyDesk (recommended) - lightweight, fast
- TeamViewer - feature-rich
- UltraViewer - secure, easy to use
- Zoom - includes screen sharing
- Google Meet - browser-based

### Supported Browsers
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## For Web Development Projects

### Server Requirements
- Linux server (Ubuntu 20.04+ or CentOS 8+)
- PHP 7.4+ or Node.js 14+
- MySQL 8.0+ or PostgreSQL 12+
- Apache 2.4+ or Nginx 1.18+
- SSL certificate (Let's Encrypt supported)

### Recommended Stack
- **Frontend:** React, Vue.js, or Angular
- **Backend:** Node.js, Python, or PHP
- **Database:** PostgreSQL or MySQL
- **Hosting:** AWS, DigitalOcean, or Vercel

## Security Requirements
- HTTPS/SSL mandatory
- Regular security updates
- Firewall configuration
- Backup solutions (daily recommended)
- DDoS protection

## Pre-Session Checklist
- [ ] Install chosen remote support software
- [ ] Test internet connection
- [ ] Close unnecessary applications
- [ ] Have admin password ready
- [ ] Note any error messages
- [ ] Take screenshots if possible`
  },

  'contact': {
    title: 'Contact Information',
    category: 'support',
    tags: 'contact,email,phone',
    content: `# Contact Information

## Support Channels

### Live Chat
Use the chat widget on our website for immediate assistance.

### Email Support
- **General Inquiries:** hello@example.com
- **Technical Support:** support@example.com
- **Billing:** billing@example.com
- **Sales:** sales@example.com

### Phone Support
- **Main Line:** +1 (555) 123-4567
- **Support Hotline:** +1 (555) 123-4568
- **Emergency:** +1 (555) 123-4569 (24/7)

### Social Media
- **Twitter:** @example
- **LinkedIn:** /company/example
- **GitHub:** /example

## Office Hours
- **Monday-Friday:** 9:00 AM - 6:00 PM EST
- **Saturday:** 10:00 AM - 2:00 PM EST
- **Sunday:** Closed

## Emergency Support
Available 24/7 for enterprise clients. Call the emergency hotline.

## Response Times
- **Chat:** Within 5 minutes
- **Email:** Within 2 hours
- **Phone:** Immediate during business hours
- **Emergency:** Within 30 minutes

## Location
123 Main Street, Suite 100
New York, NY 10001
United States`
  }
};

// ─── Sample documents upload ──────────────────────────────────────────────────
async function uploadSampleDocuments() {
  console.log('📚  Uploading sample knowledge base documents...\n');
  console.log('─'.repeat(50));

  let success = 0;
  let failed = 0;
  const results = [];

  for (const [key, doc] of Object.entries(SAMPLE_DOCUMENTS)) {
    console.log(`\n📄  ${doc.title} (${doc.category})`);
    const result = await uploadDocument(doc.title, doc.category, doc.content, doc.tags);
    
    if (result.success) {
      success++;
      results.push({ title: doc.title, status: 'success', docId: result.docId });
    } else {
      failed++;
      results.push({ title: doc.title, status: 'failed', error: result.error });
    }
    
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n' + '═'.repeat(50));
  console.log('\n📊  Upload Summary:');
  console.log(`    ✅  Successful: ${success}`);
  console.log(`    ❌  Failed: ${failed}`);
  console.log(`    📦  Total: ${success + failed}`);
  
  if (results.length > 0) {
    console.log('\n📋  Details:');
    for (const r of results) {
      const icon = r.status === 'success' ? '✅' : '❌';
      console.log(`    ${icon} ${r.title}${r.docId ? ` (${r.docId.slice(0, 8)}...)` : ''}${r.error ? ': ' + r.error : ''}`);
    }
  }
}

// ─── Bulk upload from directory ───────────────────────────────────────────────
async function bulkUploadFromDirectory(dirPath, category = 'general', tags = '') {
  if (!fs.existsSync(dirPath)) {
    console.error(`❌  Directory not found: ${dirPath}`);
    return { success: 0, failed: 0 };
  }

  const files = fs.readdirSync(dirPath)
    .filter(f => /\.(txt|md|markdown|text|rst)$/i.test(f))
    .map(f => path.join(dirPath, f));

  if (files.length === 0) {
    console.error(`❌  No text files found in ${dirPath}`);
    return { success: 0, failed: 0 };
  }

  console.log(`\n📦  Found ${files.length} text files in ${dirPath}\n`);
  console.log('─'.repeat(50));

  let success = 0;
  let failed = 0;

  for (const filePath of files) {
    const result = await uploadFromFile(filePath, category, tags);
    if (result.success) {
      success++;
    } else {
      failed++;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n' + '═'.repeat(50));
  console.log(`\n📊  Bulk Upload Complete:`);
  console.log(`    ✅  Successful: ${success}`);
  console.log(`    ❌  Failed: ${failed}`);
  console.log(`    📦  Total: ${files.length}`);

  return { success, failed, total: files.length };
}

// ─── Interactive mode ─────────────────────────────────────────────────────────
async function interactiveMode() {
  const rl = readline.createInterface({ 
    input: process.stdin, 
    output: process.stdout 
  });
  
  const question = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log('\n🤖  Interactive Knowledge Base Upload\n');
  console.log('═'.repeat(50));

  const choice = await question(`
Choose an option:

  1. Upload sample documents (recommended for testing)
  2. Upload a single file
  3. Upload all .txt/.md files in a directory (bulk upload)
  4. Upload from URL (coming soon)
  5. Exit

Enter choice (1-5): `);

  if (choice === '1') {
    await uploadSampleDocuments();
  } 
  else if (choice === '2') {
    const filePath = await question('\n📁  File path: ');
    const category = (await question('📂  Category [general]: ')) || 'general';
    const tags = await question('🏷️   Tags (comma-separated, optional): ');
    
    await uploadFromFile(filePath.trim(), category.trim(), tags.trim());
  } 
  else if (choice === '3') {
    const dirPath = await question('\n📁  Directory path: ');
    const category = (await question('📂  Category [general]: ')) || 'general';
    const tags = await question('🏷️   Tags (comma-separated, optional): ');
    
    await bulkUploadFromDirectory(dirPath.trim(), category.trim(), tags.trim());
  }
  else if (choice === '4') {
    console.log('\n⏳  URL upload coming soon. Please upload files from disk for now.');
  }
  else if (choice === '5') {
    console.log('\n👋  Goodbye!');
  }
  else {
    console.log('\n❌  Invalid choice. Please run again.');
  }

  rl.close();
}

// ─── Validate worker connectivity ─────────────────────────────────────────────
async function validateWorker() {
  try {
    const response = await fetch(`${WORKER_URL}/api/health`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅  Worker is healthy');
      return true;
    } else {
      console.error(`❌  Worker returned status ${response.status}`);
      return false;
    }
  } catch (error) {
    console.error(`❌  Cannot reach worker at ${WORKER_URL}: ${error.message}`);
    console.error('\n💡  Make sure:');
    console.error('   1. Worker is deployed: wrangler deploy');
    console.error('   2. WORKER_URL is correct in .env');
    console.error('   3. Worker is running: wrangler dev (for local)');
    return false;
  }
}

// ─── Show help ────────────────────────────────────────────────────────────────
function showHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║                    Knowledge Base Upload Utility                           ║
╚════════════════════════════════════════════════════════════════════════════╝

Usage:
  node upload-knowledge.js [options] [file-path] [category]

Options:
  -i, --interactive    Interactive mode (default)
  -s, --samples        Upload built-in sample documents
  -b, --bulk <dir>     Upload all text files from directory
  -c, --category <cat> Set category for upload (default: general)
  -t, --tags <tags>    Comma-separated tags (e.g., "faq,pricing")
  -h, --help           Show this help
  -v, --validate       Validate worker connectivity

Examples:
  # Upload sample documents
  node upload-knowledge.js --samples

  # Upload a single file
  node upload-knowledge.js ./docs/faq.txt support

  # Upload with tags
  node upload-knowledge.js ./docs/pricing.md pricing --tags=billing,plans

  # Bulk upload a directory
  node upload-knowledge.js --bulk ./docs/ --category=general

  # Interactive mode
  node upload-knowledge.js --interactive

  # Validate worker
  node upload-knowledge.js --validate

Config (.env):
  WORKER_URL     Deployed worker URL (default: http://localhost:8787)
  ADMIN_SECRET   Admin secret key for authentication

Environment Variables:
  WORKER_URL     Override .env value
  ADMIN_SECRET   Override .env value

Exit Codes:
  0 - Success
  1 - Error (failed uploads, connection issues)
  2 - Invalid arguments

Examples with environment variables:
  WORKER_URL=https://my-worker.workers.dev ADMIN_SECRET=secret node upload-knowledge.js --samples
`);
}

// ─── Main entry point ────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  
  // Parse arguments
  const options = {
    interactive: false,
    samples: false,
    bulk: null,
    category: 'general',
    tags: '',
    validate: false,
    help: false,
    filePath: null,
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '-i':
      case '--interactive':
        options.interactive = true;
        break;
      case '-s':
      case '--samples':
        options.samples = true;
        break;
      case '-b':
      case '--bulk':
        options.bulk = args[++i];
        break;
      case '-c':
      case '--category':
        options.category = args[++i];
        break;
      case '-t':
      case '--tags':
        options.tags = args[++i];
        break;
      case '-v':
      case '--validate':
        options.validate = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        if (!arg.startsWith('-')) {
          options.filePath = arg;
        }
        break;
    }
  }
  
  // Show help
  if (options.help) {
    showHelp();
    process.exit(0);
  }
  
  // Validate worker
  if (options.validate) {
    const isValid = await validateWorker();
    process.exit(isValid ? 0 : 1);
  }
  
  // Validate admin secret
  if (!ADMIN_SECRET && !options.validate) {
    console.error('❌  ADMIN_SECRET not set in .env or environment variables');
    console.error('\n💡  Set ADMIN_SECRET in .env file or environment variable');
    console.error('    echo "ADMIN_SECRET=your-secret-here" >> .env\n');
    process.exit(1);
  }
  
  // Execute commands
  try {
    if (options.samples) {
      await validateWorker();
      await uploadSampleDocuments();
    } 
    else if (options.bulk) {
      await validateWorker();
      await bulkUploadFromDirectory(options.bulk, options.category, options.tags);
    }
    else if (options.filePath) {
      await validateWorker();
      await uploadFromFile(options.filePath, options.category, options.tags);
    }
    else if (options.interactive) {
      await validateWorker();
      await interactiveMode();
    }
    else {
      // Default to interactive if no options
      await validateWorker();
      await interactiveMode();
    }
    
    console.log('\n✨  Done!\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌  Fatal error:', error.message);
    process.exit(1);
  }
}

// Run the main function
main().catch(error => {
  console.error('❌  Unhandled error:', error);
  process.exit(1);
});