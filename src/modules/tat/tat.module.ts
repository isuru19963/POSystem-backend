import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TatConfig, PurchaseOrder } from '../../database/entities';
import { TatService } from './services/tat.service';
import { TatController } from './controllers/tat.controller';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TatConfig, PurchaseOrder]),
    AlertsModule,
  ],
  controllers: [TatController],
  providers: [TatService],
  exports: [TatService],
})
export class TatModule {}
