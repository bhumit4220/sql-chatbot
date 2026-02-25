import rateLimit from 'express-rate-limit';

export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.headers.authorization?.slice(7) || req.ip || 'unknown',
  message: { error: 'Rate limit exceeded. Try again in 1 minute.' },
});
