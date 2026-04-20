import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Vendor,
  Sku,
  Route,
  ShippingLocationMapping,
  AuditLog,
} from '../../../database/entities';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(Vendor)
    private readonly vendorRepo: Repository<Vendor>,
    @InjectRepository(Sku)
    private readonly skuRepo: Repository<Sku>,
    @InjectRepository(Route)
    private readonly routeRepo: Repository<Route>,
    @InjectRepository(ShippingLocationMapping)
    private readonly locationRepo: Repository<ShippingLocationMapping>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
  ) {}

  // --- Vendors ---
  async getVendors(): Promise<Vendor[]> {
    return this.vendorRepo.find({ order: { name: 'ASC' } });
  }

  async createVendor(data: Partial<Vendor>): Promise<Vendor> {
    return this.vendorRepo.save(this.vendorRepo.create(data));
  }

  async updateVendor(
    id: string,
    data: Partial<Vendor>,
    userId: string,
  ): Promise<Vendor> {
    const vendor = await this.vendorRepo.findOne({ where: { id } });
    if (!vendor) throw new NotFoundException(`Vendor ${id} not found`);

    await this.createAuditLog(userId, 'vendor', id, 'update', { ...vendor } as unknown as Record<string, unknown>, data as Record<string, unknown>);
    Object.assign(vendor, data);
    return this.vendorRepo.save(vendor);
  }

  // --- SKUs ---
  async getSkus(): Promise<Sku[]> {
    return this.skuRepo.find({ order: { code: 'ASC' } });
  }

  async createSku(data: Partial<Sku>): Promise<Sku> {
    return this.skuRepo.save(this.skuRepo.create(data));
  }

  async updateSku(
    id: string,
    data: Partial<Sku>,
    userId: string,
  ): Promise<Sku> {
    const sku = await this.skuRepo.findOne({ where: { id } });
    if (!sku) throw new NotFoundException(`SKU ${id} not found`);

    await this.createAuditLog(userId, 'sku', id, 'update', { ...sku } as unknown as Record<string, unknown>, data as Record<string, unknown>);
    Object.assign(sku, data);
    return this.skuRepo.save(sku);
  }

  // --- Routes ---
  async getRoutes(): Promise<Route[]> {
    return this.routeRepo.find({ order: { name: 'ASC' } });
  }

  async createRoute(data: Partial<Route>): Promise<Route> {
    return this.routeRepo.save(this.routeRepo.create(data));
  }

  // --- Location Mappings ---
  async getLocationMappings(): Promise<ShippingLocationMapping[]> {
    return this.locationRepo.find({ order: { shippingLocation: 'ASC' } });
  }

  async createLocationMapping(
    data: Partial<ShippingLocationMapping>,
  ): Promise<ShippingLocationMapping> {
    return this.locationRepo.save(this.locationRepo.create(data));
  }

  // --- Audit Logs ---
  async getAuditLogs(entityType?: string): Promise<AuditLog[]> {
    const where = entityType ? { entityType } : {};
    return this.auditRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  private async createAuditLog(
    userId: string,
    entityType: string,
    entityId: string,
    action: string,
    oldValue: Record<string, unknown>,
    newValue: Record<string, unknown>,
  ): Promise<void> {
    await this.auditRepo.save(
      this.auditRepo.create({
        userId,
        entityType,
        entityId,
        action,
        oldValue,
        newValue,
      }),
    );
  }
}
