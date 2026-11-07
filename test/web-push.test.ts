import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { allowedEndpoint, encryptPayload, generateVapidKeys, maxPayloadBytes, validSubscriptionKeys, vapidAuthorization } from '../src/server/web-push.ts';

const b64 = (value: string) => Buffer.from(value.replace(/\s+/g, ''), 'base64url');

test('encryption reproduces the RFC 8291 example byte for byte', () => {
  // RFC 8291 section 5 and appendix A.
  const body = encryptPayload(b64('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'), {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, { salt: b64('DGv6ra1nlYgDCS1FRnbzlw'), senderPrivateKey: b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') });
  const header = b64(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`);
  const ciphertext = b64(`8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ`);
  assert.equal(header.length, 86);
  assert.deepEqual(body, Buffer.concat([header, ciphertext]));
});

test('a receiver holding the subscription secret decrypts a fresh message', () => {
  const receiver = createECDH('prime256v1'); receiver.generateKeys();
  const auth = Buffer.alloc(16, 7);
  const keys = { p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const message = Buffer.from(JSON.stringify({ kind: 'completed' }));
  const body = encryptPayload(message, keys);
  const again = encryptPayload(message, keys);
  assert.notDeepEqual(body.subarray(0, 16), again.subarray(0, 16), 'every message has a fresh salt');
  const salt = body.subarray(0, 16); const senderPublic = body.subarray(21, 86);
  assert.equal(body.readUInt32BE(16), 4096); assert.equal(body[20], 65);
  const shared = receiver.computeSecret(senderPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const sealed = body.subarray(86);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  assert.deepEqual(plain, Buffer.concat([message, Buffer.from([2])]));
  assert.throws(() => encryptPayload(Buffer.alloc(maxPayloadBytes + 1), keys), /payload_too_large/);
});

test('subscription keys must be a curve point and a 16-byte secret', () => {
  const receiver = createECDH('prime256v1'); receiver.generateKeys();
  const p256dh = receiver.getPublicKey().toString('base64url');
  assert.equal(validSubscriptionKeys({ p256dh, auth: Buffer.alloc(16).toString('base64url') }), true);
  assert.equal(validSubscriptionKeys({ p256dh, auth: Buffer.alloc(8).toString('base64url') }), false);
  const offCurve = Buffer.alloc(65, 1); offCurve[0] = 4;
  assert.equal(validSubscriptionKeys({ p256dh: offCurve.toString('base64url'), auth: Buffer.alloc(16).toString('base64url') }), false);
  assert.equal(validSubscriptionKeys({ p256dh: 'not base64!', auth: 'x' }), false);
});

test('VAPID token is an ES256 JWT for the push service origin, verifiable with the public key', () => {
  const keys = generateVapidKeys();
  assert.equal(Buffer.from(keys.privateKey, 'base64url').length, 32);
  const now = Date.UTC(2026, 10, 7);
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://zhongshu.example', now);
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(match);
  const [, head, claims, signature, publicKey] = match;
  assert.equal(publicKey, keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(head!, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(claims!, 'base64url').toString()), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://zhongshu.example' });
  const point = Buffer.from(keys.publicKey, 'base64url');
  const verifier = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
  assert.equal(verify('sha256', Buffer.from(`${head}.${claims}`), { key: verifier, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url')), true);
});

test('only HTTPS endpoints of known push services are accepted', () => {
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc', 'https://jmt17.google.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/QX', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.equal(allowedEndpoint(endpoint), true, endpoint);
  for (const endpoint of ['http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x',
    'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evil.example/fcm.googleapis.com', 'https://evilgoogle.com/x', 'https://fcm.googleapis.com./x', 'not a url',
    `https://fcm.googleapis.com/${'a'.repeat(2100)}`]) assert.equal(allowedEndpoint(endpoint), false, endpoint);
});
