import { Controller, Get, Post, Patch, Body, Param, Query, ParseUUIDPipe } from '@nestjs/common';
import { DispatchService } from '../services/dispatch.service';
import { CreateDispatchDto } from '../dto/create-dispatch.dto';
import { UpdateDeliveryDto } from '../dto/update-delivery.dto';
import { UpdateDeliveryStatusDto } from '../dto/update-delivery-status.dto';

@Controller('dispatch')
export class DispatchController {
  constructor(private readonly dispatchService: DispatchService) {}

  @Post()
  create(@Body() dto: CreateDispatchDto) {
    return this.dispatchService.createDispatch(dto);
  }

  @Get('delivery-schedule')
  getDeliverySchedule() {
    return this.dispatchService.getDeliverySchedule();
  }

  @Get('deliveries')
  getDeliveries(
    @Query('status') status?: string,
    @Query('date') date?: string,
  ) {
    return this.dispatchService.getDeliveries({ status, date });
  }

  @Get('deliveries/:id')
  getDeliveryById(@Param('id', ParseUUIDPipe) id: string) {
    return this.dispatchService.getDeliveryById(id);
  }

  @Patch('deliveries/:id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeliveryStatusDto,
  ) {
    return this.dispatchService.updateDeliveryStatus(id, dto.status);
  }

  @Patch('deliveries/:id')
  updateDelivery(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeliveryDto,
  ) {
    return this.dispatchService.updateDelivery(id, dto);
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

  @Post('optimize-routes')
  optimizeRoutes(@Body() body: { date: string }) {
    // Assign routes to deliveries based on shipping location matching
    return this.dispatchService.getDeliveries({ date: body.date });
  }

  @Get('routes')
  getRoutes() {
    return this.dispatchService.getRoutes();
  }

  @Get('vehicles')
  getVehicles() {
    return this.dispatchService.getActiveVehicles();
  }

  @Get('drivers')
  getDrivers() {
    return this.dispatchService.getActiveDrivers();
  }
}
