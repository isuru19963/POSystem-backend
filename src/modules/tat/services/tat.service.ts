import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TatConfig, PurchaseOrder } from '../../../database/entities';
import { AlertsService } from '../../alerts/services/alerts.service';
import { AlertType } from '../../../database/entities';

@Injectable()
export class TatService {
  private readonly logger = new Logger(TatService.name);

  constructor(
    @InjectRepository(TatConfig)
    private readonly tatRepo: Repository<TatConfig>,
    @InjectRepository(PurchaseOrder)
    private readonly poRepo: Repository<PurchaseOrder>,
    private readonly alertsService: AlertsService,
  ) {}

  /**
   * Check every hour if expected POs have been received
   */
  @Cron(CronExpression.EVERY_HOUR)
  async checkTat(): Promise<void> {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Find all TAT configs for today's day of week where expected time has passed
    const configs = await this.tatRepo.find({
      where: { dayOfWeek, isActive: true },
    });

    for (const config of configs) {
      if (currentTime < config.expectedBy) continue;

      // Check if PO was received today for this vendor
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const po = await this.poRepo.findOne({
        where: {
          vendorId: config.vendorId,
          poDate: today,
        },
      });

      if (!po) {
        this.logger.warn(
          `PO not received from vendor ${config.vendorId} by ${config.expectedBy}`,
        );
        await this.alertsService.createAlert({
          type: AlertType.PO_NOT_RECEIVED,
          subject: `PO Not Received`,
          message: `Expected PO from vendor ${config.vendorId} by ${config.expectedBy} today, but none received.`,
          referenceId: config.vendorId,
          referenceType: 'vendor',
        });
      }
    }
  }

  async getConfigs(vendorId?: string): Promise<TatConfig[]> {
    const where = vendorId ? { vendorId } : {};
    return this.tatRepo.find({ where });
  }

  async createConfig(data: Partial<TatConfig>): Promise<TatConfig> {
    return this.tatRepo.save(this.tatRepo.create(data));
  }
}
