import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { exceptionDetails } from '../../common/errors/error-diagnostics';
import { MediaVideoRealStore } from './media-video-real.store';
import { MediaVideoRealService } from './media-video-real.service';
import { VideoFileCacheService } from './video-file-cache.service';

@Injectable()
export class MediaVideoMaintenanceService {
  private readonly logger = new Logger(MediaVideoMaintenanceService.name);
  private recovering = false;
  private cleaning = false;
  private afterId?: string;

  constructor(private readonly store: MediaVideoRealStore,
    private readonly media: MediaVideoRealService, private readonly cache: VideoFileCacheService) {}

  @Cron('0 0 */6 * * *', { name: 'media-video-recovery' })
  async recoverPending(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const page = await this.store.pendingRequests(20, this.afterId);
      this.afterId = page.afterId;
      // Bound downloads and provider queries independently of client traffic.
      for (let i = 0; i < page.records.length; i += 2) {
        await Promise.all(page.records.slice(i, i + 2).map(async record => {
          try { await this.media.recoverPending(record.scope, record.receiptId); }
          catch (error) {
            this.logger.warn({ event: 'video_background_recovery_failed', receiptId: record.receiptId, details: exceptionDetails(error) });
          }
        }));
      }
    } catch (error) {
      this.logger.warn({ event: 'video_background_scan_failed', details: exceptionDetails(error) });
    } finally { this.recovering = false; }
  }

  @Cron('0 0 */12 * * *', { name: 'media-video-cleanup' })
  async pruneExpired(): Promise<void> {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      const deleted = await this.cache.pruneExpired(100);
      if (deleted) this.logger.log({ event: 'video_expired_files_pruned', deleted });
    } catch (error) {
      this.logger.warn({ event: 'video_expired_file_cleanup_failed', details: exceptionDetails(error) });
    } finally { this.cleaning = false; }
  }
}
