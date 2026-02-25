import { Request, Response, NextFunction } from 'express';
import { validateApiKey } from '../db/api-keys.js';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }

  const key = authHeader.slice(7);
  const result = validateApiKey(key);
  if (!result.valid) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  (req as any).customerName = result.customerName;
  next();
}
