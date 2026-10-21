import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { systemClock } from './lib/clock.js';
import { makeClassifier, makeMailer, makeTranscriber } from './providers.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const db = openDb(path.join(config.dataDir, 'daytwo.db'));
const app = await buildApp({
  config,
  db,
  clock: systemClock,
  mailer: makeMailer(config),
  transcriber: makeTranscriber(config),
  classifier: makeClassifier(config),
});

const resumed = app.queue.resume();
await app.purgeAll();
const purgeTimer = setInterval(() => void app.purgeAll().catch((err) => app.log.error({ err }, 'purge failed')), 10 * 60_000);
purgeTimer.unref();

await app.listen({ port: config.port, host: config.host });
app.log.info({ resumed, transcriber: config.transcriber }, 'day two server ready');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    app.queue.stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}
