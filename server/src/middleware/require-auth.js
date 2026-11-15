import { verifyAccessToken } from '../auth/jwt.js';

export function requireAuth(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const payload = verifyAccessToken(match[1]);
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.auth = { userId: payload.sub, email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}
