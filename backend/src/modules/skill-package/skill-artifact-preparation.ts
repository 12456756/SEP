import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { SkillVersion } from '@prisma/client';
import { createHash } from 'crypto';
import { ClientSkillArtifactAvailableSchema } from 'shared';
import type { ClientSkillArtifactAvailable, ClientSkillArtifactBlocked, SkillArtifactBlockedReason } from 'shared';
import { prepareSkillMarkdown } from '../../shared/skill-content';
import type { SkillPackageService } from './skill-package.service';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export type PreparedSkillArtifact =
  | { descriptor: ClientSkillArtifactAvailable; buffer: Buffer }
  | { descriptor: ClientSkillArtifactBlocked };

// Shared by runtime/download and version activation, without depending on version resolution.
export async function prepareSkillArtifact(
  packages: Pick<SkillPackageService, 'readInstallablePackage'> | undefined,
  subscriptionId: string, capabilityId: string, version: SkillVersion,
): Promise<PreparedSkillArtifact> {
  const identity = { protocolVersion: 1 as const, capabilityId, versionId: version.id, approvedContentSha256: sha256(version.content) };
  const blocked = (reason: SkillArtifactBlockedReason): PreparedSkillArtifact =>
    ({ descriptor: { ...identity, status: 'BLOCKED', reason } });
  const available = (buffer: Buffer, fields: Pick<ClientSkillArtifactAvailable,
    'format' | 'installationDirectory' | 'entryPath' | 'entrySha256' | 'fileCount'>): PreparedSkillArtifact => {
    const result = ClientSkillArtifactAvailableSchema.safeParse({ ...identity, status: 'AVAILABLE', ...fields,
      artifactSha256: sha256(buffer), byteLength: buffer.length,
      downloadPath: `/client/subscriptions/${encodeURIComponent(subscriptionId)}/skills/${encodeURIComponent(capabilityId)}/versions/${encodeURIComponent(version.id)}/artifact`,
    });
    return result.success ? { buffer, descriptor: result.data } : blocked('INVALID_ENTRY');
  };
  if (version.packageKey || version.packageSha256) {
    if (!version.packageSha256 || version.packageKey !== `skills/${version.packageSha256}.zip`) return blocked('PACKAGE_UNAVAILABLE');
    if (!packages) throw new ServiceUnavailableException('Skill package service unavailable');
    try {
      const pkg = await packages.readInstallablePackage(version.packageSha256);
      if (pkg.content !== version.content) return blocked('PACKAGE_CONTENT_MISMATCH');
      return available(pkg.buffer, { format: 'zip', installationDirectory: pkg.skillName,
        entryPath: pkg.entryPath, entrySha256: pkg.entrySha256, fileCount: pkg.fileCount });
    } catch (error) {
      if (error instanceof NotFoundException) return blocked('PACKAGE_UNAVAILABLE');
      if (error instanceof BadRequestException) return blocked('INVALID_ENTRY');
      throw new ServiceUnavailableException('Skill package storage temporarily unavailable');
    }
  }
  const prepared = prepareSkillMarkdown(version.content, `sep-${sha256(capabilityId).slice(0, 24)}`);
  if (prepared.status === 'BLOCKED') return blocked(prepared.reason);
  const buffer = Buffer.from(prepared.content, 'utf8');
  return available(buffer, { format: 'single-file', installationDirectory: prepared.skillName,
    entryPath: 'SKILL.md', entrySha256: sha256(buffer), fileCount: 1 });
}
