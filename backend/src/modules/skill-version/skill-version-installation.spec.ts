import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SkillVersionService } from './skill-version.service';

const version = (capabilityId: string, name: string, changes: Record<string, unknown> = {}) => ({
  id: 'v-' + capabilityId, capabilityId, scope: 'PLATFORM', status: 'PLATFORM_APPROVED',
  enterpriseId: null, version: '1.0.0', packageKey: null, packageSha256: null,
  content: '---\nname: ' + name + '\ndescription: Skill\n---\nApproved body.\n', ...changes,
});

function build() {
  const candidate = version('cap-1', 'first');
  const fallback = version('cap-2', 'second');
  const subscription = { id: 'sub-1', employeeId: 'emp-1', enterpriseId: 'ent-1' };
  const prisma = {
    capability: { findUnique: jest.fn().mockResolvedValue({ status: 'APPROVED' }) },
    skillVersion: { findUnique: jest.fn().mockResolvedValue(candidate), findFirst: jest.fn().mockResolvedValue(fallback) },
    subscription: {
      findFirst: jest.fn().mockResolvedValue(subscription),
      findMany: jest.fn().mockResolvedValue([subscription]),
      findUnique: jest.fn().mockResolvedValue({ ...subscription, employee: { bindings: [{ defaultSkillVersion: fallback }] } }),
    },
    employeeCapabilityBinding: { findFirst: jest.fn().mockResolvedValue({ id: 'binding-1' }),
      findMany: jest.fn().mockResolvedValue([{ capabilityId: 'cap-1' }, { capabilityId: 'cap-2' }]) },
    subscriptionSkillVersion: { findUnique: jest.fn().mockResolvedValue(null) },
    enterpriseMember: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((action) => action(prisma));
  const defaults = { lock: jest.fn(), set: jest.fn(), get: jest.fn().mockResolvedValue(null) };
  const context = { resolve: jest.fn().mockResolvedValue({ enterpriseId: 'ent-1', role: 'ENTERPRISE_ADMIN' }), assertEnterpriseAdmin: jest.fn() };
  const packages = { readInstallablePackage: jest.fn() };
  const service = new SkillVersionService(prisma as never, context as never, defaults as never, undefined, undefined, undefined, packages as never);
  const select = () => service.selectVersion('admin-1', 'sub-1', 'cap-1', candidate.id);
  return { prisma, defaults, packages, service, select, candidate, fallback };
}

describe('Skill version installation gates', () => {
  it('validates the candidate even when it affects no current subscriptions', async () => {
    const { prisma, defaults, select, candidate } = build();
    prisma.subscription.findMany.mockResolvedValue([]);
    prisma.skillVersion.findUnique.mockResolvedValue({ ...candidate, content: '' });
    await expect(select()).rejects.toMatchObject({ response: { code: 'SKILL_ARTIFACT_BLOCKED', reason: 'INVALID_ENTRY' } });
    expect(defaults.set).not.toHaveBeenCalled();
  });

  it('rejects a package whose approved body does not match the installable bytes', async () => {
    const { prisma, defaults, packages, select, candidate } = build();
    const hash = 'a'.repeat(64);
    prisma.skillVersion.findUnique.mockResolvedValue({ ...candidate, packageKey: 'skills/' + hash + '.zip', packageSha256: hash });
    packages.readInstallablePackage.mockResolvedValue({ content: 'Different body' });
    await expect(select()).rejects.toMatchObject({ response: { reason: 'PACKAGE_CONTENT_MISMATCH' } });
    expect(defaults.set).not.toHaveBeenCalled();
  });

  it('checks the other capability enterprise override instead of its template default', async () => {
    const { defaults, select } = build();
    defaults.get.mockResolvedValue({ version: version('cap-2', 'FIRST', { scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED', enterpriseId: 'ent-1' }) });
    await expect(select()).rejects.toMatchObject({ response: { code: 'SKILL_INSTALLATION_CONFLICT', subscriptionId: 'sub-1' } });
    expect(defaults.set).not.toHaveBeenCalled();
  });

  it('checks subscription selections when no enterprise default exists', async () => {
    const { prisma, defaults, select } = build();
    prisma.subscriptionSkillVersion.findUnique.mockResolvedValue({ version: version('cap-2', 'first') });
    await expect(select()).rejects.toThrow('安装目录冲突');
    expect(defaults.set).not.toHaveBeenCalled();
  });

  it('allows distinct actual directories and saves only after transactional checks', async () => {
    const { prisma, defaults, select, candidate } = build();
    await expect(select()).resolves.toMatchObject({ versionId: candidate.id });
    expect(defaults.set).toHaveBeenCalledTimes(1);
    expect(defaults.get).toHaveBeenCalledWith('ent-1', 'cap-2', prisma);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable', timeout: 30_000 });
    expect(prisma.employeeCapabilityBinding.findMany.mock.invocationCallOrder[0]).toBeLessThan(defaults.set.mock.invocationCallOrder[0]);
  });

  it('rechecks approval after taking the selection lock', async () => {
    const { prisma, defaults, select, candidate } = build();
    prisma.skillVersion.findUnique.mockResolvedValueOnce(candidate).mockResolvedValueOnce({ ...candidate, status: 'DRAFT' });
    await expect(select()).rejects.toBeInstanceOf(BadRequestException);
    expect(defaults.set).not.toHaveBeenCalled();
  });

  it('converts serializable conflicts into a retryable HTTP conflict', async () => {
    const { prisma, select } = build();
    prisma.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' }));
    await expect(select()).rejects.toBeInstanceOf(ConflictException);
  });

  it('blocks employee changes when an actual enterprise version is not installable', async () => {
    const { prisma, defaults, service } = build();
    defaults.get.mockResolvedValue({ version: version('cap-1', 'first', { content: '' }) });
    await expect(service.assertEmployeeSubscriptionsReady('emp-1', prisma as never)).rejects.toMatchObject({ response: { reason: 'INVALID_ENTRY' } });
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ employeeId: 'emp-1', status: 'ACTIVE' }) }));
  });
});
