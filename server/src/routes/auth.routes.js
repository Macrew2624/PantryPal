import { Router } from 'express';
import { createUser, findUserById, verifyUser } from '../auth/users.js';
import { signAccessToken } from '../auth/jwt.js';
import { requireAuth } from '../middleware/require-auth.js';

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const { email, password } = req.body || {};
  const validationError = validateCredentials(email, password);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    const user = await createUser(email, password);
    if (!user) return res.status(409).json({ error: 'An account with this email already exists.' });
    return res.status(201).json({ user });
  } catch {
    return res.status(500).json({ error: 'Unable to create account.' });
  }
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    return res.json({ token: signAccessToken(user), user });
  } catch {
    return res.status(500).json({ error: 'Unable to complete login.' });
  }
});

authRouter.get('/me', requireAuth, (req, res) => {
  const user = findUserById(req.auth.userId);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({ user });
});

function validateCredentials(email, password) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return 'A valid email address is required.';
  }
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return 'Password must be between 8 and 72 UTF-8 bytes.';
  }
  return null;
}
