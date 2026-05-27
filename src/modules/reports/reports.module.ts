import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  PurchaseOrder,
  PurchaseOrderLineItem,
  Delivery,
  DeliveryLineItem,
  Grn,
  GrnLineItem,
  NeccPrice,
  Vendor,
  Sku,
  NotificationContact,
} from '../../database/entities';
import { WhatsappModule } from '../../whatsapp/whatsapp.module';
import { ReportsController } from './controllers/reports.controller';
import { ReportsService } from './services/reports.service';
import { DailyDeliveryConsolidationService } from './services/daily-delivery-consolidation.service';
import { DailyDeliveryConsolidationScheduler } from './schedulers/daily-delivery-consolidation.scheduler';

@Module({
  imports: [
    WhatsappModule,
    TypeOrmModule.forFeature([
      PurchaseOrder,
      PurchaseOrderLineItem,
      Delivery,
      DeliveryLineItem,
      Grn,
      GrnLineItem,
      NeccPrice,
      Vendor,
      Sku,
      NotificationContact,
    ]),
  ],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    DailyDeliveryConsolidationService,
    DailyDeliveryConsolidationScheduler,
  ],
  exports: [ReportsService, DailyDeliveryConsolidationService],
})
export class ReportsModule {}
