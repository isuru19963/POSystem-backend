import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  PurchaseOrder,
  PurchaseOrderLineItem,
  ShippingLocationMapping,
  Delivery,
  DeliveryLineItem,
  Consolidation,
  Route,
} from '../../database/entities';
import { ValidationController } from './controllers/validation.controller';
import { ValidationService } from './services/validation.service';
import { PricingModule } from '../pricing/pricing.module';
import { AlertsModule } from '../alerts/alerts.module';
import { EmailModule } from '../../email/email.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PurchaseOrder,
      PurchaseOrderLineItem,
      ShippingLocationMapping,
      Delivery,
      DeliveryLineItem,
      Consolidation,
      Route,
    ]),
    PricingModule,
    AlertsModule,
    EmailModule,
  ],
  controllers: [ValidationController],
  providers: [ValidationService],
  exports: [ValidationService],
})
export class ValidationModule {}
