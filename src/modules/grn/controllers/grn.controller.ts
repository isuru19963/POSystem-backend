import { Controller, Get, Post, Param, ParseUUIDPipe } from '@nestjs/common';
import { GrnService } from '../services/grn.service';

@Controller('grn')
export class GrnController {
  constructor(private readonly grnService: GrnService) {}

  @Get()
  findAll() {
    return this.grnService.findAll();
  }

  @Post(':id/match')
  performMatch(@Param('id', ParseUUIDPipe) id: string) {
    return this.grnService.performThreeWayMatch(id);
  }
}
