import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../auth/session.service';
import { SettingService } from '../setting/setting.service';
import { ClientService } from './client.service';

describe('Client employment and access token refresh', () => {
  let service: ClientService;
  let prisma: any;
  let sessions: any;
  let jwt: JwtService;
  let settings: any;
  const dto = { refreshToken: 'refresh-token', subscriptionId: 'subscription-1' };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1', status: 'ACTIVE', email: 'test@example.com', role: 'USER' }) },
      device: { findUnique: jest.fn().mockResolvedValue({ userId: 'user-1', revokedAt: null }) },
      subscription: { findUnique: jest.fn().mockResolvedValue({
        id: 'subscription-1', enterpriseId: 'enterprise-1', status: 'ACTIVE', endDate: null,
        employee: { id: 'employee-1', name: 'Employee' },
      }) },
      enterpriseMember: {
        findUnique: jest.fn().mockResolvedValue({ id: 'member-1', departmentId: null }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      employeeGrant: { findFirst: jest.fn().mockResolvedValue({ id: 'grant-1' }) },
    };
    sessions = {
      validateRefreshToken: jest.fn().mockResolvedValue({ sessionId: 'session-1', userId: 'user-1', deviceId: 'device-1' }),
      rotateRefreshToken: jest.fn().mockResolvedValue({
        sessionId: 'session-1', userId: 'user-1', refreshToken: 'next-refresh',
      }),
      assertEnterpriseActive: jest.fn().mockResolvedValue(undefined),
      getRefreshTtlSeconds: jest.fn().mockReturnValue(3600),
      revokeSession: jest.fn(),
    };
    jwt = new JwtService({ secret: 'employment-test-secret' });
    jest.spyOn(jwt, 'sign');
    settings = { getEffectiveValue: jest.fn().mockResolvedValue(null) };
    service = new ClientService(
      prisma as PrismaService, jwt,
      { get: () => 'employment-test-secret' } as unknown as ConfigService,
      settings as SettingService, {} as any, sessions as SessionService,
      {} as any, {} as any, {} as any, {} as any, {} as any,
    );
  });

  it('binds employment identity to the rotated refresh session and preserves the response contract', async () => {
    const result = await service.refreshInstanceToken(dto);
    expect(jwt.verify(result.employmentToken)).toMatchObject({
      sub: 'user-1', sid: 'session-1', type: 'client-employment',
      enterpriseId: 'enterprise-1', subscriptionId: 'subscription-1', memberId: 'member-1',
    });
    expect(result).toMatchObject({
      expiresIn: 900, refreshToken: 'next-refresh', refreshTokenExpiresIn: 3600,
      employment: { id: 'subscription-1', name: 'Employee', templateId: 'employee-1', status: 'ACTIVE' },
    });
    expect(sessions.rotateRefreshToken).toHaveBeenCalledWith('refresh-token', 'DESKTOP');
    expect(jwt.sign).toHaveBeenCalledWith(expect.objectContaining({ sid: 'session-1' }), expect.objectContaining({ algorithm: 'HS256' }));
  });

  it('keeps the same sid through subsequent refresh rotations', async () => {
    const first = await service.refreshInstanceToken(dto);
    const second = await service.refreshInstanceToken({ ...dto, refreshToken: first.refreshToken });
    expect(jwt.verify(second.employmentToken).sid).toBe(jwt.verify(first.employmentToken).sid);
    expect(sessions.rotateRefreshToken).toHaveBeenLastCalledWith('next-refresh', 'DESKTOP');
  });

  it.each([null, { id: 'user-1', status: 'DISABLED' }])('rejects inactive or missing users before employment rotation: %j', async (user) => {
    prisma.user.findUnique.mockResolvedValue(user);
    await expect(service.refreshInstanceToken(dto)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.rotateRefreshToken).not.toHaveBeenCalled();
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it.each([null, { userId: 'other', revokedAt: null }, { userId: 'user-1', revokedAt: new Date() }])(
    'rejects invalid devices and revokes the employment session: %j', async (device) => {
      prisma.device.findUnique.mockResolvedValue(device);
      await expect(service.refreshInstanceToken(dto)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(sessions.revokeSession).toHaveBeenCalledWith('session-1', 'device_revoked');
      expect(sessions.rotateRefreshToken).not.toHaveBeenCalled();
      expect(jwt.sign).not.toHaveBeenCalled();
    },
  );

  it('does not mint a token when refresh validation detects revocation or replay', async () => {
    sessions.validateRefreshToken.mockRejectedValue(new UnauthorizedException());
    await expect(service.refreshInstanceToken(dto)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.subscription.findUnique).not.toHaveBeenCalled();
    expect(sessions.rotateRefreshToken).not.toHaveBeenCalled();
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('does not mint a token if rotation loses a race', async () => {
    sessions.rotateRefreshToken.mockRejectedValue(new UnauthorizedException());
    await expect(service.refreshInstanceToken(dto)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it.each(['grant', 'subscription', 'ttl'])('keeps the existing %s authorization rejection before rotation', async (reason) => {
    if (reason === 'grant') prisma.employeeGrant.findFirst.mockResolvedValue(null);
    if (reason === 'subscription') prisma.subscription.findUnique.mockResolvedValue({ status: 'PAUSED' });
    if (reason === 'ttl') settings.getEffectiveValue.mockResolvedValue('0');
    await expect(service.refreshInstanceToken(dto)).rejects.toBeInstanceOf(reason === 'grant' ? UnauthorizedException : BadRequestException);
    expect(sessions.rotateRefreshToken).not.toHaveBeenCalled();
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('rejects a disabled user before ordinary access rotation', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', status: 'DISABLED' });
    await expect(service.refreshAccessToken({ refreshToken: dto.refreshToken })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.rotateRefreshToken).not.toHaveBeenCalled();
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('preserves ordinary access refresh and binds access to the same session', async () => {
    const result = await service.refreshAccessToken({ refreshToken: dto.refreshToken });
    expect(jwt.verify(result.accessToken)).toMatchObject({ sub: 'user-1', sid: 'session-1', type: 'access' });
    expect(result).toMatchObject({ refreshToken: 'next-refresh', accessTokenExpiresIn: 3600 });
  });
});
