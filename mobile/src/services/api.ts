import Constants from "expo-constants";
import * as LegacyFS from "expo-file-system/legacy";
import { Platform } from "react-native";
import type { JournalSyncApi, RemoteChange, SyncedEntry } from '../data/sync';

/**
 * Day Two server (see docs/API.md). Provider keys live only on the server.
 * Dev default: the Mac running `server/` — localhost on the iOS simulator, 10.0.2.2 on the Android emulator.
 */
export function apiBase(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const extra = (Constants.expoConfig?.extra as any)?.apiUrl;
  if (extra) return extra;
  return Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787";
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, public retryAfter?: number, public body?: any) {
    super(code);
  }
}
export const isNetworkError = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 500;

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;
export function setApiToken(t: string | null) {
  token = t;
}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number; form?: FormData; authToken?: string } = {}): Promise<T> {
  const requestToken = opts.authToken ?? token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  let res: Response;
  try {
    res = await fetch(apiBase() + path, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(opts.form ? {} : body !== undefined ? { "content-type": "application/json" } : {}),
        ...(requestToken ? { authorization: `Bearer ${requestToken}` } : {}),
      },
      body: opts.form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (err) {
    if (__DEV__) console.log("FETCH failed", method, path, String(err));
    throw new ApiError(0, "network");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  let json: any = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && requestToken && requestToken === token) onUnauthorized?.();
    throw new ApiError(res.status, json?.error ?? "http_" + res.status, json?.retryAfter, json);
  }
  return json as T;
}

export interface User {
  id: string;
  email: string;
}
export interface McpConnection { id: string; name: string; scopes: string; createdAt: number }
/** Capture the account token: an old in-flight sync must never use a new account's session. */
export function journalApi(sessionToken: string): JournalSyncApi {
  const opts = { authToken: sessionToken };
  return {
    changes: after => request<{ items: RemoteChange[]; cursor: number; hasMore: boolean }>('GET', '/v1/journal/changes?after=' + after, undefined, opts),
    put: (id: string, baseRevision: number, entry: SyncedEntry | null) => request<RemoteChange>('PUT', '/v1/journal/entries/' + encodeURIComponent(id), { baseRevision, entry }, opts),
  };
}

export const api = {
  connections: () => request<{ connections: McpConnection[]; url: string }>('GET', '/v1/mcp/connections'),
  revokeConnection: (id: string) => request<void>('DELETE', '/v1/mcp/connections/' + encodeURIComponent(id)),
  requestCode: (email: string, locale: string) =>
    request<{ ok: true; resendAfter: number; expiresIn: number; codeLength: number }>("POST", "/v1/auth/request-code", { email, locale }),
  verifyCode: (email: string, code: string) => request<{ token: string; user: User }>("POST", "/v1/auth/verify-code", { email, code }),
  me: () => request<User>("GET", "/v1/me"),
  logout: () => request<void>("POST", "/v1/auth/logout"),
  requestEmailChange: (newEmail: string, locale: string) => request<{ ok: true; resendAfter: number }>("POST", "/v1/account/email/request", { newEmail, locale }),
  verifyEmailChange: (newEmail: string, code: string) => request<{ user: User }>("POST", "/v1/account/email/verify", { newEmail, code }),
  deleteAccount: () => request<void>("DELETE", "/v1/account"),
  /** Native streamed multipart upload of the original (no full read into JS memory). */
  uploadTranscription: async (jobId: string, file: { uri: string; name: string; type: string }) => {
    // Native upload tasks may wait for connectivity instead of failing: check the server first,
    // so an unreachable server shows "pending" rather than an endless "preparing".
    await request("GET", "/v1/health", undefined, { timeoutMs: 6000 });
    let r: LegacyFS.FileSystemUploadResult;
    try {
      r = await LegacyFS.uploadAsync(apiBase() + "/v1/transcriptions", file.uri, {
        httpMethod: "POST",
        uploadType: LegacyFS.FileSystemUploadType.MULTIPART,
        fieldName: "audio",
        mimeType: file.type,
        parameters: { jobId, languageHint: "auto" },
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    } catch (err) {
      if (__DEV__) console.log("UPLOAD failed", String(err));
      throw new ApiError(0, "network");
    }
    let json: any = null;
    try {
      json = JSON.parse(r.body);
    } catch {}
    if (r.status >= 400) {
      if (r.status === 401 && token) onUnauthorized?.();
      throw new ApiError(r.status, json?.error ?? "http_" + r.status, json?.retryAfter, json);
    }
    return json as { jobId: string; status: string };
  },
  transcription: (jobId: string) =>
    request<{ jobId: string; status: "queued" | "processing" | "done" | "failed"; result?: { text: string; language: string; uncertain?: { start: number; end: number }[] }; error?: string }>(
      "GET",
      `/v1/transcriptions/${jobId}`,
    ),
  cancelTranscription: (jobId: string) => request<void>("DELETE", `/v1/transcriptions/${jobId}`),
  classify: (body: { jobId: string; text: string; language?: string | null; vocabulary: { topics: string[]; emotions: string[] }; rejected: { topics: string[]; emotions: string[] } }) =>
    request<{ topics: string[]; emotions: string[] }>("POST", "/v1/classify", body, { timeoutMs: 90000 }),
  context: (lat: number, lon: number, at: string, lang: string) =>
    request<{ city?: string; temperatureC?: number; condition?: string; observedAt?: string }>(
      "GET",
      `/v1/context?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&at=${encodeURIComponent(at)}&lang=${lang}`,
    ),
};
