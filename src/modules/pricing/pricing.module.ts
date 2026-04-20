import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VendorPricingRule, NeccPrice } from '../../database/entities';
import { PricingController } from './controllers/pricing.controller';
import { PricingService } from './services/pricing.service';

@Module({
  imports: [TypeOrmModule.forFeature([VendorPricingRule, NeccPrice])],
  controllers: [PricingController],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
