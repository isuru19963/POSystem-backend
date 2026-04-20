import { Controller, Get, Post, Body, Param, Query, ParseUUIDPipe } from '@nestjs/common';
import { DispatchService } from '../services/dispatch.service';
import { CreateDispatchDto } from '../dto/create-dispatch.dto';

@Controller('dispatch')
export class DispatchController {
  constructor(private readonly dispatchService: DispatchService) {}

  @Post()
  create(@Body() dto: CreateDispatchDto) {
    return this.dispatchService.createDispatch(dto);
  }

  @Get('packing-summary')
  packingSummary(@Query('date') date: string) {
    return this.dispatchService.generatePackingSummary(new Date(date));
  }

  @Post(':id/delivery')
  recordDelivery(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { lineItems: Array<{ lineItemId: string; deliveredQuantity: number }> },
  ) {
    return this.dispatchService.recordDelivery(id, body.lineItems);
  }

  @Get('routes')
  getRoutes() {
    return this.dispatchService.getRoutes();
  }
}
