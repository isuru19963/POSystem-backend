import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminService } from '../services/admin.service';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '../../../database/entities';
import {
  CreateVendorDto,
  UpdateVendorDto,
  CreateSkuDto,
  UpdateSkuDto,
  CreateRouteDto,
  CreateLocationMappingDto,
  CreateVehicleDto,
  UpdateVehicleDto,
  CreateDriverDto,
  UpdateDriverDto,
  CreateUserDto,
  UpdateUserDto,
  SeedDefaultPricingRulesDto,
} from '../dto/admin.dto';

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // --- Vendors ---
  @Get('vendors')
  getVendors(
    @Query('customersOnly') customersOnly?: string,
    @Query('misimportsOnly') misimportsOnly?: string,
  ) {
    const truthy = (v?: string) =>
      v === 'true' || v === '1' || String(v || '').toLowerCase() === 'yes';
    return this.adminService.getVendors({
      customersOnly: truthy(customersOnly),
      misimportsOnly: truthy(misimportsOnly),
    });
  }

  @Post('vendors')
  createVendor(@Body() dto: CreateVendorDto) {
    return this.adminService.createVendor(dto);
  }

  @Put('vendors/:id')
  updateVendor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVendorDto,
  ) {
    return this.adminService.updateVendor(id, dto, 'system');
  }

  @Patch('vendors/:id')
  patchVendor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVendorDto,
  ) {
    return this.adminService.updateVendor(id, dto, 'system');
  }

  @Delete('vendors/:id')
  deleteVendor(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteVendor(id, 'system');
  }

  /** Add default pricing rules (all 3 brands) for every vendor missing a catch-all rule. */
  @Post('pricing-rules/seed-defaults-all-vendors')
  seedDefaultPricingRulesForAllVendors(@Body() dto: SeedDefaultPricingRulesDto) {
    return this.adminService.seedDefaultPricingRulesForAllVendors(dto, 'system');
  }

  // --- SKUs ---
  @Get('skus')
  getSkus() {
    return this.adminService.getSkus();
  }

  @Post('skus')
  createSku(@Body() dto: CreateSkuDto) {
    return this.adminService.createSku(dto);
  }

  @Put('skus/:id')
  updateSku(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSkuDto,
  ) {
    return this.adminService.updateSku(id, dto, 'system');
  }

  @Patch('skus/:id')
  patchSku(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSkuDto,
  ) {
    return this.adminService.updateSku(id, dto, 'system');
  }

  @Delete('skus/:id')
  deleteSku(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteSku(id, 'system');
  }

  // --- Routes ---
  @Get('routes')
  getRoutes() {
    return this.adminService.getRoutes();
  }

  @Post('routes')
  createRoute(@Body() dto: CreateRouteDto) {
    return this.adminService.createRoute(dto);
  }

  @Delete('routes/:id')
  deleteRoute(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteRoute(id, 'system');
  }

  // --- Location Mappings ---
  @Get('location-mappings')
  getLocationMappings() {
    return this.adminService.getLocationMappings();
  }

  @Get('shipping-mappings')
  getShippingMappings() {
    return this.adminService.getLocationMappings();
  }

  @Post('location-mappings')
  createLocationMapping(@Body() dto: CreateLocationMappingDto) {
    return this.adminService.createLocationMapping(dto);
  }

  @Delete('location-mappings/:id')
  deleteLocationMapping(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteLocationMapping(id, 'system');
  }

  @Post('shipping-mappings')
  createShippingMapping(@Body() dto: CreateLocationMappingDto) {
    return this.adminService.createLocationMapping(dto);
  }

  @Delete('shipping-mappings/:id')
  deleteShippingMapping(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteLocationMapping(id, 'system');
  }

  // --- PO / GRN cleanup ---
  @Delete('po/by-number/:poNumber')
  deletePoByNumber(@Param('poNumber') poNumber: string) {
    return this.adminService.deletePoByNumber(poNumber, 'system');
  }

  @Delete('grn/by-number/:grnNumber')
  deleteGrnByNumber(@Param('grnNumber') grnNumber: string) {
    return this.adminService.deleteGrnByNumber(grnNumber, 'system');
  }

  // --- Vehicles ---
  @Get('vehicles')
  getVehicles() {
    return this.adminService.getVehicles();
  }

  @Post('vehicles')
  createVehicle(@Body() dto: CreateVehicleDto) {
    return this.adminService.createVehicle(dto);
  }

  @Put('vehicles/:id')
  updateVehicle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleDto,
  ) {
    return this.adminService.updateVehicle(id, dto, 'system');
  }

  @Patch('vehicles/:id')
  patchVehicle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleDto,
  ) {
    return this.adminService.updateVehicle(id, dto, 'system');
  }

  @Delete('vehicles/:id')
  deleteVehicle(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteVehicle(id, 'system');
  }

  // --- Drivers ---
  @Get('drivers')
  getDrivers() {
    return this.adminService.getDrivers();
  }

  @Post('drivers')
  createDriver(@Body() dto: CreateDriverDto) {
    return this.adminService.createDriver(dto);
  }

  @Put('drivers/:id')
  updateDriver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDriverDto,
  ) {
    return this.adminService.updateDriver(id, dto, 'system');
  }

  @Patch('drivers/:id')
  patchDriver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDriverDto,
  ) {
    return this.adminService.updateDriver(id, dto, 'system');
  }

  @Delete('drivers/:id')
  deleteDriver(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteDriver(id, 'system');
  }

  // --- Users ---
  @Get('users')
  getUsers() {
    return this.adminService.getUsers();
  }

  @Post('users')
  createUser(@Body() dto: CreateUserDto) {
    return this.adminService.createUser(dto, 'system');
  }

  @Put('users/:id')
  updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.adminService.updateUser(id, dto, 'system');
  }

  @Patch('users/:id')
  patchUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.adminService.updateUser(id, dto, 'system');
  }

  @Delete('users/:id')
  deleteUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteUser(id, 'system');
  }

  // --- Audit Logs ---
  @Get('audit-logs')
  getAuditLogs(@Query('entityType') entityType?: string) {
    return this.adminService.getAuditLogs(entityType);
  }

  // --- Data Purge ---
  @Delete('purge/pos')
  purgeAllPOs() {
    return this.adminService.purgeAllPOs();
  }

  @Delete('purge/pos-and-vendors')
  purgeAllPosAndVendors() {
    return this.adminService.purgeAllPosAndVendors();
  }

  @Delete('purge/misimported-vendors')
  purgeMisimportedVendors() {
    return this.adminService.purgeMisimportedVendors('system');
  }

  // --- Public master data for dispatch assignment ---
  @Get('master/vehicles')
  getActiveVehicles() {
    return this.adminService.getActiveVehicles();
  }

  @Get('master/drivers')
  getActiveDrivers() {
    return this.adminService.getActiveDrivers();
  }

  // --- Notification Contacts (WhatsApp) ---
  @Get('notification-contacts')
  getNotificationContacts() {
    return this.adminService.getNotificationContacts();
  }

  @Post('notification-contacts')
  createNotificationContact(
    @Body() body: { label: string; phone: string; isActive?: boolean },
    @Param() _p: unknown,
    // Normally we'd get userId from JWT token; using system user here
  ) {
    return this.adminService.createNotificationContact(body, 'system');
  }

  @Patch('notification-contacts/:id')
  updateNotificationContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { label?: string; phone?: string; isActive?: boolean },
  ) {
    return this.adminService.updateNotificationContact(id, body, 'system');
  }

  @Delete('notification-contacts/:id')
  deleteNotificationContact(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteNotificationContact(id, 'system');
  }
}
