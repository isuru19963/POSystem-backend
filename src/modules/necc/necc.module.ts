import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NeccPrice, ShippingLocationMapping } from '../../database/entities';
import { NeccController } from './controllers/necc.controller';
import { NeccService } from './services/necc.service';

@Module({
  imports: [TypeOrmModule.forFeature([NeccPrice, ShippingLocationMapping])],
  controllers: [NeccController],
  providers: [NeccService],
  exports: [NeccService],
})
export class NeccModule {}
