import fs from 'node:fs';
import { defineConfig } from 'vitest/config';

// Pruebas que tocan servicios reales locales (Mailpit, whisper.cpp). Ver README.
if (fs.existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
