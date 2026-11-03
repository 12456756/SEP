import { z } from 'zod';
import { SkillImportArtifact, SkillImportCandidate, SkillImportEvent, SkillImportFileSchema, SkillImportPreviewResult, SkillImportScopeSchema, SkillImportSelection, SkillImportStatus } from 'shared';

export type ImportScope = z.infer<typeof SkillImportScopeSchema>;
export type ImportUser = { id: string; sid?: string; role: string };
export type ImportChallenge = {
  challengeId: string; purpose: 'session-grant' | 'device-revoke'; instanceId: string;
  sessionId: string | null; pairingId: string | null; deviceId: string | null;
  keyFingerprint: string; nonce: string; expiresAt: string; used: boolean;
};
export type ImportPairing = {
  pairingId: string; requestId: string; publicKey: string; keyFingerprint: string;
  label: string; platform: string; clientVersion: string; shortCode: string; expiresAt: string;
  webConfirmed: boolean; localConfirmed: boolean; deviceId: string | null;
  approvedScope?: { scope: ImportScope; rootIds: string[] };
  challenge: ImportChallenge; sessionGrantHash?: string; sessionGrantExpiresAt?: string;
  sessionGrantEpoch?: number;
};
export type ImportCommand = {
  sessionId: string; commandId: string; sequence: number; expiresAt: string;
  type: 'scan' | 'preview' | 'package-selected' | 'cancel';
  payload: Record<string, unknown>; started: boolean; completed: boolean;
};
export type ImportPreview = {
  requestId: string; candidateId: string; revision: number; commandId: string;
  status: 'pending' | 'ready' | 'failed'; deadline: number; errorCode: string | null;
  result: SkillImportPreviewResult | null; files: z.infer<typeof SkillImportFileSchema>[];
  nextClientCursor: string | null; usedCursors: string[];
};
export type ImportOperation = SkillImportSelection & {
  status: 'pending' | 'processing' | 'succeeded' | 'failed'; retryable: boolean;
  sha256: string | null; errorCode: string | null; packageSha256?: string; packageBytes?: number;
  uploadGrant?: { hash: string; expiresAt: string; epoch: number; pairingId: string };
  processing?: { ticketId: string; deadline: number; epoch: number; pairingId: string };
};
export type ImportEventAck = { ok: true; eventId: string; cursor: number; ignored: boolean };
export type ImportSession = {
  id: string; ownerUserId: string; ownerWebSessionId: string; ownerLabel: string;
  requestId: string; protocolVersion: 1; instanceId: string; scope: ImportScope;
  status: SkillImportStatus; version: number; epoch: number; createdAt: number;
  expiresAt: string; idleExpiresAt: string; pairingExpiresAt: string; deepLink: string;
  pairings: Record<string, ImportPairing>; activePairingId: string | null; acceptedScope?: { scope: ImportScope; rootIds: string[] };
  candidates: SkillImportCandidate[]; scanComplete: boolean;
  preview: ImportPreview | null; previewRequests: Record<string, { hash: string; commandId: string }>;
  operation: ImportOperation | null; artifact: SkillImportArtifact | null; closed: boolean;
  events: Record<string, { hash: string; ack: ImportEventAck }>; eventSequence: number; eventBytes: number;
  commands: ImportCommand[]; commandSequence: number;
  progress: Extract<SkillImportEvent, { type: 'progress' }>['payload'] | null;
  scanStartedAt?: number;
};
export type ImportUploadTicket = {
  sessionId: string; operationId: string; epoch: number; pairingId: string;
  ticketId: string; deadline: number; slot: string; packageSha256: string; packageBytes: number;
  replay?: boolean;
  startedAt: number;
};
