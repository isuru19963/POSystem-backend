import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  PurchaseOrder,
  PurchaseOrderLineItem,
  ShippingLocationMapping,
} from '../../database/entities';
import { ValidationController } from './controllers/validation.controller';
import { ValidationService } from './services/validation.service';
import { PricingModule } from '../pricing/pricing.module';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PurchaseOrder,
      PurchaseOrderLineItem,
      ShippingLocationMapping,
    ]),
    PricingModule,
    AlertsModule,
  ],
  controllers: [ValidationController],
  providers: [ValidationService],
  exports: [ValidationService],
})
export class ValidationModule {}
