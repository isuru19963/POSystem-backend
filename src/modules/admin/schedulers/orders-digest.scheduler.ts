import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrdersDigestService } from '../services/orders-digest.service';

@Injectable()
export class OrdersDigestScheduler {
  private readonly logger = new Logger(OrdersDigestScheduler.name);

  constructor(private readonly ordersDigestService: OrdersDigestService) {}

  /** 08:00 IST daily (= 02:30 UTC; India has no DST). */
  @Cron('30 2 * * *')
  async handleDailyDigest(): Promise<void> {
    try {
      const r = await this.ordersDigestService.sendTodaysOrdersDigest();
      this.logger.log(
        `Today's Orders WhatsApp digest: sentTo=${r.sentTo} orderCount=${r.orderCount}`,
      );
    } catch (e) {
      this.logger.error(
        `Today's Orders digest failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}
