import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Grn, GrnLineItem, PurchaseOrder, Delivery } from '../../database/entities';
import { GrnController } from './controllers/grn.controller';
import { GrnService } from './services/grn.service';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Grn, GrnLineItem, PurchaseOrder, Delivery]),
    AlertsModule,
  ],
  controllers: [GrnController],
  providers: [GrnService],
  exports: [GrnService],
})
export class GrnModule {}
