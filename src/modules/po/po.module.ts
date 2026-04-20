import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import {
  PurchaseOrder,
  PurchaseOrderLineItem,
  Vendor,
  Sku,
} from '../../database/entities';
import { PoController } from './controllers/po.controller';
import { PoService } from './services/po.service';
import { PdfExtractionService } from './services/pdf-extraction.service';
import { XlsExtractionService } from './services/xls-extraction.service';
import { QUEUE_NAMES } from '../../common/constants/app.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PurchaseOrder,
      PurchaseOrderLineItem,
      Vendor,
      Sku,
    ]),
    BullModule.registerQueue({ name: QUEUE_NAMES.PO_PROCESSING }),
  ],
  controllers: [PoController],
  providers: [PoService, PdfExtractionService, XlsExtractionService],
  exports: [PoService, PdfExtractionService, XlsExtractionService],
})
export class PoModule {}
