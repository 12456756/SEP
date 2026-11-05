import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DigitalEmployee, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientSkillArtifactService } from '../client/client-skill-artifact.service';

@Injectable()
export class EmployeeReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly artifacts: ClientSkillArtifactService,
  ) {}

  async withEmployeeLock<T>(
    employeeId: string,
    action: (tx: Prisma.TransactionClient, employee: DigitalEmployee) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // All employee publication/binding writers share this lock, including draft edits.
        await tx.$queryRaw`SELECT id FROM digital_employees WHERE id = ${employeeId} FOR UPDATE`;
        const employee = await tx.digitalEmployee.findUnique({ where: { id: employeeId } });
        if (!employee) throw new NotFoundException('员工不存在');
        return action(tx, employee);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('员工状态、能力或版本已发生变化，请重新检查后再提交');
      }
      throw error;
    }
  }

  async assertReady(employeeId: string, db: Prisma.TransactionClient = this.prisma): Promise<void> {
    const bindings = await db.employeeCapabilityBinding.findMany({
      where: { employeeId, enabled: true },
      include: { capability: true, defaultSkillVersion: true },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
    const failures: Array<{ capabilityId?: string; capabilityName: string; reason: string }> = [];
    const directories = new Map<string, { capabilityId: string; capabilityName: string }>();
    if (!bindings.length) failures.push({ capabilityName: '员工', reason: '至少需要一个已启用能力' });

    for (const binding of bindings) {
      const capability = binding.capability;
      const fail = (reason: string) => failures.push({ capabilityId: binding.capabilityId, capabilityName: capability.name, reason });
      if (capability.status !== 'APPROVED') {
        fail(`能力未批准 (${capability.status})`);
        continue;
      }
      // Preserve the existing public boundary for legacy, platform-owned capabilities.
      if (capability.enterpriseId != null && (
        capability.visibility !== 'MARKET_PUBLIC' || capability.platformReviewStatus !== 'APPROVED'
      )) {
        fail('企业能力未通过平台审核并公开到市场');
        continue;
      }
      if (capability.type !== 'SKILL') continue;

      let version = binding.defaultSkillVersion;
      if (binding.defaultSkillVersionId) {
        if (!version || version.id !== binding.defaultSkillVersionId || version.capabilityId !== binding.capabilityId ||
          version.scope !== 'PLATFORM' || version.status !== 'PLATFORM_APPROVED') {
          fail('绑定默认版本不是该能力的已批准平台版本');
          continue;
        }
      } else {
        version = await db.skillVersion.findFirst({
          where: { capabilityId: binding.capabilityId, scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
          orderBy: [
            { platformReviewedAt: { sort: 'desc', nulls: 'last' } },
            { createdAt: 'desc' }, { id: 'desc' },
          ],
        });
      }
      if (!version) {
        fail('缺少已批准平台版本');
        continue;
      }

      // Use the real installer descriptor, not a separate readiness-only validator.
      const artifact = await this.artifacts.describe(employeeId, binding.capabilityId, version);
      if (artifact.status === 'BLOCKED') {
        fail(`技能制品不可安装 (${artifact.reason})`);
        continue;
      }
      const directory = artifact.installationDirectory.normalize('NFKC').toLowerCase();
      const previous = directories.get(directory);
      if (previous) {
        failures.push({ ...previous, reason: `安装目录与「${capability.name}」冲突 (${artifact.installationDirectory})` });
        fail(`安装目录与「${previous.capabilityName}」冲突 (${artifact.installationDirectory})`);
      } else {
        directories.set(directory, { capabilityId: binding.capabilityId, capabilityName: capability.name });
      }
    }

    if (failures.length) {
      throw new BadRequestException({
        code: 'EMPLOYEE_NOT_READY',
        message: `员工不可上架：${failures.map((item) => `${item.capabilityName}：${item.reason}`).join('；')}`,
        failures,
      });
    }
    await this.artifacts.assertEmployeeSubscriptionsReady(employeeId, db);
  }
}
