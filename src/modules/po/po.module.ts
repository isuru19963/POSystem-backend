import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import {
  PurchaseOrder,
  PurchaseOrderLineItem,
  Vendor,
  Sku,
  Delivery,
  DeliveryLineItem,
  Grn,
  GrnLineItem,
} from '../../database/entities';
import { PoController } from './controllers/po.controller';
import { PoService } from './services/po.service';
import { SkuResolutionService } from './services/sku-resolution.service';
import { PdfExtractionService } from './services/pdf-extraction.service';
import { XlsExtractionService } from './services/xls-extraction.service';
import { AiPoExtractionService } from './services/ai-po-extraction.service';
import { QUEUE_NAMES } from '../../common/constants/app.constants';
import { EmailModule } from '../../email/email.module';
import { WhatsappModule } from '../../whatsapp/whatsapp.module';
import { StorageModule } from '../../storage/storage.module';
import { ValidationModule } from '../validation/validation.module';
import { NotificationContact } from '../../database/entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PurchaseOrder,
      PurchaseOrderLineItem,
      Vendor,
      Sku,
      Delivery,
      DeliveryLineItem,
      Grn,
      GrnLineItem,
      NotificationContact,
    ]),
    BullModule.registerQueue({ name: QUEUE_NAMES.PO_PROCESSING }),
    EmailModule,
    WhatsappModule,
    StorageModule,
    ValidationModule,
  ],
  controllers: [PoController],
  providers: [
    PoService,
    SkuResolutionService,
    PdfExtractionService,
    XlsExtractionService,
    AiPoExtractionService,
  ],
  exports: [
    PoService,
    SkuResolutionService,
    PdfExtractionService,
    XlsExtractionService,
    AiPoExtractionService,
  ],
})
export class PoModule {}
