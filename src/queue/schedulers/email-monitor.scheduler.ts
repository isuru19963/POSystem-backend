import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES, JOB_NAMES } from '../../common/constants/app.constants';

@Injectable()
export class EmailMonitorScheduler {
  private readonly logger = new Logger(EmailMonitorScheduler.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.PO_PROCESSING)
    private readonly poProcessingQueue: Queue,
  ) {}

  /**
   * Poll the PO email inbox every 5 minutes for new PO emails
   */
  @Cron('*/5 * * * *')
  async triggerEmailMonitoring(): Promise<void> {
    this.logger.log('Scheduling inbox monitoring job...');
    await this.poProcessingQueue.add(JOB_NAMES.MONITOR_INBOX, {}, {
      removeOnComplete: true,
      removeOnFail: 5,
    });
  }
}
