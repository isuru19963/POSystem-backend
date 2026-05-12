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
import { WhatsappModule } from '../../whatsapp/whatsapp.module';
import { OrdersDigestService } from './services/orders-digest.service';
import { OrdersDigestScheduler } from './schedulers/orders-digest.scheduler';
import { StorageModule } from '../../storage/storage.module';
import { PoModule } from '../po/po.module';
import { ValidationModule } from '../validation/validation.module';

@Module({
  imports: [
    AuthModule,
    WhatsappModule,
    StorageModule,
    PoModule,
    ValidationModule,
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
  providers: [AdminService, OrdersDigestService, OrdersDigestScheduler],
  exports: [AdminService, OrdersDigestService],
})
export class AdminModule {}
