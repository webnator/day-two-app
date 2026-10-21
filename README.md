# Day Two

A personal journaling app for iOS and Android, built with Expo/React Native and a TypeScript backend. Capture text, photos, and audio; keep entries locally; request transcription and assisted classification from configurable providers.

This is a source snapshot of my personal project, built with coding agents under my direction. It is a work in progress, not an app-store release or a hosted service. The private development repository and its operational history remain separate.

## What to explore

- `mobile/src/data` and `mobile/src/services`: local journal storage and synchronization.
- `mobile/src/app`: the mobile interface and user journeys.
- `server/src`: authentication, transcription, classification, and MCP integration.
- `server/test` and `mobile/src/__tests__`: behavior and regression tests.

The backend uses Fastify and SQLite. The app uses Expo Router, SQLite, and platform storage. Transcription and classification have provider adapters; those integrations require your own accounts or local model installations.

## Check locally

Use Node.js 24 and npm.

```sh
cd server
npm ci
npm run typecheck
npm test
```

For mobile unit tests and type checking:

```sh
cd mobile
npm ci
npm run typecheck
npm test
```

## Run

Copy `server/.env.example` to `server/.env`, configure your providers and a development SMTP server, then run `npm run dev` from `server/`. Do not reuse example secrets outside development.

The mobile app's `extra.apiUrl` in `mobile/app.json` defaults to `http://localhost:8787` in this snapshot. For an Android emulator or physical device, set a development server address reachable from that device. There is no public backend provided with this repository.

Run `npm start` in `mobile/` to start Metro. Native modules require an appropriate development build; unit tests are not a substitute for a device build or end-to-end validation.

## Snapshot boundaries

This export omits private deployment/account documentation, development transcripts, screenshot evidence, and provider evaluation corpora. Historical claims about provider quality are therefore not included as verified results here. Integration tests may need separately configured local services.

The development audio fixture is two seconds of generated silence, not a real journal recording. Its purpose is to preserve asset loading, not evaluate transcription quality. Sample journal entries and the example photo are fixtures, not exported user data.

## License and assets

Source code is MIT, see [LICENSE](LICENSE). Tinos retains its bundled font license in `mobile/assets/fonts/OFL-Tinos.txt`. Visual assets are included for this project's interface; the MIT license does not grant rights to third-party trademarks or imply exclusive rights in generated imagery.
