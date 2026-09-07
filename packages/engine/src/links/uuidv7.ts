/**
 * UUIDv7 generator for link IDs (RFC 9562).
 *
 * UUIDv7 encodes a Unix timestamp in the most-significant 48 bits,
 * followed by version (4 bits = 0b0111), random (12 bits),
 * variant (2 bits = 0b10), and random (62 bits).
 *
 * Format: tttttttt-tttt-7xxx-yxxx-xxxxxxxxxxxx
 *   t = timestamp, 7 = version, y = variant (8/9/a/b), x = random
 */

/**
 * Generate a UUIDv7 string.
 *
 * The Engine is responsible for generating link IDs (spec requirement:
 * "Engine generates, SPI stores").
 */
export function generateUUIDv7(): string {
  const timestamp = Date.now();

  // 48-bit timestamp in ms
  const timeBits = new Uint8Array(6);
  let t = timestamp;
  for (let i = 5; i >= 0; i--) {
    timeBits[i] = t & 0xff;
    t = Math.floor(t / 256);
  }

  // 10 bytes of cryptographic randomness
  // Node.js 24+ always has globalThis.crypto.getRandomValues (Web Crypto API)
  const randBytes = new Uint8Array(10);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(randBytes);
  } else {
    // SEC-13: Use Node.js crypto instead of Math.random for unpredictable IDs
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomFillSync } = require('node:crypto') as typeof import('node:crypto');
    randomFillSync(randBytes);
  }

  // Assemble 16 bytes
  const uuid = new Uint8Array(16);

  // Bytes 0-5: timestamp
  uuid[0] = timeBits[0]!;
  uuid[1] = timeBits[1]!;
  uuid[2] = timeBits[2]!;
  uuid[3] = timeBits[3]!;
  uuid[4] = timeBits[4]!;
  uuid[5] = timeBits[5]!;

  // Byte 6: version (0111) in high nibble + 4 bits of random
  uuid[6] = (0x70) | (randBytes[0]! & 0x0f);

  // Byte 7: random
  uuid[7] = randBytes[1]!;

  // Byte 8: variant (10) in high 2 bits + 6 bits of random
  uuid[8] = (0x80) | (randBytes[2]! & 0x3f);

  // Bytes 9-15: random
  uuid[9] = randBytes[3]!;
  uuid[10] = randBytes[4]!;
  uuid[11] = randBytes[5]!;
  uuid[12] = randBytes[6]!;
  uuid[13] = randBytes[7]!;
  uuid[14] = randBytes[8]!;
  uuid[15] = randBytes[9]!;

  // Format as string
  return formatUUID(uuid);
}

/** Format 16 bytes as a UUID string (8-4-4-4-12). */
function formatUUID(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
