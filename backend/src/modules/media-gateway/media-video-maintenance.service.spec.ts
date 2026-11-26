import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { MediaVideoMaintenanceService } from './media-video-maintenance.service';
import { MediaVideoRealStore } from './media-video-real.store';
import { MediaVideoRealService } from './media-video-real.service';
import { VideoFileCacheService } from './video-file-cache.service';

describe('MediaVideoMaintenanceService', () => {
  function harness() {
    const store = { pendingRequests: jest.fn().mockResolvedValue({ records: [] }) };
    const media = { recoverPending: jest.fn().mockResolvedValue(undefined) };
    const cache = { pruneExpired: jest.fn().mockResolvedValue(0) };
    const service = new MediaVideoMaintenanceService(store as never, media as never, cache as never);
    return { store, media, cache, service };
  }
  afterEach(() => jest.restoreAllMocks());

  it('resumes bounded pages, isolates failed records and wraps back to new work', async () => {
    const h = harness(); const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    h.store.pendingRequests.mockResolvedValueOnce({ records: [
      { receiptId: 'a', scope: 'one' }, { receiptId: 'b', scope: 'two' },
    ], afterId: 'b' });
    h.media.recoverPending.mockRejectedValueOnce(new Error('Synthetic connection unavailable'));
    await h.service.recoverPending(); await h.service.recoverPending(); await h.service.recoverPending();
    expect(h.media.recoverPending.mock.calls).toEqual([['one', 'a'], ['two', 'b']]);
    expect(h.store.pendingRequests.mock.calls).toEqual([[20, undefined], [20, 'b'], [20, undefined]]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'video_background_recovery_failed', receiptId: 'a' }));
  });

  it('allows at most two recoveries at once and skips overlapping cron ticks', async () => {
    const h = harness(); const finish: Array<() => void> = [];
    h.store.pendingRequests.mockResolvedValueOnce({ records: Array.from({ length: 3 }, (_, i) => ({ scope: 's', receiptId: String(i) })) });
    h.media.recoverPending.mockImplementation(() => new Promise<void>(resolve => finish.push(resolve)));
    const pass = h.service.recoverPending();
    await new Promise(resolve => setImmediate(resolve));
    expect(h.media.recoverPending).toHaveBeenCalledTimes(2);
    await h.service.recoverPending(); expect(h.store.pendingRequests).toHaveBeenCalledTimes(1);
    finish[0](); finish[1](); await new Promise(resolve => setImmediate(resolve));
    expect(h.media.recoverPending).toHaveBeenCalledTimes(3); finish[2](); await pass;
  });

  it('retries a failed database scan on the next tick', async () => {
    const h = harness(); jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    h.store.pendingRequests.mockRejectedValueOnce(new Error('Synthetic database unavailable'));
    await h.service.recoverPending(); await h.service.recoverPending();
    expect(h.store.pendingRequests).toHaveBeenCalledTimes(2);
  });

  it('bounds cleanup, skips overlap and resumes after disk failures', async () => {
    const h = harness(); jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    let finish: () => void;
    h.cache.pruneExpired.mockImplementationOnce(() => new Promise<number>(resolve => { finish = () => resolve(1); }));
    const pass = h.service.pruneExpired(); await h.service.pruneExpired();
    expect(h.cache.pruneExpired).toHaveBeenCalledTimes(1); finish!(); await pass;
    h.cache.pruneExpired.mockRejectedValueOnce(new Error('Synthetic disk failure'));
    await h.service.pruneExpired(); await h.service.pruneExpired();
    expect(h.cache.pruneExpired.mock.calls).toEqual([[100], [100], [100]]);
  });

  it('registers real scheduler jobs, stays idle before their deadlines and stops on shutdown', async () => {
    const h = harness();
    jest.useFakeTimers({ now: new Date(2026, 10, 24, 0, 0, 0), doNotFake: ['nextTick', 'setImmediate'] });
    const module = await Test.createTestingModule({ imports: [ScheduleModule.forRoot()], providers: [
      MediaVideoMaintenanceService,
      { provide: MediaVideoRealStore, useValue: h.store },
      { provide: MediaVideoRealService, useValue: h.media },
      { provide: VideoFileCacheService, useValue: h.cache },
    ] }).compile();
    const app = module.createNestApplication();
    try {
      await app.init();
      const jobs = app.get(SchedulerRegistry);
      expect(jobs.getCronJobs().size).toBe(2);
      await jest.advanceTimersByTimeAsync(6 * 3600_000 - 1000);
      expect(h.store.pendingRequests).not.toHaveBeenCalled(); expect(h.cache.pruneExpired).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1000);
      expect(h.store.pendingRequests).toHaveBeenCalledTimes(1); expect(h.cache.pruneExpired).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(6 * 3600_000 - 1000);
      expect(h.store.pendingRequests).toHaveBeenCalledTimes(1);
      expect(h.cache.pruneExpired).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1000);
      expect(h.store.pendingRequests).toHaveBeenCalledTimes(2);
      expect(h.cache.pruneExpired).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(12 * 3600_000);
      expect(h.store.pendingRequests).toHaveBeenCalledTimes(4);
      expect(h.cache.pruneExpired).toHaveBeenCalledTimes(2);
      await app.close();
      await jest.advanceTimersByTimeAsync(12 * 3600_000);
      expect(h.store.pendingRequests).toHaveBeenCalledTimes(4); expect(h.cache.pruneExpired).toHaveBeenCalledTimes(2);
    } finally { await app.close(); jest.useRealTimers(); }
  });
});
