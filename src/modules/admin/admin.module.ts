import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Vendor,
  Sku,
  Route,
  ShippingLocationMapping,
  PurchaseOrder,
  PurchaseOrderLineItem,
  Delivery,
  DeliveryLineItem,
  Grn,
  GrnLineItem,
  Vehicle,
  Driver,
  AuditLog,
  User,
  NotificationContact,
  VendorPricingRule,
} from '../../database/entities';
import { AdminController } from './controllers/admin.controller';
import { AdminService } from './services/admin.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      Vendor,
      Sku,
      Route,
      ShippingLocationMapping,
      PurchaseOrder,
      PurchaseOrderLineItem,
      Delivery,
      DeliveryLineItem,
      Grn,
      GrnLineItem,
      Vehicle,
      Driver,
      AuditLog,
      User,
      NotificationContact,
      VendorPricingRule,
    ]),
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
