import { HttpException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../../redis/redis.service';
import { exceptionDetails } from '../../common/errors/error-diagnostics';

const LEASE_MS = 600_000;
const RENEW_MS = 60_000;
export interface VideoRecoveryLease { assertHeld(): void; release(): Promise<void> }

@Injectable()
export class MediaVideoRecoveryLeaseService {
  private readonly logger = new Logger(MediaVideoRecoveryLeaseService.name);
  constructor(private readonly redis: RedisService) {}

  async acquire(receiptId: string): Promise<VideoRecoveryLease | null> {
    const key = `sep:media:video-recovery:${receiptId}`;
    const token = randomUUID();
    const unavailable = (cause?: unknown) => new HttpException({ error: {
      code: 'VIDEO_RECOVERY_LOCK_UNAVAILABLE', message: '视频任务恢复锁不可用，请稍后查询原任务',
      origin: 'sep', stage: 'query', ...(cause === undefined ? {} : { details: exceptionDetails(cause) }),
    } }, 503);
    try {
      if (await this.redis.redis.set(key, token, 'PX', LEASE_MS, 'NX') !== 'OK') return null;
    } catch (error) { throw unavailable(error); }
    let lost: unknown;
    let heldUntil = Date.now() + LEASE_MS;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let renewing: Promise<void> | undefined;
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        renewing = this.redis.redis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
          1, key, token, LEASE_MS,
        ).then(result => {
          if (Number(result) !== 1) lost = unavailable();
          else { heldUntil = Date.now() + LEASE_MS; schedule(); }
        }).catch(error => { lost = unavailable(error); });
      }, RENEW_MS);
      timer.unref();
    };
    schedule();
    return {
      assertHeld: () => { if (lost || Date.now() >= heldUntil) throw lost ?? unavailable(); },
      release: async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        await renewing;
        try {
          await this.redis.redis.eval('if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
            1, key, token);
        } catch (error) {
          this.logger.warn({ event: 'video_recovery_lock_release_failed', receiptId, details: exceptionDetails(error) });
        }
      },
    };
  }
}
