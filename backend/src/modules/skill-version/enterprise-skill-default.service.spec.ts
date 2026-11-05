import { EnterpriseSkillDefaultService } from './enterprise-skill-default.service';
import { Prisma } from '@prisma/client';

describe('EnterpriseSkillDefaultService', () => {
  const now = new Date('2026-10-09T08:00:00.000Z');

  function build() {
    const prisma = {
      enterpriseSkillDefault: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      enterpriseSkillDefault: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'default-1' }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
      subscription: { findMany: jest.fn().mockResolvedValue([{ id: 'sub-1' }, { id: 'sub-2' }]) },
      subscriptionSkillVersion: { upsert: jest.fn().mockResolvedValue({ id: 'selection-1' }) },
      memberSkillVersionSelection: { upsert: jest.fn(), updateMany: jest.fn() },
    };
    const service = new EnterpriseSkillDefaultService(prisma as never);
    return { service, prisma, tx };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('schema', () => {
    it('uses an optional dedicated working-copy relation for immutable review snapshots', () => {
      const model = Prisma.dmmf.datamodel.models.find(({ name }) => name === 'SkillVersion');
      expect(model).toBeDefined();
      expect(model!.fields.find(({ name }) => name === 'workingCopyId')).toEqual(expect.objectContaining({
        kind: 'scalar', type: 'String', isRequired: false,
      }));
      expect(model!.fields.find(({ name }) => name === 'workingCopyUpdatedAt')).toEqual(expect.objectContaining({
        kind: 'scalar', type: 'DateTime', isRequired: false,
      }));
      expect(model!.fields.find(({ name }) => name === 'workingCopy')).toEqual(expect.objectContaining({
        kind: 'object', type: 'SkillVersion', isRequired: false,
        relationName: 'SkillWorkingCopySnapshots',
        relationFromFields: ['workingCopyId'], relationToFields: ['id'], relationOnDelete: 'SetNull',
      }));
      expect(model!.fields.find(({ name }) => name === 'reviewSnapshots')).toEqual(expect.objectContaining({
        kind: 'object', type: 'SkillVersion', isList: true, relationName: 'SkillWorkingCopySnapshots',
      }));
    });

    it('persists one default per enterprise and capability with required version and selector relations', () => {
      const model = Prisma.dmmf.datamodel.models.find(({ name }) => name === 'EnterpriseSkillDefault');
      expect(model).toEqual(expect.objectContaining({
        dbName: 'enterprise_skill_defaults', uniqueFields: [['enterpriseId', 'capabilityId']],
      }));
      expect(model!.fields.find(({ name }) => name === 'id')).toEqual(expect.objectContaining({
        isId: true, default: expect.objectContaining({ name: 'cuid' }),
      }));
      for (const name of ['enterprise', 'capability', 'version', 'selectedBy']) {
        expect(model!.fields.find((field) => field.name === name)).toEqual(expect.objectContaining({
          kind: 'object', isRequired: true,
        }));
      }
      expect(model!.fields.find(({ name }) => name === 'updatedAt')).toEqual(expect.objectContaining({
        isUpdatedAt: true,
      }));
    });
  });

  describe('lock', () => {
    it('uses a parameterized transaction-scoped lock without decoding a void result', async () => {
      const { service, tx } = build();
      await expect(service.lock(tx as never, 'ent-1', 'cap-1')).resolves.toBeUndefined();

      const [strings, key] = tx.$executeRaw.mock.calls[0];
      expect(strings.join('?')).toBe('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))');
      expect(key).toBe(JSON.stringify(['enterprise-skill-default', 'ent-1', 'cap-1']));
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('keeps enterprise and skill boundaries unambiguous and input out of SQL text', async () => {
      const { service, tx } = build();
      await service.lock(tx as never, 'a:b', 'c');
      await service.lock(tx as never, 'a', 'b:c');
      await service.lock(tx as never, "enterprise'; DROP TABLE users; --", 'cap-1');

      const calls = tx.$executeRaw.mock.calls;
      expect(calls[0][1]).not.toBe(calls[1][1]);
      expect(calls[2][0].join('')).not.toContain('DROP TABLE');
      expect(JSON.parse(calls[2][1])).toEqual([
        'enterprise-skill-default', "enterprise'; DROP TABLE users; --", 'cap-1',
      ]);
    });

    it('propagates a lock failure', async () => {
      const { service, tx } = build();
      const failure = new Error('lock unavailable');
      tx.$executeRaw.mockRejectedValue(failure);
      await expect(service.lock(tx as never, 'ent-1', 'cap-1')).rejects.toBe(failure);
    });
  });

  describe('set', () => {
    it('records the actor, time and before/after version in the same transaction', async () => {
      const { service, tx } = build();
      tx.enterpriseSkillDefault.findUnique.mockResolvedValue({ versionId: 'version-1' });
      await service.set(tx as never, 'ent-1', 'cap-1', 'version-2', 'admin-1');
      expect(tx.auditLog.create).toHaveBeenCalledWith({ data: {
        actorId: 'admin-1', enterpriseId: 'ent-1', action: 'SKILL_VERSION_ENABLED',
        resourceType: 'capability', resourceId: 'cap-1',
        metadata: { previousVersionId: 'version-1', versionId: 'version-2', selectedAt: now.toISOString(), affectedSubscriptions: 2 },
      } });
    });

    it('does not invent a switch when enabling the same version again', async () => {
      const { service, tx } = build();
      tx.enterpriseSkillDefault.findUnique.mockResolvedValue({ versionId: 'version-2' });
      await service.set(tx as never, 'ent-1', 'cap-1', 'version-2', 'admin-1');
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(tx.subscriptionSkillVersion.upsert).toHaveBeenCalledTimes(2);
    });

    it('propagates an audit failure so the caller rolls back the entire switch', async () => {
      const { service, tx } = build();
      const failure = new Error('audit unavailable');
      tx.auditLog.create.mockRejectedValue(failure);
      await expect(service.set(tx as never, 'ent-1', 'cap-1', 'version-2', 'admin-1')).rejects.toBe(failure);
    });

    it('persists the enterprise default and synchronizes all eligible subscription selections', async () => {
      const { service, tx } = build();
      await expect(service.set(tx as never, 'ent-1', 'cap-1', 'version-2', 'admin-1'))
        .resolves.toEqual({ affectedSubscriptions: 2 });

      const selection = { versionId: 'version-2', selectedById: 'admin-1', selectedAt: now };
      expect(tx.enterpriseSkillDefault.upsert).toHaveBeenCalledWith({
        where: { enterpriseId_capabilityId: { enterpriseId: 'ent-1', capabilityId: 'cap-1' } },
        create: { enterpriseId: 'ent-1', capabilityId: 'cap-1', ...selection },
        update: selection,
      });
      expect(tx.subscription.findMany).toHaveBeenCalledWith({
        where: {
          enterpriseId: 'ent-1', status: 'ACTIVE',
          OR: [{ endDate: null }, { endDate: { gt: now } }],
          employee: { bindings: { some: {
            capabilityId: 'cap-1', enabled: true, capability: { type: 'SKILL', status: 'APPROVED' },
          } } },
        },
        select: { id: true },
      });
      for (const subscriptionId of ['sub-1', 'sub-2']) {
        expect(tx.subscriptionSkillVersion.upsert).toHaveBeenCalledWith({
          where: { subscriptionId_capabilityId: { subscriptionId, capabilityId: 'cap-1' } },
          create: { subscriptionId, capabilityId: 'cap-1', ...selection },
          update: selection,
        });
      }
      expect(tx.subscriptionSkillVersion.upsert).toHaveBeenCalledTimes(2);
      expect(tx.memberSkillVersionSelection.upsert).not.toHaveBeenCalled();
      expect(tx.memberSkillVersionSelection.updateMany).not.toHaveBeenCalled();
    });

    it('persists a default even when no active subscription currently uses the skill', async () => {
      const { service, tx } = build();
      tx.subscription.findMany.mockResolvedValue([]);
      await expect(service.set(tx as never, 'ent-1', 'cap-1', 'version-2', 'admin-1'))
        .resolves.toEqual({ affectedSubscriptions: 0 });
      expect(tx.enterpriseSkillDefault.upsert).toHaveBeenCalledTimes(1);
      expect(tx.subscriptionSkillVersion.upsert).not.toHaveBeenCalled();
    });

    it('supports changing the default back to a preserved historical version', async () => {
      const { service, tx } = build();
      await service.set(tx as never, 'ent-1', 'cap-1', 'version-2', 'admin-1');
      await service.set(tx as never, 'ent-1', 'cap-1', 'version-1', 'admin-2');
      expect(tx.enterpriseSkillDefault.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
        update: { versionId: 'version-1', selectedById: 'admin-2', selectedAt: now },
      }));
      expect(tx.subscriptionSkillVersion.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
        update: { versionId: 'version-1', selectedById: 'admin-2', selectedAt: now },
      }));
    });

    it('propagates persistence failures before subscription synchronization', async () => {
      const { service, tx } = build();
      const failure = new Error('default unavailable');
      tx.enterpriseSkillDefault.upsert.mockRejectedValue(failure);
      await expect(service.set(tx as never, 'ent-1', 'cap-1', 'version-2', 'admin-1'))
        .rejects.toBe(failure);
      expect(tx.subscription.findMany).not.toHaveBeenCalled();
      expect(tx.subscriptionSkillVersion.upsert).not.toHaveBeenCalled();
    });

    it('propagates subscription synchronization failures to the enclosing transaction', async () => {
      const { service, tx } = build();
      const failure = new Error('selection unavailable');
      tx.subscriptionSkillVersion.upsert.mockRejectedValue(failure);
      await expect(service.set(tx as never, 'ent-1', 'cap-1', 'version-2', 'admin-1'))
        .rejects.toBe(failure);
      expect(tx.subscriptionSkillVersion.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('get', () => {
    it('returns the persistent default with its version for new subscriptions', async () => {
      const { service, prisma } = build();
      const saved = { id: 'default-1', version: { id: 'version-2', content: '# Skill' } };
      prisma.enterpriseSkillDefault.findUnique.mockResolvedValue(saved);
      await expect(service.get('ent-1', 'cap-1')).resolves.toBe(saved);
      expect(prisma.enterpriseSkillDefault.findUnique).toHaveBeenCalledWith({
        where: { enterpriseId_capabilityId: { enterpriseId: 'ent-1', capabilityId: 'cap-1' } },
        include: { version: true },
      });
    });

    it('returns null when the enterprise has no persistent default for the skill', async () => {
      const { service } = build();
      await expect(service.get('ent-2', 'cap-1')).resolves.toBeNull();
    });

    it('propagates lookup failures instead of falling back to an unrelated default', async () => {
      const { service, prisma } = build();
      const failure = new Error('lookup unavailable');
      prisma.enterpriseSkillDefault.findUnique.mockRejectedValue(failure);
      await expect(service.get('ent-1', 'cap-1')).rejects.toBe(failure);
    });
  });
});
