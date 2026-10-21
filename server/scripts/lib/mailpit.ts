/** Reads the code from the newest message to `to` in Mailpit (dev only). */
export async function waitForMailpitCode(
  baseUrl: string,
  to: string,
  opts: { sinceMs?: number; timeoutMs?: number } = {},
): Promise<{ code: string; subject: string; text: string; html: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const since = opts.sinceMs ?? 0;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=5`);
    if (res.ok) {
      const list = (await res.json()) as { messages: { ID: string; Created: string }[] };
      const m = list.messages.find((x) => Date.parse(x.Created) >= since - 1000);
      if (m) {
        const full = (await (await fetch(`${baseUrl}/api/v1/message/${m.ID}`)).json()) as { Subject: string; Text: string; HTML: string };
        const code = full.Text.match(/\b(\d{6})\b/)?.[1];
        if (code) return { code, subject: full.Subject, text: full.Text, html: full.HTML };
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no email for ${to} in Mailpit`);
}
