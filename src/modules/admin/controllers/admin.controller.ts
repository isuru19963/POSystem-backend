import { Controller, Get, Post, Put, Body, Param, Query, ParseUUIDPipe } from '@nestjs/common';
import { AdminService } from '../services/admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // --- Vendors ---
  @Get('vendors')
  getVendors() {
    return this.adminService.getVendors();
  }

  @Post('vendors')
  createVendor(@Body() data: { name: string; code: string; email?: string; phone?: string }) {
    return this.adminService.createVendor(data);
  }

  @Put('vendors/:id')
  updateVendor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: Record<string, unknown>,
  ) {
    // TODO: Extract userId from JWT token
    return this.adminService.updateVendor(id, data, 'system');
  }

  // --- SKUs ---
  @Get('skus')
  getSkus() {
    return this.adminService.getSkus();
  }

  @Post('skus')
  createSku(
    @Body()
    data: {
      code: string;
      name: string;
      brand: string;
      packSize: number;
      mrp?: number;
    },
  ) {
    return this.adminService.createSku(data);
  }

  @Put('skus/:id')
  updateSku(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: Record<string, unknown>,
  ) {
    return this.adminService.updateSku(id, data, 'system');
  }

  // --- Routes ---
  @Get('routes')
  getRoutes() {
    return this.adminService.getRoutes();
  }

  @Post('routes')
  createRoute(@Body() data: { name: string; stops: string[]; vehicleType?: string }) {
    return this.adminService.createRoute(data);
  }

  // --- Location Mappings ---
  @Get('location-mappings')
  getLocationMappings() {
    return this.adminService.getLocationMappings();
  }

  @Post('location-mappings')
  createLocationMapping(
    @Body() data: { shippingLocation: string; neccCity: string; state?: string },
  ) {
    return this.adminService.createLocationMapping(data);
  }

  // --- Audit Logs ---
  @Get('audit-logs')
  getAuditLogs(@Query('entityType') entityType?: string) {
    return this.adminService.getAuditLogs(entityType);
  }
}
