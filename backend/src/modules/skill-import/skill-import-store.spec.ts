import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { SkillImportStore } from './skill-import-store';

describe('Skill import Redis fencing and fail-closed behavior', () => {
  const redis = { get: jest.fn(), set: jest.fn(), eval: jest.fn(), zrem: jest.fn() };
  let store: SkillImportStore;
  beforeEach(() => {
    jest.useRealTimers(); jest.resetAllMocks();
    redis.get.mockResolvedValue(JSON.stringify({ value: 1 })); redis.set.mockResolvedValue('OK'); redis.eval.mockResolvedValue(1); redis.zrem.mockResolvedValue(1);
    store = new SkillImportStore({ redis } as unknown as RedisService, { get: () => 'store-test' } as unknown as ConfigService);
  });
  afterEach(() => jest.useRealTimers());

  it('fails closed instead of returning process-local state on Redis error', async () => {
    redis.get.mockRejectedValue(new Error('offline'));
    await expect(store.read('session')).rejects.toMatchObject({ status: 503 });
    redis.set.mockRejectedValue(new Error('offline'));
    await expect(store.put('session', { value: 1 })).rejects.toMatchObject({ status: 503 });
  });

  it('does not commit a writer that has lost the lock token', async () => {
    redis.eval.mockImplementation(async (script: string) => script.includes("redis.call('SET',KEYS[2]") ? 0 : 1);
    await expect(store.update<{ value: number }, number>('session', async (state) => ({ state: { value: state.value + 1 }, result: 2 }))).rejects.toMatchObject({ status: 409 });
  });

  it('bounds a hung Redis command to one second', async () => {
    jest.useFakeTimers(); redis.get.mockImplementation(() => new Promise(() => undefined));
    const assertion = expect(store.read('session')).rejects.toMatchObject({ status: 503 });
    await jest.advanceTimersByTimeAsync(1001); await assertion;
  });

  it('renews an owned lease during bounded external work and refuses commit after a failed renewal', async () => {
    jest.useFakeTimers();
    redis.eval.mockImplementation(async (script: string) => script.includes("redis.call('PEXPIRE',KEYS[1],15000)") ? 0 : 1);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const pending = store.update<{ value: number }, number>('session', async (state) => { await blocked; return { state, result: 1 }; });
    const assertion = expect(pending).rejects.toMatchObject({ status: 503 });
    await jest.advanceTimersByTimeAsync(4100); release(); await assertion;
    expect(redis.eval.mock.calls.some(([script]) => script.includes("redis.call('SET',KEYS[2]"))).toBe(false);
  });
});
