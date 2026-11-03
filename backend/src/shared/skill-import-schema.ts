import { z } from 'zod';
import { SkillContentSchema, SKILL_PACKAGE_MAX_BYTES, SKILL_PACKAGE_MAX_ENTRIES, SKILL_PACKAGE_MAX_UNCOMPRESSED_BYTES } from './skill-content-schema';

export const SkillImportProtocolVersion = 1 as const;
export const SkillImportErrorCodeSchema = z.enum(['REQUEST_BODY_TOO_LARGE', 'IMPORT_DISABLED', 'IMPORT_UNAVAILABLE', 'OWNER_AUTH_REQUIRED', 'OWNER_AUTH_REVOKED', 'OWNER_MISMATCH', 'SESSION_EXPIRED', 'SESSION_CANCELLED', 'SESSION_CLOSED', 'SESSION_LIMIT_REACHED', 'DEVICE_CONFIRMATION_REQUIRED', 'DEVICE_PROOF_INVALID', 'DEVICE_REVOKED', 'CLIENT_UPGRADE_REQUIRED', 'CLIENT_BUSY', 'GRANT_EXPIRED', 'CHALLENGE_USED', 'SCOPE_MISMATCH', 'OPERATION_CONFLICT', 'CANDIDATE_CHANGED', 'CANDIDATE_LIMIT_REACHED', 'SNAPSHOT_EXPIRED', 'PREVIEW_INVALID', 'PREVIEW_TIMEOUT', 'PREVIEW_SUPERSEDED', 'PACKAGE_REJECTED', 'PACKAGE_CHANGED', 'PACKAGE_NOT_READY', 'UPLOAD_PROCESSING', 'UPLOAD_BUSY', 'UPLOAD_TIMEOUT', 'UPLOAD_INTERRUPTED', 'CURSOR_INVALID', 'EVENT_BUDGET_EXCEEDED', 'EVENT_CONFLICT', 'EVENT_SEQUENCE_INVALID', 'EVENT_INVALID', 'COMMAND_INVALID', 'RATE_LIMITED']);
export const SkillImportConfigSchema = z.object({ enabled: z.boolean(), instanceId: z.string(), protocolVersion: z.literal(1), minClientVersion: z.string() }).strict();
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const date = z.string().datetime({ precision: 3 });
export const SkillImportScopeSchema = z.enum(['user', 'project', 'all']);
export const SkillImportStatusSchema = z.enum(['waiting-client', 'pairing', 'ready', 'scanning', 'results', 'previewing', 'packaging', 'uploading', 'uploaded', 'cancelled', 'expired', 'failed']);
export type SkillImportStatus = z.infer<typeof SkillImportStatusSchema>;
export const SkillImportRelativePathSchema = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith('/') && !value.includes('\\') && !/^[A-Za-z]:/.test(value) && !/[\u0000-\u001f]/.test(value)
  && value.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0), 'Only safe relative paths are accepted');
export const SkillImportWarningSchema = z.object({ code: z.string().min(1).max(96), message: z.string().min(1).max(512), severity: z.enum(['warning', 'blocking']) }).strict();
export const SkillImportCandidateSchema = z.object({
  candidateId: id, revision: z.number().int().positive(), name: z.string().min(1).max(160), description: z.string().max(4000).nullable(),
  sources: z.array(z.string().min(1).max(96)).max(16), scope: z.enum(['user', 'project']),
  locations: z.array(z.object({ rootId: id, rootLabel: z.string().min(1).max(160), relativePath: SkillImportRelativePathSchema }).strict()).min(1).max(32),
  treeHash: hash.nullable(), availability: z.enum(['previewable', 'blocked']), warnings: z.array(SkillImportWarningSchema).max(32),
}).strict();
export type SkillImportCandidate = z.infer<typeof SkillImportCandidateSchema>;
export const SkillImportFileSchema = z.object({ relativePath: SkillImportRelativePathSchema, bytes: z.number().int().nonnegative().max(SKILL_PACKAGE_MAX_UNCOMPRESSED_BYTES) }).strict();
export const SkillImportPreviewResultSchema = z.object({
  requestId: id, candidateId: id, snapshotId: id, expiresAt: date, content: SkillContentSchema, treeHash: hash,
  fileCount: z.number().int().positive().max(SKILL_PACKAGE_MAX_ENTRIES), totalUncompressedBytes: z.number().int().positive().max(SKILL_PACKAGE_MAX_UNCOMPRESSED_BYTES),
  estimatedPackageBytes: z.number().int().positive().max(SKILL_PACKAGE_MAX_BYTES), files: z.array(SkillImportFileSchema).max(100),
  nextFilesCursor: id.nullable(), warnings: z.array(SkillImportWarningSchema).max(32),
}).strict();
export type SkillImportPreviewResult = z.infer<typeof SkillImportPreviewResultSchema>;
export const SkillImportSelectionSchema = z.object({ candidateId: id, snapshotId: id, operationId: id }).strict();
export type SkillImportSelection = z.infer<typeof SkillImportSelectionSchema>;
export const SkillImportSessionCreateSchema = z.object({ requestId: id, protocolVersion: z.literal(1), scope: SkillImportScopeSchema.default('user') }).strict();
export type SkillImportSessionCreate = z.infer<typeof SkillImportSessionCreateSchema>;
export const SkillImportPreviewSchema = z.object({ requestId: id, candidateId: id, revision: z.number().int().positive() }).strict();
export const SkillImportConfirmDeviceSchema = z.object({ pairingId: id, keyFingerprint: hash, shortCode: z.string().regex(/^\d{6}$/) }).strict();
export const SkillImportPairingSchema = z.object({ requestId: id, sessionId: id, publicKey: base64url.min(32).max(4096), keyFingerprint: hash, protocolVersion: z.literal(1), clientVersion: z.string().min(1).max(64), platform: z.string().min(1).max(32), label: z.string().min(1).max(160).optional() }).strict();
export const SkillImportGrantSchema = z.object({ challengeId: id, signature: base64url.min(16).max(4096), rememberDevice: z.boolean(), scope: SkillImportScopeSchema, rootIds: z.array(id).max(128) }).strict();
export const SkillImportChallengeSchema = z.object({ purpose: z.enum(['session-grant', 'device-revoke']), sessionId: id.nullable().optional(), pairingId: id.nullable().optional(), deviceId: id.nullable().optional(), clientVersion: z.string().regex(/^\d+\.\d+\.\d+$/).max(64).optional() }).strict().superRefine((value, ctx) => {
  if (value.purpose === 'device-revoke' ? (!value.deviceId || value.sessionId || value.pairingId) : (!value.sessionId || Boolean(value.deviceId) === Boolean(value.pairingId))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Challenge target is invalid' });
  if (value.purpose === 'device-revoke' && value.clientVersion) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Device revocation does not require a client version' });
});
export const SkillImportUploadGrantSchema = z.object({ candidateId: id, snapshotId: id, packageSha256: hash, packageBytes: z.number().int().positive().max(SKILL_PACKAGE_MAX_BYTES) }).strict();
export const SkillImportQuerySchema = z.object({ view: z.enum(['status', 'candidates', 'preview', 'files', 'operation']).default('status'), cursor: z.string().max(2048).optional(), limit: z.coerce.number().int().positive().max(100).optional(), q: z.string().max(160).optional(), source: z.string().max(96).optional(), scope: z.enum(['user', 'project']).optional(), candidateId: id.optional(), requestId: id.optional(), snapshotId: id.optional(), operationId: id.optional() }).strict();
export const SkillImportDeviceRevokeSchema = z.object({ challengeId: id, signature: base64url.min(16).max(4096) }).strict();
export const SkillImportCommandCursorSchema = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0);
const eventBase = { eventId: id, commandId: id.nullable(), sequence: z.number().int().nonnegative() };
const commandType = z.enum(['scan', 'preview', 'package-selected', 'cancel']);
export const SkillImportEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('command-started'), payload: z.object({ type: commandType }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('progress'), payload: z.object({ phase: z.enum(['scanning', 'previewing', 'packaging', 'uploading']), completed: z.number().int().nonnegative(), total: z.number().int().positive().optional() }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('candidates'), payload: z.object({ items: z.array(SkillImportCandidateSchema).max(500), final: z.boolean() }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('preview'), payload: SkillImportPreviewResultSchema }).strict(),
  z.object({ ...eventBase, type: z.literal('files'), payload: z.object({ requestId: id, candidateId: id, snapshotId: id, cursor: id, files: z.array(SkillImportFileSchema).max(100), nextFilesCursor: id.nullable() }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('command-completed'), payload: z.object({ type: commandType }).strict() }).strict(),
  z.object({ ...eventBase, type: z.literal('error'), payload: z.object({ code: z.enum(['CANDIDATE_CHANGED', 'SNAPSHOT_EXPIRED', 'PERMISSION_DENIED', 'SCAN_FAILED', 'PACKAGE_REJECTED', 'CLIENT_BUSY']), message: z.string().min(1).max(512), retryable: z.boolean() }).strict() }).strict(),
]);
type EventBase = { eventId: string; commandId: string | null; sequence: number };
type CommandType = 'scan' | 'preview' | 'package-selected' | 'cancel';
export type SkillImportEvent = EventBase & (
  | { type: 'command-started' | 'command-completed'; payload: { type: CommandType } }
  | { type: 'progress'; payload: { phase: 'scanning' | 'previewing' | 'packaging' | 'uploading'; completed: number; total?: number } }
  | { type: 'candidates'; payload: { items: SkillImportCandidate[]; final: boolean } }
  | { type: 'preview'; payload: SkillImportPreviewResult }
  | { type: 'files'; payload: { requestId: string; candidateId: string; snapshotId: string; cursor: string; files: z.infer<typeof SkillImportFileSchema>[]; nextFilesCursor: string | null } }
  | { type: 'error'; payload: { code: string; message: string; retryable: boolean } }
);
export const SkillImportOperationSchema = z.object({ operationId: id, status: z.enum(['pending', 'processing', 'succeeded', 'failed']), retryable: z.boolean(), sha256: hash.nullable(), errorCode: z.string().max(96).nullable(), expiresAt: date }).strict();
export const SkillImportArtifactSchema = z.object({ zipPath: z.string().min(1).max(1024), sha256: hash, fileCount: z.number().int().positive(), totalSize: z.number().int().positive(), filename: z.string().max(1024), content: SkillContentSchema, suggested: z.object({ name: z.string().nullable(), description: z.string().nullable() }).strict(), warnings: z.array(z.object({ code: z.string(), message: z.string() }).passthrough()).max(1000) }).strict();
export type SkillImportArtifact = z.infer<typeof SkillImportArtifactSchema>;
export const SkillImportPairingSummarySchema = z.object({ pairingId: id, keyFingerprint: hash, shortCode: z.string().regex(/^\d{6}$/), label: z.string(), platform: z.string(), clientVersion: z.string(), expiresAt: date, webConfirmed: z.boolean() }).strict();
export const SkillImportSessionViewSchema = z.object({ id, status: SkillImportStatusSchema, version: z.number().int().nonnegative(), protocolVersion: z.literal(1), instanceId: z.string(), expiresAt: date, idleExpiresAt: date, deepLink: z.string(), artifactReady: z.boolean(), candidateCount: z.number().int().nonnegative(), progress: z.object({ phase: z.string(), completed: z.number().int().nonnegative(), total: z.number().int().positive().optional() }).strict().nullable(), pairings: z.array(SkillImportPairingSummarySchema).max(3), operation: SkillImportOperationSchema.nullable() }).strict();
export type SkillImportSessionView = z.infer<typeof SkillImportSessionViewSchema>;
export const SkillImportCandidatesResponseSchema = SkillImportSessionViewSchema.extend({ items: z.array(SkillImportCandidateSchema).max(25), nextCursor: z.string().nullable() }).strict();
export const SkillImportPreviewResponseSchema = SkillImportSessionViewSchema.extend({ previewStatus: z.enum(['pending', 'ready', 'superseded', 'failed', 'none']), preview: SkillImportPreviewResultSchema.nullable(), errorCode: z.string().nullable() }).strict();
export const SkillImportFilesResponseSchema = z.object({ snapshotId: id, files: z.array(SkillImportFileSchema).max(100), nextFilesCursor: z.string().nullable() }).strict();
export const SkillImportOperationResponseSchema = SkillImportSessionViewSchema.extend({ artifact: SkillImportArtifactSchema.nullable() }).strict();
export const SkillImportDeviceSchema = z.object({ deviceId: id, keyFingerprint: hash, label: z.string(), platform: z.string(), clientVersion: z.string(), lastSeenAt: date.nullable(), createdAt: date }).strict();
export const SkillImportDeviceQuerySchema = z.object({ limit: z.coerce.number().int().positive().max(100).default(25), cursor: id.optional() }).strict();
export const SkillImportDevicesResponseSchema = z.object({ items: z.array(SkillImportDeviceSchema).max(100), nextCursor: id.nullable() }).strict();
