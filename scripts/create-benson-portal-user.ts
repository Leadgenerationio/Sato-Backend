import { db } from '../src/config/database.js';
import { users } from '../src/db/schema/users.js';
import { eq } from 'drizzle-orm';
import bcryptjs from 'bcryptjs';
import { randomBytes } from 'crypto';

const BENSON_ID = '997f415b-a378-4ccb-ab14-9fb05a1a5769';
const EMAIL = 'coby@bensongoldstein.com';
const NAME = 'Coby Benson';

// Generate a strong 14-char temp password. Sam shares once with Benson, who
// rotates via /portal/account (shipped today). Mix of upper/lower/digits/
// symbols, no ambiguous chars (0, O, l, 1).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const SYMBOLS = '!@#$%';
function makePassword(): string {
  const buf = randomBytes(14);
  let out = '';
  for (let i = 0; i < 12; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  out += SYMBOLS[buf[12] % SYMBOLS.length];
  out += (buf[13] % 10).toString();
  return out;
}

// Check for existing user under this email (across all clients) — bail if so.
const existingByEmail = await db.select().from(users).where(eq(users.email, EMAIL));
if (existingByEmail.length > 0) {
  console.log('USER EXISTS — not re-creating. Existing:', existingByEmail.map(u => ({ id: u.id, email: u.email, role: u.role, clientId: u.clientId })));
  process.exit(0);
}

const password = makePassword();
const hash = await bcryptjs.hash(password, 12);

const [row] = await db.insert(users).values({
  email: EMAIL,
  name: NAME,
  passwordHash: hash,
  role: 'client',
  clientId: BENSON_ID,
}).returning({ id: users.id, email: users.email, role: users.role, clientId: users.clientId });

console.log('=== Portal user created ===');
console.log({ id: row.id, email: row.email, role: row.role, clientId: row.clientId });
console.log('\nTEMP PASSWORD (share once with Sam, then he gives to Coby):');
console.log(password);
console.log('\nLogin URL: https://sato-frontend.vercel.app/login');
console.log('Coby should rotate the password at /portal/account on first login.');

process.exit(0);
