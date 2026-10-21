import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  readonly name: string;
  send(msg: MailMessage): Promise<void>;
}

export class SmtpMailer implements Mailer {
  readonly name = 'smtp';
  private transport;
  constructor(private cfg: Config['smtp']) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      // Authenticated submission must never fall back to cleartext SMTP.
      requireTLS: Boolean(cfg.user) && !cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? '' } : undefined,
      // nodemailer logging stays off: it would print recipients.
      logger: false,
    });
  }
  async send(msg: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.cfg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
  }
}

/** In-memory mailer for unit tests. */
export class MemoryMailer implements Mailer {
  readonly name = 'memory';
  sent: MailMessage[] = [];
  async send(msg: MailMessage) {
    this.sent.push(msg);
  }
  lastCodeFor(to: string): string | undefined {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    return m?.text.match(/\b(\d{6})\b/)?.[1];
  }
}

export type Locale = 'es' | 'en';
export type CodePurpose = 'login' | 'email_change';

/**
 * Discreet, tracking-free email: no images, no links, no pixels. The subject does not
 * contain the code so it doesn't show on lock screens.
 */
export function codeEmail(to: string, code: string, locale: Locale, purpose: CodePurpose): MailMessage {
  const t =
    locale === 'en'
      ? {
          subject: purpose === 'login' ? 'Your Day Two code' : 'Confirm your new email for Day Two',
          intro:
            purpose === 'login'
              ? 'Use this code to continue in Day Two:'
              : 'Use this code to confirm this address as your new Day Two email:',
          expiry: 'It expires in 10 minutes.',
          ignore: "If you didn't request it, you can ignore this email.",
        }
      : {
          subject: purpose === 'login' ? 'Tu código de Day Two' : 'Confirma tu nuevo email en Day Two',
          intro:
            purpose === 'login'
              ? 'Usa este código para continuar en Day Two:'
              : 'Usa este código para confirmar esta dirección como tu nuevo email de Day Two:',
          expiry: 'Caduca en 10 minutos.',
          ignore: 'Si no lo has pedido, puedes ignorar este mensaje.',
        };
  const text = `${t.intro}\n\n${code}\n\n${t.expiry}\n${t.ignore}\n`;
  const html = `<!doctype html><html lang="${locale}"><body style="font-family:Georgia,serif;color:#222;background:#fff;padding:24px">
<p>${t.intro}</p>
<p style="font-size:28px;letter-spacing:6px;font-family:Menlo,monospace">${code}</p>
<p style="color:#666">${t.expiry}<br>${t.ignore}</p>
</body></html>`;
  return { to, subject: t.subject, text, html };
}
