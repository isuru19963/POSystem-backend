import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../../common/constants/app.constants';
import {
  drainDuplicateInboxJobs,
  enqueueInboxMonitor,
} from '../inbox-monitor.helpers';

@Injectable()
export class EmailMonitorScheduler implements OnModuleInit {
  private readonly logger = new Logger(EmailMonitorScheduler.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.PO_PROCESSING)
    private readonly poProcessingQueue: Queue,
  ) {}

  /**
   * On startup, clear any backlog of duplicate monitor-inbox jobs that piled
   * up while the worker was stuck on a previous slow IMAP fetch.
   */
  async onModuleInit(): Promise<void> {
    try {
      await drainDuplicateInboxJobs(this.poProcessingQueue, this.logger);
    } catch (err) {
      this.logger.warn(`Inbox queue drain on startup failed: ${err}`);
    }
  }

  /**
   * Poll the PO email inbox every 5 minutes. The helper skips enqueueing if a
   * monitor-inbox job is already waiting or active, so slow IMAP fetches no
   * longer cause a pileup.
   */
  @Cron('*/5 * * * *')
  async triggerEmailMonitoring(): Promise<void> {
    const { jobId, alreadyPending } = await enqueueInboxMonitor(
      this.poProcessingQueue,
      this.logger,
    );
    if (alreadyPending) {
      this.logger.debug(
        `Inbox monitor already in flight (${jobId}); skipping new schedule`,
      );
    } else {
      this.logger.log(`Scheduled inbox monitoring job ${jobId}`);
    }
  }
}
