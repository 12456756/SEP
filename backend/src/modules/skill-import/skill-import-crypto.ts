import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { ImportChallenge, ImportScope } from './skill-import-state';

export const importId = () => randomBytes(24).toString('base64url');
export const importHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const normalizedRoots = (roots: string[]) => [...new Set(roots)].sort();
export const acceptedScopeHash = (scope: ImportScope, roots: string[]) => importHash(JSON.stringify([scope, normalizedRoots(roots)]));

export function assertImportPublicKey(publicKey: string, fingerprint: string): void {
  try {
    const der = Buffer.from(publicKey, 'base64url');
    const parsed = createPublicKey({ key: der, format: 'der', type: 'spki' });
    const canonical = parsed.export({ format: 'der', type: 'spki' });
    if (!canonical.equals(der) || publicKey !== der.toString('base64url') || parsed.asymmetricKeyType !== 'ed25519' || importHash(der) !== fingerprint) throw new Error('invalid');
  } catch { throw new BadRequestException({ code: 'DEVICE_PROOF_INVALID', message: '设备 Ed25519 公钥或指纹无效' }); }
}

export function importSigningMessage(challenge: ImportChallenge, rememberDevice: boolean, scope: ImportScope | 'revoke', roots: string[]): Buffer {
  const consentHash = importHash(JSON.stringify([rememberDevice, scope, normalizedRoots(roots)]));
  return Buffer.from(JSON.stringify(['SEP-SKILL-IMPORT', 1, challenge.purpose, challenge.instanceId,
    challenge.sessionId, challenge.pairingId, challenge.deviceId, challenge.keyFingerprint,
    challenge.challengeId, challenge.nonce, challenge.expiresAt, consentHash]), 'utf8');
}

export function assertImportSignature(challenge: ImportChallenge, publicKey: string, signature: string, rememberDevice: boolean, scope: ImportScope | 'revoke', roots: string[]): void {
  let valid = false;
  try {
    const bytes = Buffer.from(signature, 'base64url');
    valid = signature === bytes.toString('base64url') && verify(null,
      importSigningMessage(challenge, rememberDevice, scope, roots),
      createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' }), bytes);
  } catch { valid = false; }
  if (!valid) throw new UnauthorizedException({ code: 'DEVICE_PROOF_INVALID', message: '设备签名无效' });
}
