import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { acceptedScopeHash, assertImportPublicKey, assertImportSignature, importHash } from './skill-import-crypto';
import { ImportChallenge } from './skill-import-state';

describe('Skill import Ed25519 contract', () => {
  const keys = generateKeyPairSync('ed25519');
  const der = keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = der.toString('base64url');
  const challenge: ImportChallenge = { challengeId: 'challenge', purpose: 'session-grant', instanceId: 'instance', sessionId: 'session', pairingId: 'pairing', deviceId: null, keyFingerprint: importHash(der), nonce: 'nonce', expiresAt: '2026-11-03T12:00:00.000Z', used: false };

  it('verifies the exact UTF-8 ordered JSON array, including canonical deduplicated consent', () => {
    const consentHash = createHash('sha256').update(JSON.stringify([false, 'user', ['a', 'b']]), 'utf8').digest('hex');
    const bytes = Buffer.from(JSON.stringify(['SEP-SKILL-IMPORT', 1, 'session-grant', 'instance', 'session', 'pairing', null, importHash(der), 'challenge', 'nonce', '2026-11-03T12:00:00.000Z', consentHash]));
    const signature = sign(null, bytes, keys.privateKey).toString('base64url');
    expect(() => assertImportSignature(challenge, publicKey, signature, false, 'user', ['b', 'a', 'a'])).not.toThrow();
    expect(() => assertImportSignature({ ...challenge, instanceId: 'other' }, publicKey, signature, false, 'user', ['a', 'b'])).toThrow(UnauthorizedException);
    expect(() => assertImportSignature(challenge, publicKey, signature, true, 'user', ['a', 'b'])).toThrow(UnauthorizedException);
    expect(() => assertImportSignature(challenge, publicKey, signature, false, 'all', ['a', 'b'])).toThrow(UnauthorizedException);
    expect(() => assertImportSignature(challenge, publicKey, signature, false, 'user', ['a', 'b', 'new'])).toThrow(UnauthorizedException);
    expect(() => assertImportSignature(challenge, publicKey, `${signature}=`, false, 'user', ['a', 'b'])).toThrow(UnauthorizedException);
  });

  it('rejects non-Ed25519 keys, padded encodings and trailing DER bytes', () => {
    expect(() => assertImportPublicKey(publicKey, importHash(der))).not.toThrow();
    const trailing = Buffer.concat([der, Buffer.from([0])]);
    expect(() => assertImportPublicKey(trailing.toString('base64url'), importHash(trailing))).toThrow(BadRequestException);
    expect(() => assertImportPublicKey(`${publicKey}=`, importHash(der))).toThrow(BadRequestException);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    expect(() => assertImportPublicKey(rsa.toString('base64url'), importHash(rsa))).toThrow(BadRequestException);
  });

  it('keeps accepted scope separate from remember-device consent', () => {
    expect(acceptedScopeHash('user', ['b', 'a', 'a'])).toBe(importHash(JSON.stringify(['user', ['a', 'b']])));
    expect(acceptedScopeHash('all', ['a', 'b'])).not.toBe(acceptedScopeHash('user', ['a', 'b']));
  });
});
