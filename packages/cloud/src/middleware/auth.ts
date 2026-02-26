import { Request, Response, NextFunction } from 'express';
import { validateApiKey } from '../db/api-keys.js';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  // Accept both Authorization: Bearer <key> and X-API-Key: <key>
  const authHeader = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'] as string | undefined;

  let key: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    key = authHeader.slice(7);
  } else if (xApiKey) {
    key = xApiKey;
  }

  if (!key) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }
  const result = validateApiKey(key);
  if (!result.valid) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  (req as any).customerName = result.customerName;
  next();
}
