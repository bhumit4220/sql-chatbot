import { randomBytes } from 'node:crypto';
import { SESSION_TOKEN_EXPIRY_HOURS, SESSION_TOKEN_GRACE_SECONDS } from '@chatbot/shared';

interface Session {
  token: string;
  extensionId: string;
  expiresAt: Date;
  createdAt: Date;
}

interface GracedToken {
  token: string;
  expiresAt: Date;
}

interface ValidateResult {
  valid: boolean;
  newToken?: string;
  reason?: string;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private gracedTokens = new Map<string, GracedToken>();
  private expiryHours: number;

  constructor(expiryHours: number = SESSION_TOKEN_EXPIRY_HOURS) {
    this.expiryHours = expiryHours;
  }

  createSession(extensionId: string): Session {
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.expiryHours * 3600_000);
    const session: Session = { token, extensionId, expiresAt, createdAt: now };
    this.sessions.set(token, session);
    return session;
  }

  validate(token: string, origin: string): ValidateResult {
    let session = this.sessions.get(token);
    let fromGrace = false;

    if (!session) {
      const graced = this.gracedTokens.get(token);
      if (graced && graced.expiresAt > new Date()) {
        for (const s of this.sessions.values()) {
          if (s.extensionId === origin) {
            session = s;
            fromGrace = true;
            break;
          }
        }
      }
      if (!session) {
        return { valid: false, reason: 'Invalid or expired token' };
      }
    }

    if (session.extensionId !== origin) {
      return { valid: false, reason: 'Invalid origin — token bound to different extension' };
    }

    if (session.expiresAt <= new Date()) {
      this.sessions.delete(session.token);
      return { valid: false, reason: 'Token expired' };
    }

    if (!fromGrace) {
      const oldToken = session.token;
      const newToken = randomBytes(32).toString('hex');

      this.sessions.delete(oldToken);
      const newSession: Session = {
        token: newToken,
        extensionId: session.extensionId,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
      };
      this.sessions.set(newToken, newSession);

      this.gracedTokens.set(oldToken, {
        token: oldToken,
        expiresAt: new Date(Date.now() + SESSION_TOKEN_GRACE_SECONDS * 1000),
      });

      this.cleanupGraced();
      return { valid: true, newToken };
    }

    return { valid: true, newToken: session.token };
  }

  invalidateAll(): void {
    this.sessions.clear();
    this.gracedTokens.clear();
  }

  private cleanupGraced(): void {
    const now = new Date();
    for (const [token, graced] of this.gracedTokens) {
      if (graced.expiresAt <= now) {
        this.gracedTokens.delete(token);
      }
    }
  }
}
