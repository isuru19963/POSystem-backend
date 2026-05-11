import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlinkitProduct } from '../../database/entities/blinkit-product.entity';
import { BlinkitPromotion } from '../../database/entities/blinkit-promotion.entity';
import { BlinkitScrapeSession } from '../../database/entities/blinkit-scrape-session.entity';
import { BlinkitController } from './controllers/blinkit.controller';
import { BlinkitService } from './services/blinkit.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([BlinkitProduct, BlinkitPromotion, BlinkitScrapeSession]),
  ],
  controllers: [BlinkitController],
  providers: [BlinkitService],
  exports: [BlinkitService],
})
export class BlinkitModule {}
