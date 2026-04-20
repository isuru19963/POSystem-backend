import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../../common/constants/app.constants';
import { WhatsappService } from '../../whatsapp/whatsapp.service';
import { EmailService } from '../../email/email.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Alert, AlertChannel, AlertStatus } from '../../database/entities';

@Processor(QUEUE_NAMES.ALERT_DISPATCH)
export class AlertDispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(AlertDispatchProcessor.name);

  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly emailService: EmailService,
    @InjectRepository(Alert)
    private readonly alertRepo: Repository<Alert>,
  ) {
    super();
  }

  async process(job: Job<{ alertId: string }>): Promise<void> {
    const alert = await this.alertRepo.findOne({
      where: { id: job.data.alertId },
    });
    if (!alert) {
      this.logger.warn(`Alert ${job.data.alertId} not found`);
      return;
    }

    try {
      if (
        alert.channel === AlertChannel.WHATSAPP ||
        alert.channel === AlertChannel.BOTH
      ) {
        await this.whatsappService.sendGroupAlert(
          `${alert.subject}\n\n${alert.message}`,
        );
      }

      if (
        alert.channel === AlertChannel.EMAIL ||
        alert.channel === AlertChannel.BOTH
      ) {
        // In production, configure alert recipients
        this.logger.log(`Email alert dispatched: ${alert.subject}`);
      }

      alert.status = AlertStatus.SENT;
      alert.sentAt = new Date();
    } catch (error) {
      alert.status = AlertStatus.FAILED;
      alert.errorDetails =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Alert dispatch failed: ${alert.id}`, error);
    }

    await this.alertRepo.save(alert);
  }
}
