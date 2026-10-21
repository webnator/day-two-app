import path from 'node:path';
import { AnthropicClassifier } from './classify/anthropic.js';
import type { Classifier } from './classify/classifier.js';
import { GeminiClassifier } from './classify/gemini.js';
import { OllamaClassifier } from './classify/ollama.js';
import type { Config } from './config.js';
import { NotConfiguredError } from './lib/errors.js';
import { GoogleChirp3Transcriber } from './transcription/chirp3.js';
import { DeepgramTranscriber } from './transcription/cloud.js';
import { GroqTranscriber } from './transcription/groq.js';
import type { Transcriber } from './transcription/transcriber.js';
import { WhisperCppTranscriber } from './transcription/whisperCpp.js';
import { SmtpMailer, type Mailer } from './mail/mailer.js';

export function makeMailer(cfg: Config): Mailer {
  return new SmtpMailer(cfg.smtp);
}

export function makeTranscriber(cfg: Config): Transcriber {
  switch (cfg.transcriber) {
    case 'groq':
      return new GroqTranscriber({ apiKey: cfg.groqApiKey, model: cfg.groqModel,
        ffmpegBin: cfg.ffmpegBin, ffprobeBin: cfg.ffprobeBin, tmpDir: path.join(cfg.dataDir, 'tmp') });
    case 'chirp3':
      // Missing project/bucket is reported per job as not_configured, so the server still boots.
      return new GoogleChirp3Transcriber({
        projectId: cfg.googleCloudProject,
        location: cfg.speechLocation,
        bucket: cfg.gcsTranscribeBucket,
        autoLanguageCodes: cfg.chirpLanguageCodes,
        segmented: cfg.chirpSegmented,
        ffmpegBin: cfg.ffmpegBin,
        tmpDir: path.join(cfg.dataDir, 'tmp'),
      });
    case 'deepgram':
      return new DeepgramTranscriber(cfg.deepgramApiKey);
    case 'whisper':
      if (!cfg.whisperModel) throw new Error('WHISPER_MODEL must point to a ggml model file');
      return new WhisperCppTranscriber({
        bin: cfg.whisperBin,
        model: cfg.whisperModel,
        ffmpegBin: cfg.ffmpegBin,
        tmpDir: path.join(cfg.dataDir, 'tmp'),
        threads: cfg.whisperThreads,
        codeSwitching: cfg.whisperCodeSwitching,
      });
  }
}

export function makeClassifier(cfg: Config): Classifier {
  switch (cfg.classifier) {
    case 'gemini':
      return new GeminiClassifier(cfg.geminiApiKey, cfg.geminiModel, cfg.geminiThinkingLevel);
    case 'anthropic':
      if (!cfg.anthropicApiKey) {
        return { name: 'anthropic', model: cfg.anthropicModel, classify: async () => Promise.reject(new NotConfiguredError('missing credential ANTHROPIC_API_KEY')) };
      }
      return new AnthropicClassifier(cfg.anthropicApiKey, cfg.anthropicModel);
    case 'ollama':
      return new OllamaClassifier(cfg.ollamaUrl, cfg.ollamaModel);
  }
}
