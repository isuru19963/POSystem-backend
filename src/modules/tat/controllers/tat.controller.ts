import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { TatService } from '../services/tat.service';
import { CreateTatConfigDto } from '../dto/create-tat-config.dto';

@Controller('tat')
export class TatController {
  constructor(private readonly tatService: TatService) {}

  @Get('configs')
  getConfigs(@Query('vendorId') vendorId?: string) {
    return this.tatService.getConfigs(vendorId);
  }

  @Post('configs')
  createConfig(@Body() dto: CreateTatConfigDto) {
    return this.tatService.createConfig(dto);
  }
}
