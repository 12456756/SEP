import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SkillVersion } from '@prisma/client';
import { createHash } from 'crypto';
import {
  ClientSkillArtifact, ClientSkillArtifactAvailable, ClientSkillArtifactBlocked, ClientSkillArtifactParams, ClientSkillArtifactAvailableSchema,
  SkillArtifactBlockedReason,
} from 'shared';
import { prepareSkillMarkdown } from '../../shared/skill-content';
import { PrismaService } from '../../prisma/prisma.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { SkillPackageService } from '../skill-package/skill-package.service';
import { SkillVersionService } from '../skill-version/skill-version.service';
import { clientSubscriptionAccessWhere } from './client-subscription-access';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type AvailableArtifact = ClientSkillArtifactAvailable;
type PreparedArtifact = { descriptor: AvailableArtifact; buffer: Buffer } | { descriptor: ClientSkillArtifactBlocked };

@Injectable()
export class ClientSkillArtifactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enterpriseContext: EnterpriseContextService,
    private readonly skillVersions: SkillVersionService,
    private readonly packages: SkillPackageService,
  ) {}

  async describe(subscriptionId: string, capabilityId: string, version: SkillVersion): Promise<ClientSkillArtifact> {
    return (await this.prepare(subscriptionId, capabilityId, version)).descriptor;
  }

  async download(userId: string, params: ClientSkillArtifactParams) {
    const ctx = await this.enterpriseContext.resolve(userId);
    const subscription = await this.prisma.subscription.findFirst({
      where: clientSubscriptionAccessWhere(ctx, params.subscriptionId),
      select: { id: true, employee: { select: { bindings: {
        where: { enabled: true, capabilityId: params.capabilityId, capability: { type: 'SKILL', status: 'APPROVED' } },
        select: { capabilityId: true },
      } } } },
    });
    if (!subscription || !subscription.employee.bindings.length) throw new NotFoundException('Skill artifact unavailable');
    const version = await this.skillVersions.resolveEffectiveVersion(subscription.id, params.capabilityId);
    if (!version || version.id !== params.versionId || version.capabilityId !== params.capabilityId || !(
      (version.scope === 'PLATFORM' && version.status === 'PLATFORM_APPROVED') ||
      (version.scope === 'ENTERPRISE' && version.status === 'ENTERPRISE_APPROVED' && version.enterpriseId === ctx.enterpriseId)
    )) throw new NotFoundException('Skill artifact unavailable');

    const artifact = await this.prepare(subscription.id, params.capabilityId, version);
    if (!('buffer' in artifact)) {
      throw new ConflictException({ message: 'Skill artifact is not installable', code: 'SKILL_ARTIFACT_BLOCKED', reason: artifact.descriptor.reason });
    }
    return { descriptor: artifact.descriptor, buffer: artifact.buffer };
  }

  private async prepare(subscriptionId: string, capabilityId: string, version: SkillVersion): Promise<PreparedArtifact> {
    const identity = { protocolVersion: 1 as const, capabilityId, versionId: version.id, approvedContentSha256: sha256(version.content) };
    const blocked = (reason: SkillArtifactBlockedReason): PreparedArtifact => ({ descriptor: { ...identity, status: 'BLOCKED', reason } });
    const available = (buffer: Buffer, fields: Pick<AvailableArtifact, 'format' | 'installationDirectory' | 'entryPath' | 'entrySha256' | 'fileCount'>): PreparedArtifact => {
      const result = ClientSkillArtifactAvailableSchema.safeParse({ ...identity, status: 'AVAILABLE', ...fields,
        artifactSha256: sha256(buffer), byteLength: buffer.length,
        downloadPath: `/client/subscriptions/${encodeURIComponent(subscriptionId)}/skills/${encodeURIComponent(capabilityId)}/versions/${encodeURIComponent(version.id)}/artifact`,
      });
      return result.success ? { buffer, descriptor: result.data } : blocked('INVALID_ENTRY');
    };

    if (version.packageKey || version.packageSha256) {
      if (!version.packageSha256 || version.packageKey !== `skills/${version.packageSha256}.zip`) return blocked('PACKAGE_UNAVAILABLE');
      try {
        const pkg = await this.packages.readInstallablePackage(version.packageSha256);
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
}
