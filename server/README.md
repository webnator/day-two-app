# Day Two backend

TypeScript, Fastify, and SQLite backend for email-code authentication, transcription jobs, assisted classification, and MCP tools.

## Local setup

Use Node.js 24, npm, and ffmpeg/ffprobe on your PATH. Copy `.env.example` to `.env` and configure your own provider credentials. For local email delivery, `docker compose up -d` starts Mailpit if Docker is available; inspect the compose file before starting it.

```sh
npm ci
npm run typecheck
npm test
npm run dev
```

`npm test` uses test doubles for provider interactions. `npm run test:integration` requires the local services described by its test files and is not part of the basic check.

The server defaults to port 8787. Set a unique `OTP_PEPPER` before using it outside development. Provider selections and optional adapters are documented in `.env.example`; unavailable credentials do not produce real transcriptions or classifications.

This public snapshot has no hosted backend, production deployment instructions, private account identifiers, or original evaluation corpus. See the root README for scope and limitations.
