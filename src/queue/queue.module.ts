import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QUEUE_NAMES } from '../common/constants/app.constants';
import { PoProcessingProcessor } from './processors/po-processing.processor';
import { AlertDispatchProcessor } from './processors/alert-dispatch.processor';
import { EmailMonitorScheduler } from './schedulers/email-monitor.scheduler';
import { Alert } from '../database/entities';
import { EmailModule } from '../email/email.module';
import { StorageModule } from '../storage/storage.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PoModule } from '../modules/po/po.module';
import { GrnModule } from '../modules/grn/grn.module';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_NAMES.PO_PROCESSING },
      { name: QUEUE_NAMES.PDF_EXTRACTION },
      { name: QUEUE_NAMES.PRICE_VALIDATION },
      { name: QUEUE_NAMES.ALERT_DISPATCH },
      { name: QUEUE_NAMES.NECC_FETCH },
      { name: QUEUE_NAMES.EMAIL_MONITORING },
      { name: QUEUE_NAMES.GRN_PROCESSING },
    ),
    TypeOrmModule.forFeature([Alert]),
    EmailModule,
    StorageModule,
    WhatsappModule,
    PoModule,
    GrnModule,
  ],
  providers: [PoProcessingProcessor, AlertDispatchProcessor, EmailMonitorScheduler],
  exports: [BullModule],
})
export class QueueModule {}
