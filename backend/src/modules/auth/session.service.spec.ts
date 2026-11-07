import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SessionService } from './session.service';

const config = {
  get: jest.fn((key: string) => key === 'REFRESH_TOKEN_PEPPER' ? 'test-refresh-pepper' : undefined),
  getOrThrow: jest.fn(() => 'test-jwt-secret'),
};

describe('SessionService', () => {
  let prisma: any;
  let service: SessionService;
  const activeSession = (changes = {}) => ({
    userId: 'user-1', type: 'WEB', revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000), deviceId: null,
    user: { status: 'ACTIVE', role: 'USER', memberships: [] }, device: null, ...changes,
  });

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'user-1', status: 'ACTIVE' }]),
      enterpriseMember: { findFirst: jest.fn().mockResolvedValue(null) },
      enterprise: { findUnique: jest.fn().mockResolvedValue({ metadata: {} }) },
      authSession: {
        create: jest.fn().mockResolvedValue({ id: 'session-1' }),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(activeSession()),
      },
      authToken: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(async (input: any) => {
        if (Array.isArray(input)) return Promise.all(input);
        return input(prisma);
      }),
    };
    service = new SessionService(prisma, config as any);
  });

  it('creates a session and stores only a peppered hash', async () => {
    const result = await service.createSession({
      userId: 'user-1', clientType: 'WEB', refreshTtlSeconds: 3600,
    });

    expect(result.refreshToken).toEqual(expect.any(String));
    expect(result.refreshToken.length).toBeGreaterThanOrEqual(40);
    const tokenData = prisma.authToken.create.mock.calls[0][0].data;
    expect(tokenData.tokenHash).toEqual(expect.any(String));
    expect(tokenData.tokenHash).not.toBe(result.refreshToken);
    expect(tokenData.tokenHash).toHaveLength(64);
    expect(prisma.authSession.create.mock.calls[0][0].data).toMatchObject({
      userId: 'user-1', type: 'WEB', familyId: result.familyId,
    });
  });

  it.each(['CLOSURE_PENDING', 'CLOSED', 'DISABLED'])('does not create a session for %s accounts', async (status) => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'user-1', status }]);
    await expect(service.createSession({ userId: 'user-1', clientType: 'WEB', refreshTtlSeconds: 3600 }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.authSession.create).not.toHaveBeenCalled();
    expect(prisma.authToken.create).not.toHaveBeenCalled();
  });

  it('serializes session creation with enterprise freeze and rejects a frozen member', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'user-1', status: 'ACTIVE', role: 'USER' }])
      .mockResolvedValueOnce([{ enterpriseId: 'enterprise-1', metadata: { suspended: true } }]);

    await expect(service.createSession({ userId: 'user-1', clientType: 'WEB', refreshTtlSeconds: 3600 }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'ENTERPRISE_SUSPENDED' }) });
    expect(prisma.$queryRaw.mock.calls[1][0].join('?')).toContain('FOR SHARE OF e');
    expect(prisma.authSession.create).not.toHaveBeenCalled();
  });

  it('rechecks account status under the user lock after refresh prevalidation', async () => {
    prisma.authToken.findUnique.mockResolvedValue({
      id: 'token-1', usedAt: null, revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
      session: { id: 'session-1', userId: 'user-1', type: 'WEB', familyId: 'family-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) },
    });
    prisma.$queryRaw.mockResolvedValue([{ id: 'user-1', status: 'CLOSURE_PENDING' }]);
    const revoke = jest.spyOn(service, 'revokeSessionFamily').mockResolvedValue();
    await expect(service.rotateRefreshToken('token', 'WEB')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.authToken.create).not.toHaveBeenCalled();
    expect(prisma.authToken.updateMany).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalled();
  });

  it('rotates a refresh token and consumes the old token', async () => {
    const current = {
      id: 'token-1', sessionId: 'session-1', familyId: 'family-1',
      tokenHash: 'hash', usedAt: null, revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      session: {
        id: 'session-1', userId: 'user-1', type: 'WEB', familyId: 'family-1',
        deviceId: null, revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
      },
    };
    prisma.authToken.findUnique.mockResolvedValue(current);
    prisma.authToken.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.rotateRefreshToken('presented-token', 'WEB');

    expect(result).toMatchObject({ sessionId: 'session-1', userId: 'user-1', familyId: 'family-1' });
    expect(result.refreshToken).not.toBe('presented-token');
    expect(prisma.authToken.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'token-1', usedAt: null, revokedAt: null, expiresAt: { gt: expect.any(Date) },
        session: {
          id: 'session-1', userId: 'user-1', type: 'WEB', revokedAt: null,
          expiresAt: { gt: expect.any(Date) }, user: { status: 'ACTIVE' },
        },
      },
      data: expect.objectContaining({ usedAt: expect.any(Date) }),
    });
    expect(prisma.authToken.create).toHaveBeenCalledTimes(1);
    expect(prisma.authSession.update).toHaveBeenCalledTimes(1);
  });

  it('revokes the whole family when a used token is replayed', async () => {
    prisma.authToken.findUnique.mockResolvedValue({
      id: 'token-1', familyId: 'family-1', usedAt: new Date(), revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      session: {
        id: 'session-1', userId: 'user-1', type: 'WEB', familyId: 'family-1',
        deviceId: null, revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const revokeFamily = jest.spyOn(service, 'revokeSessionFamily').mockResolvedValue();

    await expect(service.rotateRefreshToken('replayed-token', 'WEB'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(revokeFamily).toHaveBeenCalledWith('family-1', 'refresh_token_reuse');
  });

  it('detects replay during validation and revokes the whole family', async () => {
    prisma.authToken.findUnique.mockResolvedValue({
      familyId: 'family-2', usedAt: new Date(), revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      session: {
        id: 'session-2', userId: 'user-2', type: 'DESKTOP', familyId: 'family-2',
        deviceId: 'device-2', revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const revokeFamily = jest.spyOn(service, 'revokeSessionFamily').mockResolvedValue();

    await expect(service.validateRefreshToken('replayed-token', 'DESKTOP'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(revokeFamily).toHaveBeenCalledWith('family-2', 'refresh_token_reuse');
  });

  it('treats a concurrent rotation race as token reuse and revokes the family', async () => {
    const current = {
      id: 'token-race', familyId: 'family-race', usedAt: null, revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      session: {
        id: 'session-race', userId: 'user-race', type: 'WEB', familyId: 'family-race',
        deviceId: null, revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
      },
    };
    prisma.authToken.findUnique.mockResolvedValue(current);
    prisma.authSession.findUnique.mockResolvedValue(activeSession({ userId: 'user-race' }));
    prisma.authToken.updateMany.mockResolvedValue({ count: 0 });
    const revokeFamily = jest.spyOn(service, 'revokeSessionFamily').mockResolvedValue();

    await expect(service.rotateRefreshToken('race-token', 'WEB'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(revokeFamily).toHaveBeenCalledWith('family-race', 'refresh_token_reuse');
  });

  it.each([
    ['WEB', 'DESKTOP'],
    ['DESKTOP', 'WEB'],
  ] as const)('does not allow %s token for %s client', async (storedType, requestedType) => {
    prisma.authToken.findUnique.mockResolvedValue({
      familyId: 'family-1', usedAt: null, revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      session: {
        id: 'session-1', userId: 'user-1', type: storedType, familyId: 'family-1',
        deviceId: null, revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(service.validateRefreshToken('token', requestedType))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('marks the access-token session as current when listing sessions', async () => {
    prisma.authSession.findMany.mockResolvedValue([
      {
        id: 'session-current', type: 'WEB', deviceId: null,
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        lastUsedAt: new Date('2026-09-24T00:00:00.000Z'),
        createdAt: new Date('2026-09-23T00:00:00.000Z'),
      },
      {
        id: 'session-other', type: 'DESKTOP', deviceId: 'device-1',
        expiresAt: new Date('2026-10-02T00:00:00.000Z'),
        lastUsedAt: null,
        createdAt: new Date('2026-09-22T00:00:00.000Z'),
      },
    ]);

    await expect(service.listUserSessions('user-1', 'session-current')).resolves.toEqual([
      expect.objectContaining({ id: 'session-current', isCurrent: true }),
      expect.objectContaining({ id: 'session-other', isCurrent: false }),
    ]);
    expect(prisma.authSession.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1', revokedAt: null },
    }));
  });

  it('revokes current session and all sessions through scoped database updates', async () => {
    prisma.authSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.authToken.updateMany.mockResolvedValue({ count: 1 });

    await service.revokeSession('session-1', 'logout');
    await service.revokeAllUserSessions('user-1', 'logout_all');

    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'session-1', revokedAt: null },
    }));
    expect(prisma.authToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { session: { userId: 'user-1' }, revokedAt: null },
    }));
  });

  it('accepts an active desktop session with a device belonging to the user', async () => {
    prisma.authSession.findUnique.mockResolvedValue(activeSession({
      type: 'DESKTOP', deviceId: 'device-1', device: { userId: 'user-1', revokedAt: null },
    }));
    await expect(service.assertActiveSession('session-1', 'user-1', 'DESKTOP')).resolves.toBeUndefined();
    expect(prisma.authSession.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'session-1' },
      select: expect.objectContaining({
        user: expect.objectContaining({
          select: expect.objectContaining({ status: true, role: true, memberships: expect.any(Object) }),
        }),
      }),
    }));
  });

  it('rejects an access session for a suspended enterprise', async () => {
    prisma.authSession.findUnique.mockResolvedValue(activeSession({
      user: { status: 'ACTIVE', role: 'USER', memberships: [{ enterprise: { metadata: { suspended: true } } }] },
    }));

    await expect(service.assertActiveAccessSession('session-1', 'user-1'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'ENTERPRISE_SUSPENDED' }) });
  });

  it.each([
    ['missing', null],
    ['wrong user', activeSession({ userId: 'other' })],
    ['wrong type', activeSession({ type: 'DESKTOP' })],
    ['revoked', activeSession({ revokedAt: new Date() })],
    ['expired', activeSession({ expiresAt: new Date(0) })],
    ['disabled user', activeSession({ user: { status: 'DISABLED' } })],
  ])('rejects %s sessions', async (_reason, session) => {
    prisma.authSession.findUnique.mockResolvedValue(session);
    await expect(service.assertActiveSession('session-1', 'user-1', 'WEB'))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    { deviceId: null, device: null },
    { deviceId: 'device-1', device: null },
    { deviceId: 'device-1', device: { userId: 'other', revokedAt: null } },
    { deviceId: 'device-1', device: { userId: 'user-1', revokedAt: new Date() } },
  ])('rejects invalid desktop devices: %j', async (device) => {
    prisma.authSession.findUnique.mockResolvedValue(activeSession({ type: 'DESKTOP', ...device }));
    await expect(service.assertActiveSession('session-1', 'user-1', 'DESKTOP'))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed with a sanitized 503 when session storage is unavailable', async () => {
    prisma.authSession.findUnique.mockRejectedValue(new Error('private database details'));
    await expect(service.assertActiveSession('session-1', 'user-1', 'WEB'))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.assertActiveSession('session-1', 'user-1', 'WEB'))
      .rejects.toThrow('Authentication session service unavailable');
  });

  it.each(['validateRefreshToken', 'rotateRefreshToken'] as const)(
    '%s rejects a disabled user before rotation', async (method) => {
      prisma.authToken.findUnique.mockResolvedValue({
        id: 'token-1', usedAt: null, revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
        session: { id: 'session-1', familyId: 'family-1', ...activeSession() },
      });
      prisma.authSession.findUnique.mockResolvedValue(activeSession({ user: { status: 'DISABLED' } }));
      await expect(service[method]('token', 'WEB')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.authToken.updateMany).not.toHaveBeenCalled();
      expect(prisma.authToken.create).not.toHaveBeenCalled();
    },
  );

  it('keeps the desktop ownership and revocation checks in the atomic consumption predicate', async () => {
    const session = activeSession({
      type: 'DESKTOP', deviceId: 'device-1', device: { userId: 'user-1', revokedAt: null },
    });
    prisma.authToken.findUnique.mockResolvedValue({
      id: 'token-1', usedAt: null, revokedAt: null, expiresAt: session.expiresAt,
      session: { id: 'session-1', familyId: 'family-1', ...session },
    });
    prisma.authSession.findUnique.mockResolvedValue(session);
    prisma.authToken.updateMany.mockResolvedValue({ count: 1 });
    await service.rotateRefreshToken('token', 'DESKTOP');
    expect(prisma.authToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ session: expect.objectContaining({
        deviceId: { not: null }, device: { is: { userId: 'user-1', revokedAt: null } },
      }) }),
    }));
  });
});
