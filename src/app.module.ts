import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';

// Config
import {
  databaseConfig,
  redisConfig,
  awsConfig,
  emailConfig,
  whatsappConfig,
  jwtConfig,
} from './config';

// Entities
import {
  Vendor,
  Sku,
  PurchaseOrder,
  PurchaseOrderLineItem,
  VendorPricingRule,
  NeccPrice,
  ShippingLocationMapping,
  Delivery,
  DeliveryLineItem,
  Route,
  Vehicle,
  Driver,
  Grn,
  GrnLineItem,
  Alert,
  User,
  AuditLog,
  Consolidation,
  TatConfig,
  BlinkitProduct,
  BlinkitPromotion,
  BlinkitScrapeSession,
  NotificationContact,
} from './database/entities';

// Shared Modules
import { StorageModule } from './storage/storage.module';
import { EmailModule } from './email/email.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';

// Feature Modules
import { PoModule } from './modules/po/po.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { NeccModule } from './modules/necc/necc.module';
import { ValidationModule } from './modules/validation/validation.module';
import { ConsolidationModule } from './modules/consolidation/consolidation.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { GrnModule } from './modules/grn/grn.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { AdminModule } from './modules/admin/admin.module';
import { TatModule } from './modules/tat/tat.module';
import { ReportsModule } from './modules/reports/reports.module';
import { AuthModule } from './modules/auth/auth.module';
import { BlinkitModule } from './modules/blinkit/blinkit.module';

// Queue
import { QueueModule } from './queue/queue.module';
import { MetaModule } from './meta/meta.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        databaseConfig,
        redisConfig,
        awsConfig,
        emailConfig,
        whatsappConfig,
        jwtConfig,
      ],
    }),

    // Database
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('database.host'),
        port: configService.get<number>('database.port'),
        username: configService.get<string>('database.username'),
        password: configService.get<string>('database.password'),
        database: configService.get<string>('database.database'),
        entities: [
          Vendor,
          Sku,
          PurchaseOrder,
          PurchaseOrderLineItem,
          VendorPricingRule,
          NeccPrice,
          ShippingLocationMapping,
          Delivery,
          DeliveryLineItem,
          Route,
          Vehicle,
          Driver,
          Grn,
          GrnLineItem,
          Alert,
          User,
          AuditLog,
          Consolidation,
          TatConfig,
          BlinkitProduct,
          BlinkitPromotion,
          BlinkitScrapeSession,
          NotificationContact,
        ],
        synchronize: false,
        migrations: [__dirname + '/database/migrations/**/*.{ts,js}'],
        migrationsRun: true,
        logging: process.env.NODE_ENV === 'development',
        ssl:
          process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : false,
      }),
      inject: [ConfigService],
    }),

    // BullMQ
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('redis.host'),
          port: configService.get<number>('redis.port'),
        },
      }),
      inject: [ConfigService],
    }),

    // Cron Jobs
    ScheduleModule.forRoot(),

    // Shared
    StorageModule,
    EmailModule,
    WhatsappModule,

    // Feature Modules
    AuthModule,
    PoModule,
    PricingModule,
    NeccModule,
    ValidationModule,
    ConsolidationModule,
    DispatchModule,
    GrnModule,
    AlertsModule,
    AdminModule,
    TatModule,
    ReportsModule,
    BlinkitModule,

    // Queue Workers
    QueueModule,

    MetaModule,
  ],
})
export class AppModule {}
