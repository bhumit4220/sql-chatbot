import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import argon2 from 'argon2';
import { VAULT_FILE } from '@chatbot/shared';

interface Secrets {
  dbUrl: string;
  gitToken?: string;
  llmApiKey?: string;
}

export class Vault {
  private dataDir: string;
  private vaultPath: string;
  private secrets: Secrets | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.vaultPath = join(dataDir, VAULT_FILE);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
  }

  isConfigured(): boolean {
    return existsSync(this.vaultPath);
  }

  isUnlocked(): boolean {
    return this.secrets !== null;
  }

  async configure(passphrase: string, secrets: Secrets): Promise<void> {
    const salt = randomBytes(32);
    const key = await this.deriveKey(passphrase, salt);

    const passphraseHash = await argon2.hash(passphrase, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = JSON.stringify(secrets);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    writeFileSync(this.vaultPath, JSON.stringify({
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      encrypted: encrypted.toString('base64'),
      passphraseHash,
    }));
  }

  async unlock(passphrase: string): Promise<void> {
    if (!this.isConfigured()) throw new Error('Vault not configured');

    const raw = JSON.parse(readFileSync(this.vaultPath, 'utf8'));
    const salt = Buffer.from(raw.salt, 'base64');
    const iv = Buffer.from(raw.iv, 'base64');
    const authTag = Buffer.from(raw.authTag, 'base64');
    const encrypted = Buffer.from(raw.encrypted, 'base64');

    const valid = await argon2.verify(raw.passphraseHash, passphrase);
    if (!valid) throw new Error('Invalid passphrase');

    const key = await this.deriveKey(passphrase, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');

    this.secrets = JSON.parse(plaintext);
  }

  lock(): void {
    this.secrets = null;
  }

  getSecret(key: keyof Secrets): string | undefined {
    if (!this.secrets) throw new Error('Vault is locked');
    return this.secrets[key];
  }

  private async deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
    return argon2.hash(passphrase, {
      type: argon2.argon2id,
      salt,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
      raw: true,
      hashLength: 32,
    }) as unknown as Buffer;
  }
}
