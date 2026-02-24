import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../session.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it('creates a session token', () => {
    const session = manager.createSession('chrome-extension://abc123');
    expect(session.token).toHaveLength(64); // hex string
    expect(session.extensionId).toBe('chrome-extension://abc123');
    expect(session.expiresAt).toBeInstanceOf(Date);
  });

  it('validates a valid token', () => {
    const session = manager.createSession('chrome-extension://abc123');
    const result = manager.validate(session.token, 'chrome-extension://abc123');
    expect(result.valid).toBe(true);
  });

  it('rotates token on validate, old token valid for grace period', () => {
    const session = manager.createSession('chrome-extension://abc123');
    const oldToken = session.token;

    const result = manager.validate(oldToken, 'chrome-extension://abc123');
    expect(result.valid).toBe(true);
    expect(result.newToken).toBeDefined();
    expect(result.newToken).not.toBe(oldToken);

    // Old token still valid within grace period (5s)
    const graceResult = manager.validate(oldToken, 'chrome-extension://abc123');
    expect(graceResult.valid).toBe(true);
  });

  it('rejects wrong origin', () => {
    const session = manager.createSession('chrome-extension://abc123');
    const result = manager.validate(session.token, 'chrome-extension://wrong');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('origin');
  });

  it('rejects expired token', () => {
    const manager = new SessionManager(0); // 0 hours = immediate expiry
    const session = manager.createSession('chrome-extension://abc123');
    const result = manager.validate(session.token, 'chrome-extension://abc123');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('invalidateAll clears all sessions', () => {
    const session = manager.createSession('chrome-extension://abc123');
    manager.invalidateAll();
    const result = manager.validate(session.token, 'chrome-extension://abc123');
    expect(result.valid).toBe(false);
  });
});
