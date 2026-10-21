export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** Raised by provider adapters that are selected but lack credentials. Never produce fake output. */
export class NotConfiguredError extends Error {
  readonly code = 'not_configured';
  constructor(provider: string) {
    super(`${provider} is not configured`);
    this.name = 'NotConfiguredError';
  }
}
