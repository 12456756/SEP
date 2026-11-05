import { SkillVersionService } from '../skill-version/skill-version.service';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClientService } from './client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { SettingService } from '../setting/setting.service';
import { JwtService } from '@nestjs/jwt';
import { withEmployeeAvatar } from '../../common/employee-avatar';
import { SessionService } from '../auth/session.service';
import { MemberAllowanceQueryService } from '../compute-credit/member-allowance-query.service';
import { PersonalWalletService } from '../personal-wallet/personal-wallet.service';
import { SubscriptionRequestService } from '../subscription-request/subscription-request.service';
import { GatewayModelPolicyService } from '../gateway/gateway-model-policy.service';
import { EnterpriseModelConfigService } from '../enterprise-model-config/enterprise-model-config.service';
import { MediaConfigService } from '../media-config/media-config.service';
import { MediaVideoConfigService } from '../media-config/media-video-config.service';
import { ClientSkillArtifactService } from './client-skill-artifact.service';
import { SkillPackageService } from '../skill-package/skill-package.service';
import { ClientSkillArtifactSchema, SkillArtifactBlockedReasonSchema } from '../../shared/client-skill-artifact.dto';

const artifactFixtures = JSON.parse(readFileSync(join(__dirname, '../../shared/fixtures/skill-artifact-v1.json'), 'utf8'));

describe('ClientService', () => {
  let service: ClientService;
  let prisma: any;
  let jwt: any;
  let sessions: any;
  let allowanceQuery: any;
  let personalWallet: any;
  let skillVersions: { resolveEffectiveVersion: jest.Mock };
  let modelPolicy: { resolvePolicy: jest.Mock };
  let mediaConfig: { getRuntimeMedia: jest.Mock; getRuntimeMediaV2: jest.Mock; getRuntimeMediaV3: jest.Mock };
  let videoConfig: { getRuntimeVideo: jest.Mock; getRuntimeVideoV2: jest.Mock; getRuntimeVideoV3: jest.Mock };
  let skillArtifacts: { describe: jest.Mock };

  beforeEach(async () => {
    prisma = {
      device: { findUnique: jest.fn(), upsert: jest.fn(), findMany: jest.fn() },
      user: { findUnique: jest.fn() },
      enterpriseMember: { findFirst: jest.fn() },
      employeeGrant: { findMany: jest.fn(), findFirst: jest.fn() },
      platformModel: { findMany: jest.fn() },
      enterpriseModelConfig: { findUnique: jest.fn() },
      subscription: { findFirst: jest.fn() },
      digitalEmployee: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    };
    jwt = { sign: jest.fn().mockReturnValue('access-token'), verify: jest.fn() };
    allowanceQuery = { getOne: jest.fn() };
    personalWallet = { getView: jest.fn() };
    skillVersions = { resolveEffectiveVersion: jest.fn().mockResolvedValue(null) };
    modelPolicy = { resolvePolicy: jest.fn().mockResolvedValue({ allowedModels: ['gpt-4o-mini'] }) };
    mediaConfig = { getRuntimeMedia: jest.fn().mockResolvedValue({ protocolVersion: 1, executionAvailable: false, tools: [], profiles: [], defaultProfileId: null }), getRuntimeMediaV2: jest.fn().mockResolvedValue({ protocolVersion: 2, executionAvailable: false, tools: [], profiles: [], defaultProfileId: null }), getRuntimeMediaV3: jest.fn().mockResolvedValue({ protocolVersion: 3, executionMode: 'disabled', executionAvailable: false, tools: [], profiles: [], defaultProfileId: null }) };
    videoConfig = { getRuntimeVideo: jest.fn().mockResolvedValue({ protocolVersion: 1, executionAvailable: false, tools: [], profiles: [], defaultProfileId: null }), getRuntimeVideoV2: jest.fn().mockResolvedValue({ protocolVersion: 2, executionAvailable: false, tools: [], profiles: [], defaultProfileId: null }), getRuntimeVideoV3: jest.fn().mockResolvedValue({ protocolVersion: 3, executionMode: 'disabled', executionAvailable: false, tools: [], profiles: [], defaultProfileId: null }) };
    skillArtifacts = { describe: jest.fn().mockResolvedValue(artifactFixtures[0].artifact) };
    sessions = {
      validateRefreshToken: jest.fn().mockResolvedValue({
        sessionId: 'session-1', userId: 'user-1', deviceId: 'device-1',
      }),
      rotateRefreshToken: jest.fn().mockResolvedValue({
        sessionId: 'session-1', userId: 'user-1', deviceId: 'device-1', refreshToken: 'next-refresh',
      }),
      getRefreshTtlSeconds: jest.fn().mockReturnValue(30 * 24 * 60 * 60),
      createSession: jest.fn().mockResolvedValue({ sessionId: 'session-1', refreshToken: 'refresh-token' }),
      revokeSession: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        ClientService,
        { provide: SkillVersionService, useValue: skillVersions },
        { provide: GatewayModelPolicyService, useValue: modelPolicy },
        { provide: MediaConfigService, useValue: mediaConfig },
        { provide: MediaVideoConfigService, useValue: videoConfig },
        { provide: ClientSkillArtifactService, useValue: skillArtifacts },
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: { get: jest.fn(), getOrThrow: jest.fn().mockReturnValue('explicit-test-jwt-secret') } },
        { provide: SettingService, useValue: { getEffectiveValue: jest.fn() } },
        { provide: SessionService, useValue: sessions },
        { provide: MemberAllowanceQueryService, useValue: allowanceQuery },
        { provide: PersonalWalletService, useValue: personalWallet },
        { provide: SubscriptionRequestService, useValue: { createRequest: jest.fn(), getClientRequest: jest.fn() } },
        {
          provide: EnterpriseContextService,
          useValue: {
            resolve: jest.fn().mockResolvedValue({
              enterpriseId: 'ent-1', memberId: 'member-1', departmentId: 'dept-1', role: 'MEMBER',
            }),
            resolveOrNull: jest.fn().mockResolvedValue({
              enterpriseId: 'ent-1', memberId: 'member-1', departmentId: 'dept-1', role: 'MEMBER',
            }),
          },
        },
      ],
    }).compile();
    service = module.get(ClientService);
  });

  it('lists only approved platform employees with paginated capability summaries', async () => {
    prisma.digitalEmployee.count.mockResolvedValue(1);
    prisma.digitalEmployee.findMany.mockResolvedValue([
      {
        id: 'emp-platform-1',
        name: '数据分析员工',
        avatar: null,
        avatarStyle: null,
        avatarBindings: null,
        position: '数据分析师',
        description: '负责数据分析',
        functionalCategory: 'TECH',
        status: 'APPROVED',
        updatedAt: new Date('2026-09-29T08:30:00.000Z'),
        bindings: [{ capability: { id: 'cap-1', name: '数据分析', description: '分析数据', type: 'SKILL' } }],
      },
    ]);

    await expect(service.listPlatformEmployees({ page: 1, pageSize: 20, sort: 'updatedAt_desc' })).resolves.toMatchObject({
      total: 1,
      hasNextPage: false,
      items: [{ employeeId: 'emp-platform-1', canApply: true, capabilities: [{ id: 'cap-1' }] }],
    });
    expect(prisma.digitalEmployee.findMany.mock.calls[0][0]).toMatchObject({
      where: { status: 'APPROVED' },
      skip: 0,
      take: 20,
    });
  });

  it('creates a platform employee access request without trusting client identity fields', async () => {
    prisma.digitalEmployee.findFirst.mockResolvedValue({ id: 'emp-platform-1' });
    const createRequest = (service as any).subscriptionRequests.createRequest;
    createRequest.mockResolvedValue({
      id: 'request-1',
      status: 'PENDING',
      clientTargetType: 'PLATFORM_EMPLOYEE',
      employeeId: 'emp-platform-1',
      employee: { id: 'emp-platform-1', name: '数据分析员工' },
      subscriptionId: null,
      requestedCapabilities: ['cap-1'],
      createdAt: new Date('2026-09-29T08:30:00.000Z'),
      updatedAt: new Date('2026-09-29T08:30:00.000Z'),
    });

    await expect(service.createEmployeeAccessRequest('user-1', {
      targetType: 'PLATFORM_EMPLOYEE',
      employeeId: 'emp-platform-1',
      subscriptionId: null,
      reason: '需要数据分析',
      requestedCapabilities: ['cap-1'],
    }, 'client-key-1')).resolves.toMatchObject({
      requestId: 'request-1',
      status: 'PENDING',
      targetType: 'PLATFORM_EMPLOYEE',
      employee: { employeeId: 'emp-platform-1' },
    });
    expect(createRequest).toHaveBeenCalledWith(
      'user-1',
      { employeeId: 'emp-platform-1', reason: '需要数据分析' },
      expect.objectContaining({ targetType: 'PLATFORM_EMPLOYEE', idempotencyKey: 'client-key-1' }),
    );
  });

  it('returns only the authenticated user own access request status', async () => {
    const getClientRequest = (service as any).subscriptionRequests.getClientRequest;
    getClientRequest.mockResolvedValue({
      id: 'request-1',
      status: 'CANCELED',
      clientTargetType: 'ENTERPRISE_SUBSCRIPTION',
      employeeId: 'emp-1',
      employee: { id: 'emp-1', name: '员工' },
      subscriptionId: 'sub-1',
      requestedCapabilities: [],
      createdAt: new Date('2026-09-29T08:30:00.000Z'),
      updatedAt: new Date('2026-09-29T08:31:00.000Z'),
    });
    await expect(service.getEmployeeAccessRequest('user-1', 'request-1')).resolves.toMatchObject({
      requestId: 'request-1',
      status: 'CANCELLED',
      targetType: 'ENTERPRISE_SUBSCRIPTION',
    });
    expect(getClientRequest).toHaveBeenCalledWith('user-1', 'request-1');
  });

  it('refreshes an access token only for the matching active device', async () => {
    prisma.device.findUnique.mockResolvedValue({ userId: 'user-1', revokedAt: null });
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'a@example.com', name: 'A', role: 'USER', status: 'ACTIVE' });
    prisma.enterpriseMember.findFirst.mockResolvedValue({ enterprise: { id: 'ent-1', name: 'Acme' } });

    await expect(service.refreshAccessToken({ refreshToken: 'refresh-token' })).resolves.toMatchObject({
      accessToken: 'access-token', refreshToken: 'next-refresh', accessTokenExpiresIn: 3600,
      enterprise: { id: 'ent-1', name: 'Acme' },
    });
    expect(sessions.rotateRefreshToken).toHaveBeenCalledWith('refresh-token', 'DESKTOP');
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1', type: 'access' }),
      expect.objectContaining({ expiresIn: 3600 }),
    );
  });

  it.each(['CLOSURE_PENDING', 'CLOSED', 'DISABLED'])('rejects desktop refresh and login for %s accounts', async (status) => {
    prisma.device.findUnique.mockResolvedValue({ userId: 'user-1', revokedAt: null });
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', status });
    await expect(service.refreshAccessToken({ refreshToken: 'refresh-token' })).rejects.toThrow('Account is not active');
    await expect(service.login({ email: 'a@example.com', password: 'Password123', fingerprint: 'fingerprint', platform: 'macos', clientVersion: '1.0.0' } as any)).rejects.toThrow('账号当前不可登录');
    expect(sessions.rotateRefreshToken).not.toHaveBeenCalled();
    expect(sessions.createSession).not.toHaveBeenCalled();
    expect(prisma.device.upsert).not.toHaveBeenCalled();
  });

  it('aggregates enterprise allowance and personal wallet for the client', async () => {
    const enterprise = {
      userId: 'user-1',
      limitCNY: '300.00',
      usedCNY: '35.4200',
      remainingCNY: '264.5800',
      topUpRemainingCNY: '50.00',
      totalRemainingCNY: '314.5800',
      resetAt: '2026-10-01T00:00:00.000Z',
    };
    const personal = {
      balanceCNY: '10.00',
      totalDepositCNY: '20.00',
      totalConsumeCNY: '10.00',
    };
    allowanceQuery.getOne.mockResolvedValue(enterprise);
    personalWallet.getView.mockResolvedValue(personal);

    await expect(service.getComputeBalance('user-1')).resolves.toEqual({
      enterprise,
      personal,
    });
    expect(allowanceQuery.getOne).toHaveBeenCalledWith('ent-1', 'user-1');
    expect(personalWallet.getView).toHaveBeenCalledWith('user-1');
  });

  it('returns a personal wallet balance without enterprise allowance for an unaffiliated user', async () => {
    const personal = {
      balanceCNY: '0.00',
      totalDepositCNY: '0.00',
      totalConsumeCNY: '0.00',
    };
    personalWallet.getView.mockResolvedValue(personal);

    const context = (service as any).enterpriseContext;
    context.resolveOrNull.mockResolvedValueOnce(null);

    await expect(service.getComputeBalance('user-2')).resolves.toEqual({
      enterprise: null,
      personal,
    });
    expect(allowanceQuery.getOne).not.toHaveBeenCalled();
    expect(personalWallet.getView).toHaveBeenCalledWith('user-2');
  });

  it('returns the current user avatar and the server-resolved enterprise logo', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'a@example.com',
      name: 'A',
      avatar: '/api/users/avatars/user-avatar.webp',
      role: 'USER',
    });
    prisma.enterpriseMember.findFirst.mockResolvedValue({
      enterprise: {
        id: 'ent-1',
        name: 'Acme',
        logo: '/api/enterprise/logos/acme-logo.png',
      },
    });

    await expect(service.getProfile('user-1')).resolves.toEqual({
      user: {
        id: 'user-1',
        email: 'a@example.com',
        name: 'A',
        avatar: '/api/users/avatars/user-avatar.webp',
        role: 'USER',
      },
      enterprise: {
        id: 'ent-1',
        name: 'Acme',
        logo: '/api/enterprise/logos/acme-logo.png',
      },
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { id: true, email: true, name: true, avatar: true, role: true },
    });
    expect(prisma.enterpriseMember.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'asc' },
      select: { enterprise: { select: { id: true, name: true, logo: true } } },
    });
  });

  it('returns null enterprise and nullable image fields for users without branding', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      email: 'b@example.com',
      name: null,
      avatar: null,
      role: 'USER',
    });
    prisma.enterpriseMember.findFirst.mockResolvedValue(null);

    await expect(service.getProfile('user-2')).resolves.toEqual({
      user: {
        id: 'user-2',
        email: 'b@example.com',
        name: null,
        avatar: null,
        role: 'USER',
      },
      enterprise: null,
    });
  });

  it('rejects a profile lookup when the authenticated user no longer exists', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.enterpriseMember.findFirst.mockResolvedValue(null);

    await expect(service.getProfile('deleted-user')).rejects.toThrow('User not found');
  });

  it('lists only authorized subscriptions, deduplicates grants, and returns effective models', async () => {
    prisma.employeeGrant.findMany.mockResolvedValue([
      { subscription: { id: 'sub-1', name: null, templateVersion: '1.0.0', status: 'ACTIVE', employeeId: 'emp-1', employee: { id: 'emp-1', name: 'Employee', avatar: null, version: '1.1.0' } } },
      { subscription: { id: 'sub-1', name: null, templateVersion: '1.0.0', status: 'ACTIVE', employeeId: 'emp-1', employee: { id: 'emp-1', name: 'Employee', avatar: null, version: '1.1.0' } } },
    ]);
    prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'gpt-4o-mini' }, { modelId: 'blocked-model' }]);
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ allowedChatModels: ['gpt-4o-mini'] });

    const result = await service.listSubscriptions('user-1');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ subscriptionId: 'sub-1', employeeId: 'emp-1', allowedModels: ['gpt-4o-mini'], upgradeAvailable: true });
    expect(modelPolicy.resolvePolicy).toHaveBeenCalledTimes(1);
    expect(modelPolicy.resolvePolicy).toHaveBeenCalledWith({
      sub: 'user-1', enterpriseId: 'ent-1', memberId: 'member-1', subscriptionId: 'sub-1',
    });
    expect(prisma.employeeGrant.findMany.mock.calls[0][0].where).toMatchObject({
      OR: [{ memberId: 'member-1' }, { departmentId: 'dept-1' }],
      subscription: { enterpriseId: 'ent-1', status: 'ACTIVE' },
    });
  });

  it('returns all subscriptions on first load when enterprise config creation races', async () => {
    const subscriptions = ['sub-1', 'sub-2'].map((id) => ({
      id, name: null, templateVersion: '1.0.0', status: 'ACTIVE', employeeId: 'emp-1',
      employee: { id: 'emp-1', name: 'Employee', avatar: null, version: '1.0.0' },
    }));
    const config = {
      id: 'cfg-1', enterpriseId: 'ent-1', defaultChatModel: 'gpt-4o-mini',
      allowedChatModels: ['gpt-4o-mini'], allowUserSwitchModel: true,
      employeeModelPolicy: 'FOLLOW_TEMPLATE', employeeDefaultModel: null, rerankModel: null,
      createdAt: new Date('2026-10-12'), updatedAt: new Date('2026-10-12'),
    };
    prisma.employeeGrant.findMany.mockResolvedValue(subscriptions.map((subscription) => ({ subscription })));
    prisma.enterpriseMember.findFirst.mockResolvedValue({ departmentId: null });
    prisma.subscription.findFirst.mockResolvedValue({ employee: { modelId: 'gpt-4o-mini' } });
    prisma.subscription.findUnique = jest.fn().mockResolvedValue({ config: null });
    prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'gpt-4o-mini' }]);
    prisma.enterpriseModelConfig.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(config);
    prisma.enterpriseModelConfig.create = jest.fn()
      .mockResolvedValueOnce(config)
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate enterprise', {
        code: 'P2002', clientVersion: '6', meta: { target: ['enterpriseId'] },
      }));
    const realPolicy = new GatewayModelPolicyService(
      new EnterpriseModelConfigService(prisma, {} as EnterpriseContextService),
      prisma,
      new ConfigService(),
    );
    modelPolicy.resolvePolicy.mockImplementation((identity) => realPolicy.resolvePolicy(identity));

    const result = await service.listSubscriptions('user-1');

    expect(result.map((item) => item.subscriptionId)).toEqual(['sub-1', 'sub-2']);
    expect(result.map((item) => item.allowedModels)).toEqual([['gpt-4o-mini'], ['gpt-4o-mini']]);
    expect(prisma.enterpriseModelConfig.create).toHaveBeenCalledTimes(2);
    expect(prisma.enterpriseModelConfig.findUnique).toHaveBeenCalledTimes(3);
  });

  it('returns the same versioned avatar in client list and runtime without exposing extra employee fields', async () => {
    const employee = {
      id: 'emp-1', name: 'Renamed employee',
      avatar: '/assets/employees/silicon/frontend-engineer.webp',
      version: '1.0.0', description: 'Engineer', maxSteps: 10,
      systemPrompt: 'private instructions', modelId: 'model-1', bindings: [],
    };
    const sub = { id: 'sub-1', employeeId: employee.id, name: 'Enterprise alias', templateVersion: '1.0.0', status: 'ACTIVE', employee, skillVersionSelections: [] };
    prisma.employeeGrant.findMany.mockResolvedValue([{ subscription: sub }]);
    prisma.subscription.findFirst.mockResolvedValue(sub);
    prisma.platformModel.findMany.mockResolvedValue([]);
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue(null);

    const [listed] = await service.listSubscriptions('user-1');
    const runtime = await service.getRuntime('user-1', 'sub-1');
    const expected = withEmployeeAvatar(employee);
    expect(listed.template.avatarAsset).toEqual(expected.avatarAsset);
    expect(runtime.employee.avatarAsset).toEqual(expected.avatarAsset);
    expect(listed.template.avatar).toBe(expected.avatarAsset.portraitUrl);
    expect(runtime.employee).not.toHaveProperty('systemPrompt');
    expect(runtime.employee).not.toHaveProperty('bindings');
    expect(runtime.runtime).not.toHaveProperty('media');
    expect(mediaConfig.getRuntimeMedia).not.toHaveBeenCalled();
    const negotiated = await service.getRuntime('user-1', 'sub-1', 1);
    expect(negotiated.runtime.media).toMatchObject({ protocolVersion: 1, executionAvailable: false, tools: [] });
    expect(mediaConfig.getRuntimeMedia).toHaveBeenCalledWith('ent-1');
    mediaConfig.getRuntimeMedia.mockClear();
    const unsupported = await service.getRuntime('user-1', 'sub-1', 2);
    expect(unsupported.runtime.media).toHaveProperty('protocolVersion', 2);
    expect(mediaConfig.getRuntimeMedia).not.toHaveBeenCalled();
    expect(mediaConfig.getRuntimeMediaV2).toHaveBeenCalledWith('ent-1');
    const v3 = await service.getRuntime('user-1', 'sub-1', 3);
    expect(v3.runtime.media).toHaveProperty('protocolVersion', 3);
    expect(mediaConfig.getRuntimeMediaV3).toHaveBeenCalledWith('ent-1');
  });

  it('uses the shared enterprise resolver for runtime and omits skills without an approved version', async () => {
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'sub-1', templateVersion: '1.0.0', config: null,
      employee: {
        id: 'emp-1', name: 'Employee', avatar: null, version: '1.0.0',
        systemPrompt: 'instructions', modelId: 'model-1', maxSteps: 10,
        bindings: [
          { capability: { id: 'cap-1', name: 'Skill', description: null },
            defaultSkillVersion: { id: 'obsolete-template', content: 'obsolete' } },
          { capability: { id: 'cap-2', name: 'Unapproved', description: null } },
        ],
      },
      skillVersionSelections: [{ capabilityId: 'cap-1', version: { id: 'obsolete-selection' } }],
    });
    prisma.platformModel.findMany.mockResolvedValue([]);
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue(null);
    skillVersions.resolveEffectiveVersion.mockImplementation(async (_subscriptionId, capabilityId) =>
      capabilityId === 'cap-1' ? { id: 'enterprise-enabled', version: '2.0.0', content: 'exact enabled content' } : null);

    const result = await service.getRuntime('user-1', 'sub-1');

    expect(result.runtime.skills).toEqual([{ capabilityId: 'cap-1', name: 'Skill', description: null,
      versionId: 'enterprise-enabled', version: '2.0.0', content: 'exact enabled content' }]);
    expect(skillVersions.resolveEffectiveVersion.mock.calls).toEqual([['sub-1', 'cap-1'], ['sub-1', 'cap-2']]);
    expect(prisma.subscription.findFirst.mock.calls[0][0].include.employee.select.bindings.where)
      .toEqual({ enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } });
  });

  it('does not read media configuration when subscription authorization fails', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    await expect(service.getRuntime('user-1', 'revoked-subscription', 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(mediaConfig.getRuntimeMedia).not.toHaveBeenCalled();
    expect(prisma.subscription.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'revoked-subscription', enterpriseId: 'ent-1', status: 'ACTIVE',
      grants: { some: { OR: [{ memberId: 'member-1' }, { departmentId: 'dept-1' }] } },
    });
  });

  describe('skill artifact runtime negotiation', () => {
    const approvedVersion = {
      id: 'ver-mock-single', capabilityId: 'cap-mock-single', version: '1.0.0',
      content: 'Mock approved chat skill content', scope: 'PLATFORM', status: 'PLATFORM_APPROVED',
      packageSha256: null, packageKey: null,
    };

    beforeEach(() => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'sub-mock', templateVersion: '1.0.0', config: { temperature: 0.2 },
        employee: {
          id: 'emp-mock', name: 'Mock employee', description: 'Mock runtime', avatar: null, version: '1.0.0',
          systemPrompt: 'Mock chat instructions', modelId: 'mock-chat-model', maxSteps: 10,
          bindings: [
            { capability: { id: 'cap-mock-single', name: 'Mock skill', description: 'Mock approved skill' } },
            { capability: { id: 'cap-mock-unapproved', name: 'Unapproved mock skill', description: null } },
          ],
        },
      });
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'mock-chat-model' }]);
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ allowedChatModels: ['mock-chat-model'] });
      skillVersions.resolveEffectiveVersion.mockImplementation(async (_subscriptionId, capabilityId) =>
        capabilityId === approvedVersion.capabilityId ? approvedVersion : null);
    });

    it.each([0, 1])('negotiates mock single-file/ZIP artifact v1 and describes only approved skills (%s)', async (index) => {
      const descriptor = ClientSkillArtifactSchema.parse({
        ...artifactFixtures[index].artifact, capabilityId: approvedVersion.capabilityId, versionId: approvedVersion.id,
      });
      skillArtifacts.describe.mockResolvedValue(descriptor);
      const result = await service.getRuntime('user-1', 'sub-mock', undefined, 1);

      expect(result.manifestVersion).toBe(1);
      expect(result.runtime.skillArtifactProtocolVersion).toBe(1);
      expect(result.runtime.skills).toEqual([{
        capabilityId: approvedVersion.capabilityId, name: 'Mock skill', description: 'Mock approved skill',
        versionId: approvedVersion.id, version: approvedVersion.version, content: approvedVersion.content,
        artifact: descriptor,
      }]);
      expect(skillArtifacts.describe).toHaveBeenCalledTimes(1);
      expect(skillArtifacts.describe).toHaveBeenCalledWith('sub-mock', approvedVersion.capabilityId, approvedVersion);
      expect(result.runtime).not.toHaveProperty('media');
      expect(mediaConfig.getRuntimeMedia).not.toHaveBeenCalled();
    });

  it.each([
    [undefined, undefined, undefined], [1, undefined, undefined], [undefined, 1, undefined],
    [undefined, undefined, 1], [1, 1, 1], [2, 2, 1], [1, 1, 2], [2, 1, 2], [3, 1, 3],
  ])('negotiates video independently of image and artifact versions (%s, %s, %s)', async (media, artifacts, video) => {
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'sub-1', templateVersion: '1.0.0', config: null,
      employee: { id: 'emp-1', name: 'Employee', avatar: null, version: '1.0.0',
        systemPrompt: 'instructions', modelId: 'model-1', maxSteps: 10, bindings: [] },
    });
    prisma.platformModel.findMany.mockResolvedValue([]);
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue(null);
    const baseline = await service.getRuntime('user-1', 'sub-1', media, artifacts);
    const result = await service.getRuntime('user-1', 'sub-1', media, artifacts, video);
    if (video === 1 || video === 2 || video === 3) {
      const getter = video === 3 ? videoConfig.getRuntimeVideoV3 : video === 2 ? videoConfig.getRuntimeVideoV2 : videoConfig.getRuntimeVideo;
      expect(result.runtime.video).toEqual(await getter.mock.results[0].value);
      expect(getter).toHaveBeenCalledWith('ent-1');
      const { video: _video, ...runtime } = result.runtime;
      expect(runtime).toEqual(baseline.runtime);
    } else {
      expect(result).toEqual(baseline);
      expect(result.runtime).not.toHaveProperty('video');
      expect(videoConfig.getRuntimeVideo).not.toHaveBeenCalled();
    }
  });

  it('does not resolve video configuration before subscription authorization', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    await expect(service.getRuntime('user-1', 'sub-1', 1, 1, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(videoConfig.getRuntimeVideo).not.toHaveBeenCalled();
  });

    it.each([undefined, 2, 99])('does not call describe without supported artifact negotiation (%s)', async (protocolVersion) => {
      const result = await service.getRuntime('user-1', 'sub-mock', undefined, protocolVersion);
      expect(skillArtifacts.describe).not.toHaveBeenCalled();
      expect(result.runtime).not.toHaveProperty('skillArtifactProtocolVersion');
      expect(result.runtime.skills[0]).not.toHaveProperty('artifact');
      expect(result.runtime.skills[0].content).toBe(approvedVersion.content);
    });

    it.each([
      [1, undefined, true, false],
      [1, 2, true, false],
      [2, 1, true, true],
      [3, 1, true, true],
      [undefined, 1, false, true],
      [1, 1, true, true],
    ])('negotiates media (%s) and artifact (%s) independently', async (mediaVersion, artifactVersion, expectsMedia, expectsArtifact) => {
      const result = await service.getRuntime('user-1', 'sub-mock', mediaVersion, artifactVersion);
      expect(mediaConfig.getRuntimeMedia).toHaveBeenCalledTimes(expectsMedia && mediaVersion === 1 ? 1 : 0);
      expect(mediaConfig.getRuntimeMediaV2).toHaveBeenCalledTimes(expectsMedia && mediaVersion === 2 ? 1 : 0);
      expect(mediaConfig.getRuntimeMediaV3).toHaveBeenCalledTimes(expectsMedia && mediaVersion === 3 ? 1 : 0);
      expect(skillArtifacts.describe).toHaveBeenCalledTimes(expectsArtifact ? 1 : 0);
      expect('media' in result.runtime).toBe(expectsMedia);
      expect('skillArtifactProtocolVersion' in result.runtime).toBe(expectsArtifact);
      expect('artifact' in result.runtime.skills[0]).toBe(expectsArtifact);
      if (expectsMedia) expect(mediaVersion === 3 ? mediaConfig.getRuntimeMediaV3
        : mediaVersion === 2 ? mediaConfig.getRuntimeMediaV2 : mediaConfig.getRuntimeMedia).toHaveBeenCalledWith('ent-1');
    });

    it.each(SkillArtifactBlockedReasonSchema.options)('keeps chat runtime usable when installation is BLOCKED (%s)', async (reason) => {
      const descriptor = ClientSkillArtifactSchema.parse({
        ...artifactFixtures[2].artifact, capabilityId: approvedVersion.capabilityId, versionId: approvedVersion.id, reason,
      });
      skillArtifacts.describe.mockResolvedValue(descriptor);
      const baseline = await service.getRuntime('user-1', 'sub-mock');
      const negotiated = await service.getRuntime('user-1', 'sub-mock', undefined, 1);
      const { artifact, ...chatSkill } = negotiated.runtime.skills[0];
      const { skillArtifactProtocolVersion, skills, ...chatRuntime } = negotiated.runtime;

      expect(artifact).toEqual(descriptor);
      expect(artifact).not.toHaveProperty('downloadPath');
      expect(chatSkill).toEqual(baseline.runtime.skills[0]);
      expect(chatRuntime).toEqual({
        systemPrompt: 'Mock chat instructions', modelId: 'mock-chat-model', allowedModels: ['mock-chat-model'],
        config: { temperature: 0.2 },
      });
      expect(negotiated.employee).toEqual(baseline.employee);
      expect(skillArtifactProtocolVersion).toBe(1);
      expect(skills).toHaveLength(1);
    });

    it('preserves legacy chat when optional artifact service is not registered', async () => {
      const legacy = await Test.createTestingModule({
        providers: [
          ClientService,
          { provide: PrismaService, useValue: prisma },
          { provide: EnterpriseContextService, useValue: (service as any).enterpriseContext },
          { provide: SettingService, useValue: {} },
          { provide: JwtService, useValue: jwt },
          { provide: ConfigService, useValue: new ConfigService() },
          { provide: SessionService, useValue: sessions },
          { provide: MemberAllowanceQueryService, useValue: allowanceQuery },
          { provide: PersonalWalletService, useValue: personalWallet },
          { provide: SubscriptionRequestService, useValue: {} },
          { provide: SkillVersionService, useValue: skillVersions },
          { provide: GatewayModelPolicyService, useValue: modelPolicy },
          { provide: MediaConfigService, useValue: mediaConfig },
        ],
      }).compile();
      try {
        const result = await legacy.get(ClientService).getRuntime('user-1', 'sub-mock', 1, 1);
        expect(result.runtime).not.toHaveProperty('skillArtifactProtocolVersion');
        expect(result.runtime.skills[0]).not.toHaveProperty('artifact');
        expect(result.runtime.skills[0].content).toBe(approvedVersion.content);
        expect(result.runtime.media).toHaveProperty('protocolVersion', 1);
      } finally {
        await legacy.close();
      }
    });

    it('does not resolve versions, describe artifacts or read packages after runtime authorization is revoked', async () => {
      const packages = { readInstallablePackage: jest.fn() };
      const artifacts = new ClientSkillArtifactService(prisma, (service as any).enterpriseContext, skillVersions as unknown as SkillVersionService, packages as unknown as SkillPackageService);
      const describe = jest.spyOn(artifacts, 'describe');
      skillArtifacts.describe.mockImplementation((...args) => artifacts.describe(args[0], args[1], args[2]));
      prisma.subscription.findFirst.mockResolvedValue(null);

      await expect(service.getRuntime('user-1', 'sub-mock', 1, 1)).rejects.toBeInstanceOf(NotFoundException);
      expect(skillVersions.resolveEffectiveVersion).not.toHaveBeenCalled();
      expect(skillArtifacts.describe).not.toHaveBeenCalled();
      expect(describe).not.toHaveBeenCalled();
      expect(packages.readInstallablePackage).not.toHaveBeenCalled();
      expect(mediaConfig.getRuntimeMedia).not.toHaveBeenCalled();
    });

    it('does not read a previously negotiated package when download authorization is revoked', async () => {
      const packages = { readInstallablePackage: jest.fn() };
      const artifacts = new ClientSkillArtifactService(prisma, (service as any).enterpriseContext, skillVersions as unknown as SkillVersionService, packages as unknown as SkillPackageService);
      const runtime = await service.getRuntime('user-1', 'sub-mock', undefined, 1);
      expect(runtime.runtime.skills[0].artifact).toHaveProperty('status', 'AVAILABLE');
      skillVersions.resolveEffectiveVersion.mockClear();
      prisma.subscription.findFirst.mockResolvedValue(null);

      await expect(artifacts.download('user-1', {
        subscriptionId: 'sub-mock', capabilityId: approvedVersion.capabilityId, versionId: approvedVersion.id,
      })).rejects.toBeInstanceOf(NotFoundException);
      expect(packages.readInstallablePackage).not.toHaveBeenCalled();
      expect(skillVersions.resolveEffectiveVersion).not.toHaveBeenCalled();
      expect(prisma.subscription.findFirst.mock.calls.at(-1)[0].where).toMatchObject({
        id: 'sub-mock', enterpriseId: 'ent-1', status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: expect.any(Date) } }],
        grants: { some: {
          OR: [{ memberId: 'member-1' }, { departmentId: 'dept-1' }],
          AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }],
        } },
      });
    });
  });
});
