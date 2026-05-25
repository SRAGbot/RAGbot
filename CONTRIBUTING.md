# Contributing Guide

## Development Setup

1. Clone the repository
2. Copy `.env.example` to `.env` and fill in values
3. Run `npm install` (if using package.json)
4. Run `node setup.js` to configure
5. Run `wrangler dev` for local development

## Code Style

- Use 2 spaces for indentation
- Add JSDoc comments for functions
- Keep functions small and focused
- Use async/await over promises

## Testing

```bash
# Run API tests
node test-api.js

# Test KB upload
node upload-knowledge.js --samples

# Test admin CLI
node kb-admin.js list