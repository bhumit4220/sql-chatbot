import Database from 'better-sqlite3';

let db: Database.Database;

export function initApiKeyDb(path: string = './data/api-keys.sqlite3') {
  db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      active INTEGER DEFAULT 1
    )
  `);
}

export function addApiKey(key: string, customerName: string): void {
  db.prepare('INSERT OR REPLACE INTO api_keys (key, customer_name) VALUES (?, ?)').run(key, customerName);
}

export function validateApiKey(key: string): { valid: boolean; customerName?: string } {
  const row = db.prepare('SELECT customer_name FROM api_keys WHERE key = ? AND active = 1').get(key) as { customer_name: string } | undefined;
  return row ? { valid: true, customerName: row.customer_name } : { valid: false };
}
