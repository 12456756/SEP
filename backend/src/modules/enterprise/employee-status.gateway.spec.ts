import { WebSocket } from 'ws';
import { EmployeeStatusGateway } from './employee-status.gateway';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createClient(userId: string) {
  return {
    userId,
    readyState: WebSocket.OPEN,
    send: jest.fn(),
    close: jest.fn(),
  } as any;
}

describe('EmployeeStatusGateway', () => {
  let gateway: EmployeeStatusGateway;
  let enterprise: { getEmployeeStatuses: jest.Mock };
  let getStatuses: (userId: string) => Promise<unknown>;
  let broadcast: () => Promise<void>;

  beforeEach(() => {
    enterprise = { getEmployeeStatuses: jest.fn() };
    gateway = new EmployeeStatusGateway(
      { verify: jest.fn() } as any,
      enterprise as any,
      { get: jest.fn().mockReturnValue('') } as any,
    );
    getStatuses = (gateway as any).getStatuses.bind(gateway);
    broadcast = (gateway as any).broadcast.bind(gateway);
  });

  it('合并同一用户的在途查询，并按用户隔离结果', async () => {
    const userOne = createClient('user-1');
    const userTwo = createClient('user-2');
    (gateway as any).clients.set('user-1', new Set([userOne]));
    (gateway as any).clients.set('user-2', new Set([userTwo]));
    const pending = deferred<unknown[]>();
    enterprise.getEmployeeStatuses.mockImplementation((userId: string) =>
      userId === 'user-1' ? pending.promise : Promise.resolve([{ employeeId: 'employee-2' }]),
    );

    const first = getStatuses('user-1');
    const second = getStatuses('user-1');
    expect(first).toBe(second);
    expect(enterprise.getEmployeeStatuses).toHaveBeenCalledTimes(1);

    pending.resolve([{ employeeId: 'employee-1' }]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ employeeId: 'employee-1' }],
      [{ employeeId: 'employee-1' }],
    ]);
    await expect(getStatuses('user-2')).resolves.toEqual([{ employeeId: 'employee-2' }]);
    expect(enterprise.getEmployeeStatuses).toHaveBeenNthCalledWith(2, 'user-2');
  });

  it('慢查询期间不重叠广播轮次，并在完成后允许下一轮发送', async () => {
    const client = createClient('user-1');
    (gateway as any).clients.set('user-1', new Set([client]));
    const pending = deferred<unknown[]>();
    enterprise.getEmployeeStatuses.mockReturnValue(pending.promise);

    const firstBroadcast = broadcast();
    const overlappingBroadcast = broadcast();
    expect(enterprise.getEmployeeStatuses).toHaveBeenCalledTimes(1);

    pending.resolve([{ employeeId: 'employee-1' }]);
    await Promise.all([firstBroadcast, overlappingBroadcast]);
    expect(client.send).toHaveBeenCalledTimes(1);

    await broadcast();
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(enterprise.getEmployeeStatuses).toHaveBeenCalledTimes(1);
  });

  it('限制跨用户状态查询并发数', async () => {
    const totalUsers = 10;
    let active = 0;
    let peak = 0;
    const releases = new Map<string, () => void>();
    enterprise.getEmployeeStatuses.mockImplementation((userId: string) =>
      new Promise((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        releases.set(userId, () => {
          if (!releases.has(userId)) return;
          releases.delete(userId);
          active -= 1;
          resolve([{ employeeId: userId }]);
        });
      }),
    );

    const pending = Array.from({ length: totalUsers }, (_, index) => getStatuses(`user-${index}`));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(enterprise.getEmployeeStatuses).toHaveBeenCalledTimes(8);
    expect(peak).toBe(8);

    while (releases.size > 0) {
      for (const release of Array.from(releases.values())) release();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await expect(Promise.all(pending)).resolves.toHaveLength(totalUsers);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('最后一个连接断开后不重新写入缓存或遗留在途请求', async () => {
    const client = createClient('user-1');
    (gateway as any).clients.set('user-1', new Set([client]));
    const pending = deferred<unknown[]>();
    enterprise.getEmployeeStatuses.mockReturnValue(pending.promise);

    const request = getStatuses('user-1');
    gateway.handleDisconnect(client);
    expect((gateway as any).statusCache.has('user-1')).toBe(false);

    pending.resolve([{ employeeId: 'employee-1' }]);
    await request;
    expect((gateway as any).statusCache.has('user-1')).toBe(false);
    expect((gateway as any).statusRequests.has('user-1')).toBe(false);
  });

  it('状态查询失败时返回脱敏原因并使用服务故障关闭码', async () => {
    const handlers = new Map<string, (raw: Buffer) => Promise<void>>();
    const client = { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn(),
      on: jest.fn((name: string, handler: (raw: Buffer) => Promise<void>) => handlers.set(name, handler)),
    };
    (gateway as any).jwt.verify.mockReturnValue({ sub: 'user-1' });
    enterprise.getEmployeeStatuses.mockRejectedValue(new Error('Database timeout password=status-secret'));
    await gateway.handleConnection(client as any, { headers: {} });
    await handlers.get('message')!(Buffer.from(JSON.stringify({ type: 'auth', token: 'token' })));
    expect(client.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', error: {
      name: 'Error', message: 'Database timeout password=[REDACTED]',
    } }));
    expect(client.close).toHaveBeenCalledWith(1011, 'Employee status query failed');
    expect(client.close).not.toHaveBeenCalledWith(1008, 'Invalid token');
    gateway.handleDisconnect(client as any);
  });
});
