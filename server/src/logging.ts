import type { FastifyServerOptions } from 'fastify';
import type { DestinationStream } from 'pino';

/**
 * Privacy rules for logs: never bodies, emails (only hashed refs), codes, tokens, transcripts
 * or coordinates. Fastify never logs bodies by default; here we also strip query strings
 * (GET /v1/context carries lat/lon) and drop all headers.
 */
export function loggerOptions(level: string, stream?: DestinationStream): FastifyServerOptions['logger'] {
  return {
    level,
    ...(stream ? { stream } : {}),
    redact: {
      paths: [
        'email', '*.email', 'code', '*.code', 'token', '*.token', 'text', '*.text',
        'lat', 'lon', '*.lat', '*.lon', 'headers.authorization', '*.headers.authorization',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req(req: { method: string; url: string; id: string }) {
        return { method: req.method, path: stripQuery(req.url), reqId: req.id };
      },
      res(res: { statusCode: number }) {
        return { statusCode: res.statusCode };
      },
      err(err: Error & { code?: string; statusCode?: number }) {
        // Messages from parsers or tools may echo request content: keep only type and code.
        // Stack frames are kept (first line holds the message and is dropped).
        const frames = (err.stack ?? '').split('\n').slice(1, 6).join('\n');
        return { type: err.name, message: '[omitted]', stack: frames, code: err.code, statusCode: err.statusCode };
      },
    },
  };
}

export function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}
