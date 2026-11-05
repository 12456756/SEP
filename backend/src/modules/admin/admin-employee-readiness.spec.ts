import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { DigitalEmployeeService } from '../digital-employee/digital-employee.service';
import { EmployeeReadinessService } from '../digital-employee/employee-readiness.service';
import { ClientSkillArtifactService } from '../client/client-skill-artifact.service';

const makeCapability = (id: string) => ({
  id, name: `能力-${id}`, type: 'SKILL', status: 'APPROVED', enterpriseId: null,
  visibility: 'ENTERPRISE_PRIVATE', platformReviewStatus: 'NOT_SUBMITTED',
});
const makeVersion = (capabilityId: string, content = 'Generate a product description.') => ({
  id: `version-${capabilityId}`, capabilityId, content, scope: 'PLATFORM', status: 'PLATFORM_APPROVED',
  packageKey: null, packageSha256: null,
});
const makeBinding = (capabilityId: string, enabled = true) => ({
  id: `binding-${capabilityId}`, employeeId: 'emp-1', capabilityId, enabled, priority: 0,
  defaultSkillVersionId: null, defaultSkillVersion: null,
});

describe('Employee publication and binding readiness protection', () => {
  let state: { employee: any; bindings: any[] };
  let capabilities: any[];
  let versions: any[];
  let prisma: any;
  let admin: AdminService;
  let digital: DigitalEmployeeService;
  let readiness: EmployeeReadinessService;

  beforeEach(() => {
    capabilities = [makeCapability('cap-1'), makeCapability('cap-2')];
    versions = [makeVersion('cap-1'), makeVersion('cap-2')];
    state = { employee: { id: 'emp-1', status: 'DRAFT', publishedAt: null }, bindings: [makeBinding('cap-1')] };
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'emp-1' }]),
      digitalEmployee: {
        findUnique: jest.fn(async () => state.employee),
        create: jest.fn(async ({ data }) => { state.employee = { ...data, id: 'new-emp', status: 'DRAFT' }; return state.employee; }),
        update: jest.fn(async ({ data }) => { state.employee = { ...state.employee, ...data }; return state.employee; }),
      },
      capability: {
        findMany: jest.fn(async ({ where }) => capabilities.filter((item) => where.id.in.includes(item.id))),
        findUnique: jest.fn(async ({ where }) => capabilities.find((item) => item.id === where.id) ?? null),
      },
      skillVersion: {
        findFirst: jest.fn(async ({ where }) => versions.find((item) => item.capabilityId === where.capabilityId && item.scope === where.scope && item.status === where.status) ?? null),
        findMany: jest.fn(async ({ where }) => versions.filter((item) => where.capabilityId.in.includes(item.capabilityId) && item.scope === where.scope && item.status === where.status)),
      },
      employeeCapabilityBinding: {
        findMany: jest.fn(async ({ where }) => state.bindings.filter((item) => item.employeeId === where.employeeId && item.enabled === where.enabled).map((item) => ({
          ...item, capability: capabilities.find((capability) => capability.id === item.capabilityId),
          defaultSkillVersion: versions.find((version) => version.id === item.defaultSkillVersionId) ?? null,
        }))),
        findUnique: jest.fn(async ({ where }) => state.bindings.find((item) => where.id ? item.id === where.id : item.capabilityId === where.employeeId_capabilityId.capabilityId) ?? null),
        create: jest.fn(async ({ data }) => { const item = { ...makeBinding(data.capabilityId), ...data }; state.bindings.push(item); return item; }),
        createMany: jest.fn(async ({ data }) => { state.bindings.push(...data.map((item) => ({ ...makeBinding(item.capabilityId), ...item }))); return { count: data.length }; }),
        deleteMany: jest.fn(async () => { const count = state.bindings.length; state.bindings = []; return { count }; }),
        delete: jest.fn(async ({ where }) => {
          const index = state.bindings.findIndex((item) => where.id ? item.id === where.id : item.capabilityId === where.employeeId_capabilityId.capabilityId);
          return state.bindings.splice(index, 1)[0];
        }),
        update: jest.fn(async ({ where, data }) => {
          const item = state.bindings.find((binding) => binding.id === where.id);
          Object.assign(item, data);
          return item;
        }),
      },
      $transaction: jest.fn(async (action) => {
        const snapshot = structuredClone(state);
        try { return await action(prisma); } catch (error) { state = snapshot; throw error; }
      }),
    };
    const artifact = new ClientSkillArtifactService(prisma, {} as any, {} as any, {} as any);
    readiness = new EmployeeReadinessService(prisma, artifact);
    admin = new AdminService(prisma, {} as any, undefined, undefined, readiness);
    digital = new DigitalEmployeeService(prisma, {} as any, readiness);
  });

  const entries = ['approve', 'publish', 'update'] as const;
  const publish = (entry: typeof entries[number]) => {
    if (entry === 'approve') return admin.approveEmployee('emp-1', 'operator');
    if (entry === 'publish') return admin.publishEmployee('emp-1', 'operator');
    return digital.update('emp-1', { status: 'APPROVED' });
  };

  describe.each(entries)('%s entry', (entry) => {
    beforeEach(() => { state.employee.status = entry === 'approve' ? 'PENDING' : 'DRAFT'; });

    it.each(['missing', 'blocked', 'no-enabled', 'bad-pin', 'collision'])('does not write status or publishedAt when %s', async (failure) => {
      if (failure === 'missing') versions = [];
      if (failure === 'blocked') versions[0].content = '';
      if (failure === 'no-enabled') state.bindings[0].enabled = false;
      if (failure === 'bad-pin') state.bindings[0].defaultSkillVersionId = 'not-approved';
      if (failure === 'collision') {
        state.bindings.push(makeBinding('cap-2'));
        for (const item of versions) item.content = '---\nname: 商品描述\ndescription: 生成商品描述\n---\n生成描述。';
      }
      const snapshot = structuredClone(state);
      await expect(publish(entry)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.digitalEmployee.update).not.toHaveBeenCalled();
      expect(state).toEqual(snapshot);
    });

    it('publishes Chinese AVAILABLE entries while ignoring disabled invalid skills', async () => {
      versions[0].content = '---\nname: 商品描述\ndescription: 生成商品描述\n---\n生成描述。';
      versions[1].content = '';
      state.bindings.push(makeBinding('cap-2', false));
      await publish(entry);
      expect(state.employee.status).toBe('APPROVED');
      expect(state.employee.publishedAt).toBeInstanceOf(Date);
      expect(prisma.skillVersion.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('publishes instructions with unresolved documentation references', async () => {
      versions[0].content = '[Checklist](./checklist.md)';
      await publish(entry);
      expect(state.employee.status).toBe('APPROVED');
    });
  });

  it.each(['approve', 'publish'] as const)('confirms %s source state inside the lock before validation', async (entry) => {
    state.employee.status = 'ARCHIVED';
    await expect(publish(entry)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.employeeCapabilityBinding.findMany).not.toHaveBeenCalled();
    expect(prisma.digitalEmployee.update).not.toHaveBeenCalled();
  });

  it('fails closed when readiness was not injected', async () => {
    const service = new AdminService(prisma, {} as any);
    await expect(service.publishEmployee('emp-1', 'operator')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.digitalEmployee.update).not.toHaveBeenCalled();
  });

  const mutations = ['add', 'unbind', 'replace-empty', 'replace-blocked', 'disable', 'remove', 'enable-blocked'] as const;
  const mutate = (mutation: typeof mutations[number]) => {
    if (mutation === 'add') return digital.bindCapability('emp-1', { capabilityId: 'cap-2' });
    if (mutation === 'unbind') return digital.unbindCapability('emp-1', 'cap-1');
    if (mutation === 'replace-empty') return admin.bindCapabilities('emp-1', [], 'operator');
    if (mutation === 'replace-blocked') return admin.bindCapabilities('emp-1', ['cap-2'], 'operator');
    if (mutation === 'disable') return admin.updateBinding('binding-cap-1', { enabled: false });
    if (mutation === 'remove') return admin.removeBinding('binding-cap-1');
    return admin.updateBinding('binding-cap-2', { enabled: true });
  };

  it.each(mutations)('rolls back approved employee bindings after invalid %s', async (mutation) => {
    state.employee.status = 'APPROVED';
    versions[1].content = '';
    if (mutation === 'enable-blocked') state.bindings.push(makeBinding('cap-2', false));
    const snapshot = structuredClone(state);
    await expect(mutate(mutation)).rejects.toBeInstanceOf(BadRequestException);
    expect(state).toEqual(snapshot);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'Serializable' }));
  });

  it.each(mutations)('allows draft binding edits without installability gate: %s', async (mutation) => {
    versions = [];
    if (mutation === 'enable-blocked') state.bindings.push(makeBinding('cap-2', false));
    await mutate(mutation);
    expect(prisma.employeeCapabilityBinding.findMany).not.toHaveBeenCalled();
  });

  it('allows creating a DRAFT skill employee without a formal version', async () => {
    versions = [];
    await digital.create({
      name: '商品文案员工', description: '商品文案', industry: '电商', position: '运营',
      systemPrompt: '整理商品文案', modelId: 'model-1', maxSteps: 10, capabilityIds: ['cap-1'],
    });
    expect(state.employee.status).toBe('DRAFT');
    expect(prisma.employeeCapabilityBinding.findMany).not.toHaveBeenCalled();
  });

  it('allows removing one skill when another runnable skill remains', async () => {
    state.employee.status = 'APPROVED';
    state.bindings.push(makeBinding('cap-2'));
    await admin.removeBinding('binding-cap-1');
    expect(state.bindings.map((item) => item.capabilityId)).toEqual(['cap-2']);
  });

  it('does not rebind or re-enable an archived capability', async () => {
    capabilities[0].status = 'ARCHIVED';
    state.bindings[0].enabled = false;
    const snapshot = structuredClone(state);

    await expect(admin.bindCapabilities('emp-1', ['cap-1'], 'operator')).rejects.toBeInstanceOf(BadRequestException);
    await expect(admin.updateBinding('binding-cap-1', { enabled: true })).rejects.toBeInstanceOf(BadRequestException);

    expect(state).toEqual(snapshot);
    expect(prisma.employeeCapabilityBinding.createMany).not.toHaveBeenCalled();
    expect(prisma.employeeCapabilityBinding.update).not.toHaveBeenCalled();
  });

  it('uses runtime release ordering for admin replacement default versions', async () => {
    await admin.bindCapabilities('emp-1', ['cap-1'], 'operator');
    expect(prisma.skillVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ platformReviewedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    }));
    expect(state.bindings[0].defaultSkillVersionId).toBe('version-cap-1');
  });
});
