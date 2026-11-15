import jwt from 'jsonwebtoken';

const JWT_ISSUER = 'pantrypal-api';

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be set to a random value at least 32 bytes long.');
  }
  return secret;
}

export function signAccessToken(user) {
  return jwt.sign({ email: user.email }, getJwtSecret(), {
    algorithm: 'HS256',
    expiresIn: '1h',
    issuer: JWT_ISSUER,
    subject: user.id,
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, getJwtSecret(), {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
  });
}
