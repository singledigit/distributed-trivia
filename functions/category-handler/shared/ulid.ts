/**
 * ULID (Universally Unique Lexicographically Sortable Identifier) generator.
 *
 * Produces 26-character Crockford Base32 IDs with millisecond timestamp prefix
 * for natural chronological sorting in DynamoDB.
 */

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now: number, length: number): string {
  let str = '';
  let remaining = now;
  for (let i = length; i > 0; i--) {
    const mod = remaining % 32;
    str = CROCKFORD_BASE32[mod] + str;
    remaining = (remaining - mod) / 32;
  }
  return str;
}

function encodeRandom(length: number): string {
  let str = '';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    str += CROCKFORD_BASE32[bytes[i] % 32];
  }
  return str;
}

/** Generate a new ULID string (26 chars, Crockford Base32). */
export function generateUlid(): string {
  const now = Date.now();
  return encodeTime(now, 10) + encodeRandom(16);
}
