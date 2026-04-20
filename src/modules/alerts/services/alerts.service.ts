import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Alert,
  AlertType,
  AlertChannel,
  AlertStatus,
} from '../../../database/entities';
import { WhatsappService } from '../../../whatsapp/whatsapp.service';
import { EmailService } from '../../../email/email.service';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    @InjectRepository(Alert)
    private readonly alertRepo: Repository<Alert>,
    private readonly whatsappService: WhatsappService,
    private readonly emailService: EmailService,
  ) {}

  async createAlert(data: {
    type: AlertType;
    subject: string;
    message: string;
    referenceId?: string;
    referenceType?: string;
    channel?: AlertChannel;
  }): Promise<Alert> {
    const alert = this.alertRepo.create({
      ...data,
      channel: data.channel || AlertChannel.BOTH,
      status: AlertStatus.PENDING,
    });
    const saved = await this.alertRepo.save(alert);

    // Dispatch alert asynchronously
    this.dispatchAlert(saved).catch((err) =>
      this.logger.error(`Failed to dispatch alert ${saved.id}`, err),
    );

    return saved;
  }

  private async dispatchAlert(alert: Alert): Promise<void> {
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
        // For email alerts, we'd need recipient config
        // This is a simplified version
        this.logger.log(`Email alert queued: ${alert.subject}`);
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

  async findAll(type?: AlertType): Promise<Alert[]> {
    const where = type ? { type } : {};
    return this.alertRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }
}
