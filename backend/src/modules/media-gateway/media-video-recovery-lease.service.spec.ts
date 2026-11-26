import { Logger } from '@nestjs/common';
import { MediaVideoRecoveryLeaseService } from './media-video-recovery-lease.service';

describe('MediaVideoRecoveryLeaseService', () => {
  function harness() {
    const redis = { set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) };
    return { redis, service: new MediaVideoRecoveryLeaseService({ redis } as never) };
  }
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('does not enter work owned by another instance and fails on Redis outage', async () => {
    const h = harness(); h.redis.set.mockResolvedValueOnce(null);
    expect(await h.service.acquire('original')).toBeNull(); expect(h.redis.eval).not.toHaveBeenCalled();
    h.redis.set.mockRejectedValueOnce(new Error('Synthetic Redis unavailable'));
    await expect(h.service.acquire('original')).rejects.toMatchObject({ status: 503,
      response: { error: { code: 'VIDEO_RECOVERY_LOCK_UNAVAILABLE', details: { message: 'Synthetic Redis unavailable' } } } });
  });

  it('renews and releases using its own token and stops renewal on release', async () => {
    const h = harness(); const lease = await h.service.acquire('original');
    const [key, token] = h.redis.set.mock.calls[0];
    expect(h.redis.set).toHaveBeenCalledWith(key, token, 'PX', 600_000, 'NX');
    await jest.advanceTimersByTimeAsync(60_000); lease!.assertHeld();
    expect(h.redis.eval).toHaveBeenCalledWith(expect.stringContaining('pexpire'), 1, key, token, 600_000);
    await lease!.release(); const count = h.redis.eval.mock.calls.length;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(h.redis.eval).toHaveBeenCalledTimes(count);
    expect(h.redis.eval).toHaveBeenLastCalledWith(expect.stringContaining('del'), 1, key, token);
  });

  it.each([0, 'outage'])('stops side effects when renewal reports %s', async result => {
    const h = harness(); const lease = await h.service.acquire('original');
    if (result === 'outage') h.redis.eval.mockRejectedValueOnce(new Error('Synthetic Redis disconnected'));
    else h.redis.eval.mockResolvedValueOnce(result);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(() => lease!.assertHeld()).toThrow(); await lease!.release();
  });

  it('logs release failure without masking a completed task', async () => {
    const h = harness(); const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const lease = await h.service.acquire('original'); h.redis.eval.mockRejectedValueOnce(new Error('Synthetic release failure'));
    await expect(lease!.release()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'video_recovery_lock_release_failed', receiptId: 'original' }));
  });
});
