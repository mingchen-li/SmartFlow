import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'sflow_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  v: 1;
  iat: number;
  exp: number;
}

/**
 * Stateless, HMAC-signed session tokens. The signing secret is persisted in the
 * Project's SQLite settings, so a Server restart keeps existing sessions valid.
 */
export class SessionService {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {}

  issue(): string {
    const issuedAt = this.now();
    const payload: SessionPayload = {
      v: 1,
      iat: issuedAt,
      exp: issuedAt + SESSION_TTL_MS,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encodedPayload}.${this.sign(encodedPayload)}`;
  }

  verify(token: string | undefined | null): boolean {
    if (!token) return false;

    const separator = token.lastIndexOf('.');
    if (separator <= 0) return false;

    const encodedPayload = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expected = this.sign(encodedPayload);

    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
      return false;
    }

    try {
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<SessionPayload>;
      return payload.v === 1 && typeof payload.exp === 'number' && payload.exp > this.now();
    } catch {
      return false;
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}
