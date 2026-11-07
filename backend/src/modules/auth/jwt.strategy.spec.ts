import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  const authService = { validateUser: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses ACCESS_JWT_SECRET when configured and accepts an access token payload', async () => {
    const config = {
      get: jest.fn((key: string) => key === 'ACCESS_JWT_SECRET' ? 'access-secret' : undefined),
      getOrThrow: jest.fn(() => 'fallback-secret'),
    };
    const strategy = new JwtStrategy(config as any, authService as any);
    expect(config.get).toHaveBeenCalledWith('ACCESS_JWT_SECRET');
    authService.validateUser.mockResolvedValue({ id: 'user-1' });

    await expect(strategy.validate({ sub: 'user-1', type: 'access', sid: 'session-1' }))
      .resolves.toEqual({ id: 'user-1', sid: 'session-1' });
    expect(authService.validateUser).toHaveBeenCalledWith('user-1', 'session-1');
  });

  it('rejects refresh token payloads and payloads without sub', async () => {
    const config = {
      get: jest.fn().mockReturnValue(undefined),
      getOrThrow: jest.fn().mockReturnValue('fallback-secret'),
    };
    const strategy = new JwtStrategy(config as any, authService as any);

    await expect(strategy.validate({ sub: 'user-1', type: 'refresh' })).resolves.toBeNull();
    await expect(strategy.validate({ type: 'access' })).resolves.toBeNull();
    await expect(strategy.validate({ sub: 'user-1', type: 'access' })).resolves.toBeNull();
    expect(authService.validateUser).not.toHaveBeenCalled();
  });
});
