import { Controller, Get, Post, Query } from '@nestjs/common';
import { ConsolidationService } from '../services/consolidation.service';

@Controller('consolidation')
export class ConsolidationController {
  constructor(private readonly consolidationService: ConsolidationService) {}

  @Post()
  consolidate(@Query('date') date: string) {
    return this.consolidationService.consolidate(new Date(date));
  }

  @Get()
  findByDate(@Query('date') date: string) {
    return this.consolidationService.findByDate(new Date(date));
  }
}
