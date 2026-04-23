import { describe, it, expect } from 'vitest';
import { runIntrospectCommand } from '../cli-introspect.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('runIntrospectCommand', () => {
  it('writes sql-chatbot-manifest.json with registry payload', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcb-'));
    const fixtures = path.resolve(__dirname, './fixtures/django');
    fs.cpSync(fixtures, path.join(tmp, 'app'), { recursive: true });
    const outPath = path.join(tmp, 'sql-chatbot-manifest.json');
    await runIntrospectCommand({ framework: 'django', code: path.join(tmp, 'app'), out: outPath });
    expect(fs.existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(parsed.framework).toBe('django');
    expect(parsed.entities.user).toBeDefined();
  });
});
