import { z } from 'zod';
import {
  CLIENT_SKILL_ARTIFACT_MAX_BYTES,
  CLIENT_SKILL_ARTIFACT_MAX_FILES,
  SKILL_PACKAGE_MAX_BYTES,
  SKILL_PACKAGE_MAX_ENTRIES,
} from './skill-content-schema';

export const SkillArtifactSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export function isSafeSkillPathComponent(value: string): boolean {
  return [value, value.normalize('NFKC')].every((part) => part.length > 0 && part !== '.' && part !== '..'
    && !/[\\/\x00-\x1f\x7f:<>"|?*]/.test(part) && !/[ .]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export const SkillArtifactNameSchema = z.string().refine((value) => {
  const safe = (name: string) => /^[\p{L}\p{N}]+(?:(?:-|\p{Zs}+)[\p{L}\p{N}]+)*$/u.test(name);
  return Array.from(value).length >= 1 && Array.from(value).length <= 64 &&
    safe(value) && safe(value.normalize('NFKC')) && isSafeSkillPathComponent(value);
}, '名称须为 1-64 个 Unicode 字母、数字、内部空格或非连续连字符，不能含路径、控制字符或 Windows 保留名');
const SkillArtifactIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const SkillArtifactFrontmatterSchema = z.object({
  name: SkillArtifactNameSchema,
  description: z.string().min(1).max(1024).refine((value) => value.trim().length > 0),
  license: z.string().optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
  'allowed-tools': z.string().optional(),
  'disable-model-invocation': z.boolean().optional(),
}).passthrough();

const identity = {
  protocolVersion: z.literal(1),
  capabilityId: SkillArtifactIdSchema,
  versionId: SkillArtifactIdSchema,
  approvedContentSha256: SkillArtifactSha256Schema,
};

export const SkillArtifactBlockedReasonSchema = z.enum([
  'INVALID_ENTRY', 'PACKAGE_REQUIRED', 'PACKAGE_UNAVAILABLE', 'PACKAGE_CONTENT_MISMATCH', 'CLIENT_LIMIT_EXCEEDED',
]);

export const ClientSkillArtifactAvailableSchema = z.object({
    ...identity,
    status: z.literal('AVAILABLE'),
    format: z.enum(['single-file', 'zip']),
    installationDirectory: SkillArtifactNameSchema,
    entryPath: z.string().max(1024).refine((value) => {
      const parts = value.split('/');
      return parts.at(-1) === 'SKILL.md' && parts.every(isSafeSkillPathComponent);
    }, '入口必须为安全相对路径'),
    entrySha256: SkillArtifactSha256Schema,
    artifactSha256: SkillArtifactSha256Schema,
    byteLength: z.number().int().positive().max(CLIENT_SKILL_ARTIFACT_MAX_BYTES),
    fileCount: z.number().int().positive().max(CLIENT_SKILL_ARTIFACT_MAX_FILES),
    downloadPath: z.string().regex(/^\/client\/subscriptions\/[a-zA-Z0-9_-]{1,128}\/skills\/[a-zA-Z0-9_-]{1,128}\/versions\/[a-zA-Z0-9_-]{1,128}\/artifact$/),
  }).strict();
export const ClientSkillArtifactBlockedSchema = z.object({
  ...identity,
  status: z.literal('BLOCKED'),
  reason: SkillArtifactBlockedReasonSchema,
  byteLength: z.number().int().positive().max(SKILL_PACKAGE_MAX_BYTES).optional(),
  fileCount: z.number().int().positive().max(SKILL_PACKAGE_MAX_ENTRIES).optional(),
}).strict();
export const ClientSkillArtifactSchema = z.union([
  ClientSkillArtifactAvailableSchema,
  ClientSkillArtifactBlockedSchema,
]).superRefine((artifact, ctx) => {
  if (artifact.status !== 'BLOCKED') return;
  const hasMetadata = artifact.byteLength !== undefined || artifact.fileCount !== undefined;
  const exceedsClientLimit = (artifact.byteLength ?? 0) > CLIENT_SKILL_ARTIFACT_MAX_BYTES ||
    (artifact.fileCount ?? 0) > CLIENT_SKILL_ARTIFACT_MAX_FILES;
  if (artifact.reason === 'CLIENT_LIMIT_EXCEEDED' ? !exceedsClientLimit : hasMetadata) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'Blocked artifact metadata does not match its reason.' });
  }
});
export type ClientSkillArtifact = z.infer<typeof ClientSkillArtifactSchema>;
export type ClientSkillArtifactAvailable = z.infer<typeof ClientSkillArtifactAvailableSchema>;
export type ClientSkillArtifactBlocked = z.infer<typeof ClientSkillArtifactBlockedSchema>;
export type SkillArtifactBlockedReason = z.infer<typeof SkillArtifactBlockedReasonSchema>;

export const ClientSkillArtifactParamsSchema = z.object({
  subscriptionId: SkillArtifactIdSchema,
  capabilityId: SkillArtifactIdSchema,
  versionId: SkillArtifactIdSchema,
}).strict();
export type ClientSkillArtifactParams = z.infer<typeof ClientSkillArtifactParamsSchema>;
