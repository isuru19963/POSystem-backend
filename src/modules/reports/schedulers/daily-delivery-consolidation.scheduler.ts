import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DailyDeliveryConsolidationService } from '../services/daily-delivery-consolidation.service';

@Injectable()
export class DailyDeliveryConsolidationScheduler {
  private readonly logger = new Logger(DailyDeliveryConsolidationScheduler.name);

  constructor(
    private readonly consolidationReport: DailyDeliveryConsolidationService,
  ) {}

  /** 6:00 AM IST (= 00:30 UTC). Today's delivery SKU consolidation. */
  @Cron('30 0 * * *')
  async morningReport(): Promise<void> {
    await this.run('morning');
  }

  /** 7:00 PM IST (= 13:30 UTC). Today's delivery SKU consolidation. */
  @Cron('30 13 * * *')
  async eveningReport(): Promise<void> {
    await this.run('evening');
  }

  private async run(slot: 'morning' | 'evening'): Promise<void> {
    try {
      const r = await this.consolidationReport.sendScheduledReport(slot);
      this.logger.log(
        `Delivery SKU consolidation (${slot}): delivered=${r.delivered}/${r.attempted} POs=${r.orderCount} SKUs=${r.skuCount}${r.failed ? ` failed=${r.failed}` : ''}`,
      );
    } catch (e) {
      this.logger.error(
        `Delivery SKU consolidation (${slot}) failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}
