/**
 * Single source of truth for password normalisation.
 *
 * Barry @ media-active.org.uk (2026-08-21) could not sign in with a password an
 * admin had just set for him — "Invalid email or password", repeatedly. Cause:
 * `loginUser()` did `password.trim()` before `bcrypt.compare`, but NOT ONE of
 * the five paths that HASH a password trimmed it first:
 *
 *   auth.service.ts        register
 *   user.service.ts        createUser / adminResetPassword / changeOwnPassword
 *   password-reset.service reset-via-OTP
 *
 * So a password set with a leading/trailing space (pasting from WhatsApp or a
 * doc makes this trivially easy) is stored hashed WITH the space, while login
 * strips it before comparing — the two can never match again. The account is
 * permanently locked out with an error message that blames the credentials.
 *
 * Normalising at every set AND compare point makes the two agree. This is
 * strictly an improvement for existing accounts: login already trimmed, so a
 * password whose hash contains outer whitespace was already unusable.
 *
 * Trimming BEFORE length validation also closes a smaller hole — "        "
 * used to pass the 8-character minimum, hash fine, and then fail every login.
 */
export function normalizePassword(password: string): string {
  return (password ?? '').trim();
}
