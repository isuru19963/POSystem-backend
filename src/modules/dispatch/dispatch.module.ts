import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Delivery,
  DeliveryLineItem,
  Route,
  PurchaseOrder,
  Grn,
  GrnLineItem,
  Sku,
  Vehicle,
  Driver,
} from '../../database/entities';
import { DispatchController } from './controllers/dispatch.controller';
import { DispatchService } from './services/dispatch.service';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [
    AlertsModule,
    TypeOrmModule.forFeature([
      Delivery,
      DeliveryLineItem,
      Route,
      PurchaseOrder,
      Grn,
      GrnLineItem,
      Sku,
      Vehicle,
      Driver,
    ]),
  ],
  controllers: [DispatchController],
  providers: [DispatchService],
  exports: [DispatchService],
})
export class DispatchModule {}
