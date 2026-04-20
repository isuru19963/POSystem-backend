import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchaseOrder, Consolidation } from '../../database/entities';
import { ConsolidationController } from './controllers/consolidation.controller';
import { ConsolidationService } from './services/consolidation.service';

@Module({
  imports: [TypeOrmModule.forFeature([PurchaseOrder, Consolidation])],
  controllers: [ConsolidationController],
  providers: [ConsolidationService],
  exports: [ConsolidationService],
})
export class ConsolidationModule {}
