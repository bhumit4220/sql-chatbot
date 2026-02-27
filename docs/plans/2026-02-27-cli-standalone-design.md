# CLI Standalone Mode Design

**Date:** 2026-02-27
**Status:** Approved

## Goal

Add a CLI to `sql-chatbot-agent` so users can run `npx sql-chatbot-agent` without writing any Express boilerplate. One command to start the chatbot server.

## Usage

```bash
# With flags
npx sql-chatbot-agent --db postgresql://localhost/mydb --key gsk_xxx --code ./app

# With config file
npx sql-chatbot-agent

# Init scaffolding
npx sql-chatbot-agent init
```

## Config Priority (highest wins)

1. CLI flags
2. Environment variables
3. `chatbot.config.json` in current directory

## `chatbot.config.json` Format

```json
{
  "databaseUrl": "postgresql://localhost/mydb",
  "groqApiKey": "gsk_xxx",
  "codePaths": ["./app"],
  "port": 4000,
  "secret": "my-random-secret"
}
```

## CLI Flags

| Flag | Env var | Default |
|------|---------|---------|
| `--db` | `DATABASE_URL` | required |
| `--key` | `GROQ_API_KEY` | required |
| `--code` | — | `["./src"]` |
| `--port` / `-p` | `PORT` | `3456` |
| `--secret` | `CHATBOT_SECRET` | optional (warns if missing) |

## Authentication

- New config field: `secret` (optional in dev, recommended for production)
- Server sets secret as a cookie when serving `widget.js`
- Validates secret on `/api/ask` and `/api/refresh` endpoints
- Requests without valid secret get `401 Unauthorized`
- If no secret provided: works without auth but prints a warning

## `npx sql-chatbot-agent init`

- Creates `chatbot.config.json` with placeholder values
- Appends `chatbot.config.json` to `.gitignore` automatically

## Server Behavior

- Creates Express app with CORS
- Mounts `sqlChatbot()` at `/chatbot`
- Serves a test page at `/` with the widget script tag
- Prints startup info (URL, health endpoint, auth status)

## Files Changed

- **New:** `src/cli.ts` — CLI entry point (~80 lines)
- **Edit:** `package.json` — add `"bin"` field, add to `"files"`
- **Edit:** `src/middleware.ts` — add secret/cookie auth
- **Edit:** `packages/agent/README.md` — CLI docs, config file, .gitignore note, auth setup

## No New Dependencies

Uses Node.js built-in `util.parseArgs` (available since Node 18).
