import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../index.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Vault', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-test-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('configure stores encrypted vault and unlock decrypts it', async () => {
    const vault = new Vault(dataDir);

    await vault.configure('test-passphrase-123', {
      dbUrl: 'postgresql://reader:pass@localhost/mydb',
      gitToken: 'ghp_abc123',
    });

    expect(vault.isConfigured()).toBe(true);
    expect(vault.isUnlocked()).toBe(false);

    await vault.unlock('test-passphrase-123');
    expect(vault.isUnlocked()).toBe(true);
    expect(vault.getSecret('dbUrl')).toBe('postgresql://reader:pass@localhost/mydb');
    expect(vault.getSecret('gitToken')).toBe('ghp_abc123');
  });

  it('rejects wrong passphrase on unlock', async () => {
    const vault = new Vault(dataDir);
    await vault.configure('correct-pass', { dbUrl: 'postgresql://a:b@c/d' });

    await expect(vault.unlock('wrong-pass')).rejects.toThrow();
    expect(vault.isUnlocked()).toBe(false);
  });

  it('lock wipes secrets from memory', async () => {
    const vault = new Vault(dataDir);
    await vault.configure('pass123', { dbUrl: 'postgresql://a:b@c/d' });
    await vault.unlock('pass123');
    expect(vault.getSecret('dbUrl')).toBe('postgresql://a:b@c/d');

    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    expect(() => vault.getSecret('dbUrl')).toThrow();
  });

  it('persists across instances', async () => {
    const vault1 = new Vault(dataDir);
    await vault1.configure('persist-test', { dbUrl: 'postgresql://x:y@z/db' });

    const vault2 = new Vault(dataDir);
    expect(vault2.isConfigured()).toBe(true);
    await vault2.unlock('persist-test');
    expect(vault2.getSecret('dbUrl')).toBe('postgresql://x:y@z/db');
  });

  it('handles optional gitToken', async () => {
    const vault = new Vault(dataDir);
    await vault.configure('pass', { dbUrl: 'postgresql://a:b@c/d' });
    await vault.unlock('pass');
    expect(vault.getSecret('gitToken')).toBeUndefined();
  });
});
