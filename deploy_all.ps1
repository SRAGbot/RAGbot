# deploy_all.ps1
# This script automates pushing to GitHub, setting GitHub secrets, 
# creating Cloudflare resources, and deploying the bot.

$ErrorActionPreference = "Stop"

Write-Host "🚀 Starting Deployment Process..." -ForegroundColor Cyan

# 1. Push to GitHub
Write-Host "`n[1/4] Pushing code to GitHub repo: https://github.com/SRAGbot/RAGbot" -ForegroundColor Yellow
if (-not (Test-Path ".git")) {
    git init
    git branch -M main
}
git remote remove origin 2>$null
git remote add origin "https://github.com/SRAGbot/RAGbot.git"
git add .
git commit -m "Initial commit and configuration for RAGbot"
git push -u origin main
Write-Host "✅ Code pushed successfully." -ForegroundColor Green

# 2. Add .env data to GitHub secrets
Write-Host "`n[2/4] Adding .env variables to GitHub Secrets..." -ForegroundColor Yellow
if (Test-Path ".env") {
    $envContent = Get-Content .env
    foreach ($line in $envContent) {
        $line = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { continue }
        
        $parts = $line -split '=', 2
        if ($parts.Length -eq 2) {
            $key = $parts[0].Trim()
            $value = $parts[1].Trim()
            
            # Use gh cli to set secret
            Write-Host "Setting secret: $key"
            $value | gh secret set $key --repo "SRAGbot/RAGbot"
        }
    }
    Write-Host "✅ GitHub Secrets updated." -ForegroundColor Green
} else {
    Write-Host "⚠️ .env file not found. Skipping secrets." -ForegroundColor Yellow
}

# 3. Create Cloudflare Resources
Write-Host "`n[3/4] Creating Cloudflare Resources..." -ForegroundColor Yellow

# Create D1 Database (ignores error if already exists)
Write-Host "Creating D1 Database 'support-db'..."
$d1Output = npx wrangler d1 create support-db 2>&1
Write-Host $d1Output

# Create KV Namespace
Write-Host "Creating KV Namespace 'SESSIONS'..."
$kvOutput = npx wrangler kv:namespace create SESSIONS 2>&1
Write-Host $kvOutput

# Create Vectorize Index
Write-Host "Creating Vectorize Index 'support-knowledge-base'..."
$vecOutput = npx wrangler vectorize create support-knowledge-base --dimensions=768 --metric=cosine 2>&1
Write-Host $vecOutput

# 4. Deploy Bot
Write-Host "`n[4/4] Deploying Bot to Cloudflare Workers..." -ForegroundColor Yellow
npx wrangler deploy
Write-Host "✅ Bot deployed successfully!" -ForegroundColor Green

Write-Host "`n🎉 All tasks completed successfully. Your bot should now be fully interconnected and running." -ForegroundColor Cyan
