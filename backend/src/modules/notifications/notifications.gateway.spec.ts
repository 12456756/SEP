import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { UnauthorizedException } from '@nestjs/common';
import { NotificationsGateway } from './notifications.gateway';

function createClient() {
  return Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send: jest.fn(),
    close: jest.fn(),
  }) as any;
}

function createConfig(origin = '') {
  return {
    get: jest.fn((key: string) => {
      if (key === 'ACCESS_JWT_SECRET') return 'access-secret';
      if (key === 'CORS_ORIGIN') return origin;
      return undefined;
    }),
    getOrThrow: jest.fn().mockReturnValue('jwt-secret'),
  } as any;
}

function createAuthService(user: { id: string } | null = { id: 'user-1' }) {
  return { validateUser: jest.fn().mockResolvedValue(user) } as any;
}

async function flushMessageHandler() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('NotificationsGateway', () => {
  it('主动关闭冻结成员连接，保留其他用户连接且阻止后续推送', async () => {
    const jwt = { verify: jest.fn() };
    const auth = { validateUser: jest.fn().mockImplementation(async (id) => ({ id })) };
    const gateway = new NotificationsGateway(jwt as any,
      { countUnread: jest.fn().mockResolvedValue(0) } as any, createConfig(), auth as any);
    const clients = [createClient(), createClient(), createClient()];
    for (const [index, client] of clients.entries()) {
      jwt.verify.mockReturnValue({ sub: index < 2 ? 'member-1' : 'admin-1', sid: `session-${index}`, type: 'access' });
      await gateway.handleConnection(client, { headers: {} });
      client.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'token' })));
      await flushMessageHandler();
    }
    gateway.closeUserConnections(['member-1']);
    expect(clients[0].close).toHaveBeenCalledWith(1008, 'Enterprise suspended');
    expect(clients[1].close).toHaveBeenCalledWith(1008, 'Enterprise suspended');
    expect(clients[2].close).not.toHaveBeenCalled();
    await gateway.pushToUser('member-1', { id: 'blocked' });
    expect(clients[0].send).toHaveBeenCalledTimes(1);
    await gateway.pushToUser('admin-1', { id: 'allowed' });
    expect(clients[2].send).toHaveBeenCalledTimes(2);
    gateway.handleDisconnect(clients[2]);
  });

  it('只在认证时读取一次未读数，事件推送不会轮询数据库', async () => {
    const jwtService = {
      verify: jest.fn().mockReturnValue({ sub: 'user-1', sid: 'session-1', type: 'access' }),
    };
    const notificationsService = { countUnread: jest.fn().mockResolvedValue(3) };
    const gateway = new NotificationsGateway(
      jwtService as any,
      notificationsService as any,
      createConfig(),
      createAuthService(),
    );
    const client = createClient();

    // 无 Origin 是桌面客户端的正常连接形态。
    await gateway.handleConnection(client, { headers: {} });
    client.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'jwt-token' })));
    await flushMessageHandler();

    expect(jwtService.verify).toHaveBeenCalledWith('jwt-token', { secret: 'access-secret' });
    expect(notificationsService.countUnread).toHaveBeenCalledTimes(1);
    expect(JSON.parse(client.send.mock.calls[0][0])).toEqual(
      expect.objectContaining({ type: 'connected', data: { unreadCount: 3 } }),
    );

    client.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));
    await flushMessageHandler();
    expect(JSON.parse(client.send.mock.calls[1][0])).toEqual(
      expect.objectContaining({ type: 'pong' }),
    );

    await gateway.pushToUser('user-1', { id: 'notification-1' });
    await gateway.pushUnreadCount('user-1', 2);
    expect(notificationsService.countUnread).toHaveBeenCalledTimes(1);
    expect(client.send).toHaveBeenCalledTimes(4);

    gateway.handleDisconnect(client);
  });

  it('冻结后推送前重新验证 session 并关闭通知连接', async () => {
    const authService = {
      validateUser: jest.fn()
        .mockResolvedValueOnce({ id: 'user-1' })
        .mockRejectedValueOnce(new UnauthorizedException({ code: 'ENTERPRISE_SUSPENDED' })),
    };
    const gateway = new NotificationsGateway(
      { verify: jest.fn().mockReturnValue({ sub: 'user-1', sid: 'session-1', type: 'access' }) } as any,
      { countUnread: jest.fn().mockResolvedValue(0) } as any,
      createConfig(),
      authService as any,
    );
    const client = createClient();
    await gateway.handleConnection(client, { headers: {} });
    client.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'jwt-token' })));
    await flushMessageHandler();

    await gateway.pushToUser('user-1', { id: 'must-not-arrive' });

    expect(authService.validateUser).toHaveBeenNthCalledWith(2, 'user-1', 'session-1');
    expect(client.close).toHaveBeenCalledWith(1008, 'Session expired');
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('拒绝 refresh/employment 等非 access token，避免错误令牌订阅通知流', async () => {
    const jwtService = {
      verify: jest.fn().mockReturnValue({ sub: 'user-1', type: 'client-employment' }),
    };
    const notificationsService = { countUnread: jest.fn() };
    const gateway = new NotificationsGateway(
      jwtService as any,
      notificationsService as any,
      createConfig(),
      createAuthService(),
    );
    const client = createClient();

    await gateway.handleConnection(client, { headers: {} });
    client.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'employment-token' })));
    await flushMessageHandler();

    expect(client.close).toHaveBeenCalledWith(1008, 'Invalid token');
    expect(notificationsService.countUnread).not.toHaveBeenCalled();
  });

  it('有 Origin 时拒绝未配置来源', async () => {
    const gateway = new NotificationsGateway(
      { verify: jest.fn() } as any,
      { countUnread: jest.fn() } as any,
      createConfig('https://sep.example.com'),
      createAuthService(),
    );
    const client = createClient();

    await gateway.handleConnection(client, { headers: { origin: 'https://evil.example.com' } });

    expect(client.close).toHaveBeenCalledWith(1008, 'Origin not allowed');
  });

  it('拒绝 sub 类型错误或非 ACTIVE 用户，且不会查询未读数', async () => {
    const jwtService = { verify: jest.fn().mockReturnValue({ sub: 123, type: 'access' }) };
    const notificationsService = { countUnread: jest.fn() };
    const authService = createAuthService();
    const gateway = new NotificationsGateway(
      jwtService as any,
      notificationsService as any,
      createConfig(),
      authService as any,
    );
    const client = createClient();

    await gateway.handleConnection(client, { headers: {} });
    client.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'jwt-token' })));
    await flushMessageHandler();

    expect(client.close).toHaveBeenCalledWith(1008, 'Invalid token');
    expect(authService.validateUser).not.toHaveBeenCalled();
    expect(notificationsService.countUnread).not.toHaveBeenCalled();

    const inactiveGateway = new NotificationsGateway(
      { verify: jest.fn().mockReturnValue({ sub: 'inactive-user', sid: 'session-1', type: 'access' }) } as any,
      notificationsService as any,
      createConfig(),
      createAuthService(null) as any,
    );
    const inactiveClient = createClient();
    await inactiveGateway.handleConnection(inactiveClient, { headers: {} });
    inactiveClient.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'jwt-token' })));
    await flushMessageHandler();

    expect(inactiveClient.close).toHaveBeenCalledWith(1008, 'Invalid token');
    expect(notificationsService.countUnread).not.toHaveBeenCalled();
  });

  it('未读数初始化失败返回内部错误，而不是伪装成无效令牌', async () => {
    const gateway = new NotificationsGateway(
      { verify: jest.fn().mockReturnValue({ sub: 'user-1', sid: 'session-1', type: 'access' }) } as any,
      { countUnread: jest.fn().mockRejectedValue(new Error('database unavailable')) } as any,
      createConfig(),
      createAuthService(),
    );
    const client = createClient();

    await gateway.handleConnection(client, { headers: {} });
    client.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'jwt-token' })));
    await flushMessageHandler();

    expect(client.close).toHaveBeenCalledWith(1011, 'Internal error');
  });

  it.each(['disconnect', 'timeout'])('认证查询等待期间 %s 后不登记旧连接', async (reason) => {
    let resolveCount!: (count: number) => void;
    const count = new Promise<number>((resolve) => { resolveCount = resolve; });
    const gateway = new NotificationsGateway(
      { verify: jest.fn().mockReturnValue({ sub: 'user-1', sid: 'session-1', type: 'access' }) } as any,
      { countUnread: jest.fn().mockReturnValue(count) } as any,
      createConfig(),
      createAuthService(),
    );
    const client = createClient();
    jest.useFakeTimers();
    try {
      await gateway.handleConnection(client, { headers: {} });
      client.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'jwt-token' })));
      await Promise.resolve();
      if (reason === 'disconnect') gateway.handleDisconnect(client);
      else jest.advanceTimersByTime(5000);
      resolveCount(3);
      await Promise.resolve();
      await gateway.pushToUser('user-1', { id: 'late' });
      expect(client.send).not.toHaveBeenCalled();
      expect(client.userId).toBeUndefined();
    } finally {
      gateway.handleDisconnect(client);
      jest.useRealTimers();
    }
  });

  it.each(['null', '[]', '123', '"auth"'])('拒绝非对象消息 %s 而不抛异步异常', async (raw) => {
    const gateway = new NotificationsGateway(
      { verify: jest.fn() } as any,
      { countUnread: jest.fn() } as any,
      createConfig(),
      createAuthService(),
    );
    const client = createClient();
    await gateway.handleConnection(client, { headers: {} });
    client.emit('message', Buffer.from(raw));
    await flushMessageHandler();
    expect(client.close).toHaveBeenCalledWith(1008, 'Invalid message');
  });

  it('单个连接发送异常不阻止同用户其他连接收到推送', async () => {
    const gateway = new NotificationsGateway(
      { verify: jest.fn().mockReturnValue({ sub: 'user-1', sid: 'session-1', type: 'access' }) } as any,
      { countUnread: jest.fn().mockResolvedValue(0) } as any,
      createConfig(),
      createAuthService(),
    );
    const clients = [createClient(), createClient()];
    for (const client of clients) {
      await gateway.handleConnection(client, { headers: {} });
      client.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'jwt-token' })));
      await flushMessageHandler();
    }
    clients[0].send.mockImplementation(() => { throw new Error('closed socket'); });
    await expect(gateway.pushToUser('user-1', { id: 'notification-1' })).resolves.toBeUndefined();
    expect(clients[1].send).toHaveBeenCalledTimes(2);
    clients.forEach((client) => gateway.handleDisconnect(client));
  });
});
