import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';

/**
 * Web Push with the platform's own primitives (ADR 0018):
 * - message encryption is RFC 8291 (aes128gcm, RFC 8188), one record;
 * - sender identity is RFC 8292 (VAPID, ES256).
 * Keys are base64url: the public key is the uncompressed P-256 point, the private key is the 32-byte scalar.
 */
export type VapidKeys = { publicKey: string; privateKey: string };
export type SubscriptionKeys = { p256dh: string; auth: string };

const RECORD_SIZE = 4096;
/** Plaintext limit that keeps one record well inside every push service's 4 KiB body limit. */
export const maxPayloadBytes = 3000;

export class WebPushError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'WebPushError'; this.code = code; }
}

const encode = (value: Uint8Array) => Buffer.from(value).toString('base64url');
function decode(value: string, length: number, code: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new WebPushError(code);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length) throw new WebPushError(code);
  return bytes;
}
function point(value: string, code: string): Buffer {
  const bytes = decode(value, 65, code);
  if (bytes[0] !== 4) throw new WebPushError(code);
  return bytes;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // The scalar may have leading zero bytes; JWK `d` needs all 32.
  const scalar = Buffer.alloc(32);
  const raw = ecdh.getPrivateKey();
  raw.copy(scalar, 32 - raw.length);
  return { publicKey: encode(ecdh.getPublicKey()), privateKey: encode(scalar) };
}

/** Rejects keys that are malformed or not on the curve before anything is stored. */
export function validSubscriptionKeys(keys: SubscriptionKeys): boolean {
  try {
    decode(keys.auth, 16, 'invalid_subscription_keys');
    const probe = createECDH('prime256v1'); probe.generateKeys();
    probe.computeSecret(point(keys.p256dh, 'invalid_subscription_keys'));
    return true;
  } catch { return false; }
}

/** `Authorization` header for one push service origin; the token lives for 12 hours (RFC 8292 caps it at 24). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const publicPoint = point(keys.publicKey, 'invalid_vapid_key');
  const key = createPrivateKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', x: encode(publicPoint.subarray(1, 33)), y: encode(publicPoint.subarray(33)), d: encode(decode(keys.privateKey, 32, 'invalid_vapid_key')),
  } });
  const header = encode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = encode(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const unsigned = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${encode(signature)}, k=${keys.publicKey}`;
}

/**
 * Encrypts one push message for one subscription. `fixed` exists only to reproduce the RFC 8291 example;
 * production calls get a fresh sender key and salt every time.
 */
export function encryptPayload(plaintext: Uint8Array, subscription: SubscriptionKeys, fixed?: { salt: Uint8Array; senderPrivateKey: Uint8Array }): Buffer {
  if (plaintext.byteLength > maxPayloadBytes) throw new WebPushError('payload_too_large');
  const receiverPublic = point(subscription.p256dh, 'invalid_subscription_keys');
  const authSecret = decode(subscription.auth, 16, 'invalid_subscription_keys');
  const sender = createECDH('prime256v1');
  if (fixed) sender.setPrivateKey(Buffer.from(fixed.senderPrivateKey)); else sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  let shared: Buffer;
  try { shared = sender.computeSecret(receiverPublic); } catch { throw new WebPushError('invalid_subscription_keys'); }
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = fixed ? Buffer.from(fixed.salt) : randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // A single record ends with the 0x02 delimiter and carries no padding.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = senderPublic.length;
  for (const secret of [shared, ikm, cek, nonce]) secret.fill(0);
  return Buffer.concat([header, senderPublic, sealed]);
}

/**
 * Push services Zhongshu will deliver to, by base domain. The browser chooses the endpoint and vendors move it
 * between hosts (Chrome 159 uses jmt17.google.com, older Chrome fcm.googleapis.com), so subdomains are allowed;
 * anything else is refused.
 */
const pushDomains = ['googleapis.com', 'google.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
export function allowedEndpoint(value: string): boolean {
  if (value.length > 2048) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const host = url.hostname;
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && /^[a-z0-9.-]+$/.test(host)
    && pushDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
}
