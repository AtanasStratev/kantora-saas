// Local development helper: prints the current TOTP code for a base32 secret, like an
// authenticator app would (RFC 6238, SHA-1, 6 digits, 30 s). Usage: node scripts/dev-totp.mjs <secret>
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`Invalid base32 character: ${ch}`);
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

if (process.argv[2]) console.log(totp(process.argv[2]));
