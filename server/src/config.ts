import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  trustProxy: boolean;
  dataDir: string;
  otpPepper: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
    from: string;
  };
  transcriber: 'chirp3' | 'whisper' | 'deepgram' | 'groq';
  classifier: 'gemini' | 'ollama' | 'anthropic';
  whisperBin: string;
  whisperModel: string;
  whisperThreads: number;
  whisperCodeSwitching: boolean;
  ffmpegBin: string;
  ffprobeBin: string;
  transcribeConcurrency: number;
  googleCloudProject?: string;
  speechLocation: string;
  gcsTranscribeBucket?: string;
  /** Chirp 3 languageCodes used when the client sends languageHint=auto. */
  chirpLanguageCodes: string[];
  chirpSegmented: boolean;
  geminiApiKey?: string;
  geminiModel: string;
  geminiThinkingLevel: string;
  deepgramApiKey?: string;
  groqApiKey?: string;
  groqModel: 'whisper-large-v3' | 'whisper-large-v3-turbo';
  anthropicApiKey?: string;
  anthropicModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  nominatimUserAgent: string;
  logLevel: string;
  publicBaseUrl: string;
}

const DEV_PEPPER = 'dev-only-pepper-not-for-production';

function opt(v: string | undefined): string | undefined {
  return v && v.trim() !== '' ? v : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
  const publicUrl = new URL(publicBaseUrl);
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || !['https:', 'http:'].includes(publicUrl.protocol)) throw new Error('Invalid PUBLIC_BASE_URL');
  const pepper = opt(env.OTP_PEPPER) ?? (production ? undefined : DEV_PEPPER);
  if (!pepper || (production && pepper.length < 32)) {
    throw new Error('OTP_PEPPER must be set (>= 32 chars) in production');
  }
  const rawTranscriber = env.TRANSCRIBER ?? 'chirp3';
  const transcriber = (rawTranscriber === 'google' ? 'chirp3' : rawTranscriber) as Config['transcriber'];
  if (!['chirp3', 'whisper', 'deepgram', 'groq'].includes(transcriber)) {
    throw new Error(`Unknown TRANSCRIBER: ${rawTranscriber}`);
  }
  const classifier = (env.CLASSIFIER ?? 'gemini') as Config['classifier'];
  const groqModel = env.GROQ_MODEL ?? 'whisper-large-v3';
  if (!['whisper-large-v3', 'whisper-large-v3-turbo'].includes(groqModel)) throw new Error('Unknown GROQ_MODEL');
  if (!['gemini', 'ollama', 'anthropic'].includes(classifier)) {
    throw new Error(`Unknown CLASSIFIER: ${classifier}`);
  }
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    trustProxy: env.TRUST_PROXY === 'true',
    dataDir: path.resolve(env.DATA_DIR ?? './data'),
    otpPepper: pepper,
    smtp: {
      host: env.SMTP_HOST ?? 'localhost',
      port: Number(env.SMTP_PORT ?? 1025),
      secure: env.SMTP_SECURE === 'true',
      user: opt(env.SMTP_USER),
      pass: opt(env.SMTP_PASS),
      from: env.MAIL_FROM ?? env.SMTP_FROM ?? 'Day Two <no-reply@daytwo.local>',
    },
    transcriber,
    classifier,
    whisperBin: env.WHISPER_BIN ?? '/opt/homebrew/bin/whisper-cli',
    whisperModel: env.WHISPER_MODEL ?? '',
    whisperThreads: Number(env.WHISPER_THREADS ?? 8),
    whisperCodeSwitching: env.WHISPER_CODE_SWITCHING !== 'false',
    ffmpegBin: env.FFMPEG_BIN ?? 'ffmpeg',
    ffprobeBin: env.FFPROBE_BIN ?? 'ffprobe',
    transcribeConcurrency: Math.min(2, Math.max(1, Number(env.TRANSCRIBE_CONCURRENCY ?? 1))),
    googleCloudProject: opt(env.GOOGLE_CLOUD_PROJECT),
    speechLocation: env.SPEECH_LOCATION ?? 'eu',
    gcsTranscribeBucket: opt(env.GCS_TRANSCRIBE_BUCKET),
    chirpLanguageCodes: (env.CHIRP_LANGUAGE_CODES ?? 'es-ES,en-US').split(',').map((s) => s.trim()).filter(Boolean),
    chirpSegmented: env.CHIRP_SEGMENTED !== 'false',
    geminiApiKey: opt(env.GEMINI_API_KEY),
    geminiModel: env.GEMINI_MODEL ?? 'gemini-3.8-flash',
    geminiThinkingLevel: (env.GEMINI_THINKING_LEVEL ?? 'low').toUpperCase(),
    deepgramApiKey: opt(env.DEEPGRAM_API_KEY),
    groqApiKey: opt(env.GROQ_API_KEY),
    groqModel: groqModel as Config['groqModel'],
    anthropicApiKey: opt(env.ANTHROPIC_API_KEY),
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
    ollamaUrl: env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    ollamaModel: env.OLLAMA_MODEL ?? 'qwen3.5:9b',
    nominatimUserAgent:
      env.NOMINATIM_USER_AGENT ?? 'DayTwo/0.1 (personal journaling app; contact via repo owner)',
    logLevel: env.LOG_LEVEL ?? 'info',
    publicBaseUrl,
  };
}
