import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Delivery, DeliveryLineItem, Route, PurchaseOrder } from '../../database/entities';
import { DispatchController } from './controllers/dispatch.controller';
import { DispatchService } from './services/dispatch.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Delivery, DeliveryLineItem, Route, PurchaseOrder]),
  ],
  controllers: [DispatchController],
  providers: [DispatchService],
  exports: [DispatchService],
})
export class DispatchModule {}
