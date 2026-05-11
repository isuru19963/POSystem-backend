import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Grn, GrnLineItem, PurchaseOrder, PurchaseOrderLineItem, Vendor, Delivery } from '../../database/entities';
import { GrnController } from './controllers/grn.controller';
import { GrnService } from './services/grn.service';
import { GrnPdfExtractionService } from './services/grn-pdf-extraction.service';
import { AiGrnExtractionService } from './services/ai-grn-extraction.service';
import { AlertsModule } from '../alerts/alerts.module';
import { EmailModule } from '../../email/email.module';
import { StorageModule } from '../../storage/storage.module';
import { QUEUE_NAMES } from '../../common/constants/app.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Grn, GrnLineItem, PurchaseOrder, PurchaseOrderLineItem, Vendor, Delivery]),
    AlertsModule,
    EmailModule,
    StorageModule,
    // `GrnController` enqueues inbox-monitor jobs onto the PO queue; the worker handles both PO + GRN emails.
    BullModule.registerQueue({ name: QUEUE_NAMES.PO_PROCESSING }),
  ],
  controllers: [GrnController],
  providers: [GrnService, GrnPdfExtractionService, AiGrnExtractionService],
  exports: [GrnService],
})
export class GrnModule {}
