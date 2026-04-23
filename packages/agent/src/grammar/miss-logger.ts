import fs from 'fs';
import path from 'path';

export interface MissEntry {
  question: string;
  reason: string;
  extracted: unknown;
  resultingSql?: string;
}

export function logMiss(logPath: string, entry: MissEntry): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(logPath, line);
}
