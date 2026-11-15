import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const usersByEmail = new Map();
const usersById = new Map();
const SALT_ROUNDS = 12;

export async function createUser(email, password) {
  const normalizedEmail = email.trim().toLowerCase();
  if (usersByEmail.has(normalizedEmail)) return null;

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  // Recheck after awaiting bcrypt so concurrent registrations cannot duplicate an email.
  if (usersByEmail.has(normalizedEmail)) return null;

  const user = {
    id: crypto.randomUUID(),
    email: normalizedEmail,
    passwordHash,
  };
  usersByEmail.set(normalizedEmail, user);
  usersById.set(user.id, user);
  return publicUser(user);
}

export async function verifyUser(email, password) {
  const user = usersByEmail.get(email.trim().toLowerCase());
  if (!user) {
    // Keep the missing-user path close to the bcrypt path to reduce timing-based account discovery.
    await bcrypt.compare(password, '$2a$12$C6UzMDM.H6dfI/f/IKcEe.4GxjgkqT8vCtyA0z1W2I9hwT75kW7eW');
    return null;
  }
  return (await bcrypt.compare(password, user.passwordHash)) ? publicUser(user) : null;
}

export function findUserById(id) {
  const user = usersById.get(id);
  return user ? publicUser(user) : null;
}

export async function seedDevelopmentUser() {
  if (process.env.NODE_ENV === 'production' || process.env.SEED_DEV_USER === 'false') return null;

  const email = process.env.DEV_SEED_EMAIL || 'demo@pantrypal.local';
  const password = process.env.DEV_SEED_PASSWORD || 'PantryPalDev!2026';
  const existing = usersByEmail.get(email.trim().toLowerCase());
  if (existing) return publicUser(existing);
  return createUser(email, password);
}

function publicUser(user) {
  return { id: user.id, email: user.email };
}
