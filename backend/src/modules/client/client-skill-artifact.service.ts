import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SkillVersion } from '@prisma/client';
import { ClientSkillArtifact, ClientSkillArtifactParams } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { SkillPackageService } from '../skill-package/skill-package.service';
import { prepareSkillArtifact } from '../skill-package/skill-artifact-preparation';
import { SkillVersionService } from '../skill-version/skill-version.service';
import { clientSubscriptionAccessWhere } from './client-subscription-access';

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

  assertEmployeeSubscriptionsReady(employeeId: string, db: Prisma.TransactionClient) {
    return this.skillVersions.assertEmployeeSubscriptionsReady(employeeId, db);
  }

  private prepare(subscriptionId: string, capabilityId: string, version: SkillVersion) {
    return prepareSkillArtifact(this.packages, subscriptionId, capabilityId, version);
  }
}
