import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull, QueryFailedError } from 'typeorm';
import * as bcrypt from 'bcrypt';
import {
  Vendor,
  Sku,
  Route,
  ShippingLocationMapping,
  PurchaseOrder,
  PurchaseOrderLineItem,
  Delivery,
  DeliveryLineItem,
  Grn,
  GrnLineItem,
  Vehicle,
  Driver,
  AuditLog,
  User,
  UserRole,
  NotificationContact,
  VendorPricingRule,
  PricingRuleType,
} from '../../../database/entities';
import { SeedDefaultPricingRulesDto } from '../dto/admin.dto';
import { PdfExtractionService, PdfExtractionResult } from '../../po/services/pdf-extraction.service';
import { XlsExtractionService } from '../../po/services/xls-extraction.service';
import { StorageService } from '../../../storage/storage.service';
import { ValidationService } from '../../validation/services/validation.service';
import {
  isGarbageCustomerLabel,
  looksLikeMisimportedVendorName,
  stripCustomerNameLabel,
  sanitizeVendorNameForImport,
} from '../../../common/utils/customer-name.util';
import { isOwnCompanyName } from '../../po/services/own-company';
import { PoService } from '../../po/services/po.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  private normalizeWhatsappPhone(raw: string): string {
    const trimmed = String(raw || '').trim();
    const digits = trimmed.replace(/\D/g, '');

    // Accept +<country><number> (spaces allowed), 91xxxxxxxxxx, or 10-digit local Indian number.
    if (trimmed.startsWith('+')) {
      const rest = trimmed.slice(1).replace(/\D/g, '');
      if (!/^[1-9]\d{6,14}$/.test(rest)) {
        throw new BadRequestException('Invalid WhatsApp number. Use E.164 format like +919876543210');
      }
      return `+${rest}`;
    }

    if (digits.length === 10) return `+91${digits}`;
    if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
    if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;

    throw new BadRequestException('Invalid WhatsApp number. Use E.164 format like +919876543210');
  }

  constructor(
    @InjectRepository(Vendor)
    private readonly vendorRepo: Repository<Vendor>,
    @InjectRepository(Sku)
    private readonly skuRepo: Repository<Sku>,
    @InjectRepository(Route)
    private readonly routeRepo: Repository<Route>,
    @InjectRepository(ShippingLocationMapping)
    private readonly locationRepo: Repository<ShippingLocationMapping>,
    @InjectRepository(PurchaseOrder)
    private readonly poRepo: Repository<PurchaseOrder>,
    @InjectRepository(PurchaseOrderLineItem)
    private readonly poLineItemRepo: Repository<PurchaseOrderLineItem>,
    @InjectRepository(Delivery)
    private readonly deliveryRepo: Repository<Delivery>,
    @InjectRepository(DeliveryLineItem)
    private readonly deliveryLineItemRepo: Repository<DeliveryLineItem>,
    @InjectRepository(Grn)
    private readonly grnRepo: Repository<Grn>,
    @InjectRepository(GrnLineItem)
    private readonly grnLineItemRepo: Repository<GrnLineItem>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepo: Repository<Vehicle>,
    @InjectRepository(Driver)
    private readonly driverRepo: Repository<Driver>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(NotificationContact)
    private readonly notifContactRepo: Repository<NotificationContact>,
    @InjectRepository(VendorPricingRule)
    private readonly vendorPricingRuleRepo: Repository<VendorPricingRule>,
    private readonly dataSource: DataSource,
    private readonly storageService: StorageService,
    private readonly pdfExtractionService: PdfExtractionService,
    private readonly xlsExtractionService: XlsExtractionService,
    private readonly validationService: ValidationService,
    private readonly poService: PoService,
  ) {}

  async purgeAllPOs(): Promise<{ deleted: Record<string, number> }> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const count = async (table: string): Promise<number> => {
        const rows = await runner.query(
          `SELECT COUNT(*)::int AS c FROM ${table}`,
        );
        return Number(rows[0]?.c ?? 0);
      };

      const purchaseOrders = await count('purchase_orders');
      const deliveries = await count('deliveries');
      const consolidations = await count('consolidations');
      const grns = await count('grns');

      const alerts = await runner.query(
        `DELETE FROM alerts WHERE reference_type IN ('purchase_order', 'delivery', 'grn') RETURNING id`,
      );

      // CASCADE removes all rows that reference purchase_orders (line items,
      // deliveries + delivery_line_items, grns + grn_line_items) in one shot.
      await runner.query(
        `TRUNCATE TABLE consolidations RESTART IDENTITY CASCADE`,
      );
      await runner.query(
        `TRUNCATE TABLE purchase_orders RESTART IDENTITY CASCADE`,
      );

      await runner.commitTransaction();
      return {
        deleted: {
          alerts: alerts.length,
          purchaseOrders,
          deliveries,
          consolidations,
          grns,
        },
      };
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }
  }

  /**
   * Deletes all purchase orders (and cascaded deliveries, GRNs, line items) plus every vendor
   * (customers), vendor pricing rules, and TAT configs. Consolidations are cleared.
   * Does not remove SKUs, NECC rates, shipping mappings, routes, users, or notification contacts.
   */
  async purgeAllPosAndVendors(): Promise<{ deleted: Record<string, number> }> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const count = async (table: string): Promise<number> => {
        const rows = await runner.query(
          `SELECT COUNT(*)::int AS c FROM ${table}`,
        );
        return Number(rows[0]?.c ?? 0);
      };

      const purchaseOrders = await count('purchase_orders');
      const deliveries = await count('deliveries');
      const consolidations = await count('consolidations');
      const grns = await count('grns');
      const vendors = await count('vendors');
      const pricingRules = await count('vendor_pricing_rules');
      const tatRows = await runner.query(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'tat_configs'
        ) AS e`,
      );
      const hasTat = tatRows[0]?.e === true || tatRows[0]?.e === 't';
      const tatConfigs = hasTat ? await count('tat_configs') : 0;

      const alerts = await runner.query(
        `DELETE FROM alerts WHERE reference_type IN ('purchase_order', 'delivery', 'grn') RETURNING id`,
      );

      await runner.query(
        `TRUNCATE TABLE consolidations RESTART IDENTITY CASCADE`,
      );
      // Vendors are parents of POs; CASCADE removes POs, deliveries, GRNs, line items,
      // vendor_pricing_rules, tat_configs, etc. that FK to vendors or purchase_orders.
      await runner.query(`TRUNCATE TABLE vendors RESTART IDENTITY CASCADE`);

      await runner.commitTransaction();
      return {
        deleted: {
          alerts: alerts.length,
          purchaseOrders,
          deliveries,
          consolidations,
          grns,
          vendors,
          vendorPricingRules: pricingRules,
          tatConfigs,
        },
      };
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }
  }

  /**
   * Creates one catch-all pricing rule per brand (Premium Fresh, dr. Good Eggs, Pure O Fresh)
   * for every vendor that does not already have an active catch-all rule for that brand.
   */
  async seedDefaultPricingRulesForAllVendors(
    dto: SeedDefaultPricingRulesDto,
    userId: string,
  ): Promise<{
    created: number;
    skipped: number;
    vendorCount: number;
    preview: Array<{ vendorName: string; brand: string; action: 'created' | 'skipped' }>;
  }> {
    const effectiveFrom = new Date(dto.effectiveFrom);
    effectiveFrom.setHours(0, 0, 0, 0);

    const skipExisting = dto.skipExisting !== false;
    const includeInactive = dto.includeInactiveVendors === true;

    const vendors = includeInactive
      ? await this.vendorRepo.find({ order: { name: 'ASC' } })
      : await this.vendorRepo.find({ where: { isActive: true }, order: { name: 'ASC' } });

    const premium = dto.premiumFreshMarginPerEgg ?? 1;
    const drPct = dto.drGoodEggsMarginPercent ?? 25;
    const purePct = dto.pureOFreshMarginPercent ?? 25;

    const specs: Array<{
      brand: string;
      type: PricingRuleType;
      margin: number;
      isPercentage: boolean;
    }> = [
      {
        brand: 'Premium Fresh',
        type: PricingRuleType.PREMIUM_FRESH,
        margin: premium,
        isPercentage: false,
      },
      {
        brand: 'dr. Good Eggs',
        type: PricingRuleType.DR_GOOD_EGGS,
        margin: drPct,
        isPercentage: true,
      },
      {
        brand: 'Pure O Fresh',
        type: PricingRuleType.PURE_O_FRESH,
        margin: purePct,
        isPercentage: true,
      },
    ];

    let created = 0;
    let skipped = 0;
    const preview: Array<{ vendorName: string; brand: string; action: 'created' | 'skipped' }> =
      [];

    for (const vendor of vendors) {
      for (const spec of specs) {
        if (skipExisting) {
          const existing = await this.vendorPricingRuleRepo.findOne({
            where: {
              vendorId: vendor.id,
              brand: spec.brand,
              isActive: true,
              shippingLocation: IsNull(),
              packSize: IsNull(),
            },
          });
          if (existing) {
            skipped++;
            if (preview.length < 80) {
              preview.push({
                vendorName: vendor.name,
                brand: spec.brand,
                action: 'skipped',
              });
            }
            continue;
          }
        }

        const rule = this.vendorPricingRuleRepo.create({
          vendorId: vendor.id,
          brand: spec.brand,
          type: spec.type,
          margin: spec.margin,
          isPercentage: spec.isPercentage,
          effectiveFrom,
          isActive: true,
        });
        await this.vendorPricingRuleRepo.save(rule);
        created++;
        if (preview.length < 80) {
          preview.push({
            vendorName: vendor.name,
            brand: spec.brand,
            action: 'created',
          });
        }
      }
    }

    const entityId = vendors[0]?.id ?? '00000000-0000-0000-0000-000000000001';
    await this.createAuditLog(userId, 'vendor_pricing_rules', entityId, 'seed_defaults_all_vendors', {}, {
      created,
      skipped,
      vendorCount: vendors.length,
      effectiveFrom: dto.effectiveFrom,
    });

    this.logger.log(
      `seedDefaultPricingRulesForAllVendors: created=${created} skipped=${skipped} vendors=${vendors.length}`,
    );

    return {
      created,
      skipped,
      vendorCount: vendors.length,
      preview,
    };
  }

  /**
   * Removes vendors that match PO-import junk patterns (see looksLikeMisimportedVendor),
   * their vendor_pricing_rules, and any POs + linked deliveries/GRNs for those vendors.
   * Real customers (Cloudkart, Deccan proper name, etc.) are not matched.
   */
  async purgeMisimportedVendors(userId: string): Promise<{
    deleted: {
      vendorIds: string[];
      vendors: number;
      purchaseOrders: number;
      pricingRules: number;
    };
  }> {
    const all = await this.vendorRepo.find();
    const junk = all.filter((v) => this.looksLikeMisimportedVendor(v));
    if (junk.length === 0) {
      return {
        deleted: {
          vendorIds: [],
          vendors: 0,
          purchaseOrders: 0,
          pricingRules: 0,
        },
      };
    }
    const junkIds = junk.map((v) => v.id);
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const [poPre] = await runner.query(
        `SELECT COUNT(*)::int AS c FROM purchase_orders WHERE vendor_id = ANY($1::uuid[])`,
        [junkIds],
      );
      const purchaseOrders = Number(poPre[0]?.c ?? 0);

      const rules = await runner.query(
        `DELETE FROM vendor_pricing_rules WHERE vendor_id = ANY($1::uuid[]) RETURNING id`,
        [junkIds],
      );

      await runner.query(
        `DELETE FROM alerts WHERE reference_type = 'purchase_order' AND reference_id IN (SELECT id::text FROM purchase_orders WHERE vendor_id = ANY($1::uuid[]))`,
        [junkIds],
      );
      await runner.query(
        `DELETE FROM alerts WHERE reference_type = 'delivery' AND reference_id IN (SELECT id::text FROM deliveries WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ANY($1::uuid[])))`,
        [junkIds],
      );
      await runner.query(
        `DELETE FROM alerts WHERE reference_type = 'grn' AND reference_id IN (SELECT id::text FROM grns WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ANY($1::uuid[])))`,
        [junkIds],
      );

      await runner.query(
        `DELETE FROM grn_line_items WHERE grn_id IN (SELECT id FROM grns WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ANY($1::uuid[])))`,
        [junkIds],
      );
      await runner.query(
        `DELETE FROM grns WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ANY($1::uuid[]))`,
        [junkIds],
      );
      await runner.query(
        `DELETE FROM delivery_line_items WHERE delivery_id IN (SELECT id FROM deliveries WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ANY($1::uuid[])))`,
        [junkIds],
      );
      await runner.query(
        `DELETE FROM deliveries WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ANY($1::uuid[]))`,
        [junkIds],
      );
      await runner.query(
        `DELETE FROM purchase_order_line_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ANY($1::uuid[]))`,
        [junkIds],
      );
      await runner.query(
        `DELETE FROM purchase_orders WHERE vendor_id = ANY($1::uuid[])`,
        [junkIds],
      );
      await runner.query(
        `DELETE FROM vendors WHERE id = ANY($1::uuid[])`,
        [junkIds],
      );

      await runner.commitTransaction();

      await this.createAuditLog(userId, 'vendor', junkIds[0], 'purge_misimports', {}, {
        vendorIds: junkIds,
        purchaseOrders,
        pricingRules: rules.length,
      });

      return {
        deleted: {
          vendorIds: junkIds,
          vendors: junkIds.length,
          purchaseOrders,
          pricingRules: rules.length,
        },
      };
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }
  }

  // --- Vendors ---
  /**
   * - `customersOnly`: real customers only (hides PO-line / UUID junk from imports).
   * - `misimportsOnly`: only rows that look like mistaken imports (for cleanup in Admin).
   * - neither: full list (legacy / exports).
   */
  async getVendors(opts?: {
    customersOnly?: boolean;
    misimportsOnly?: boolean;
  }): Promise<Vendor[]> {
    const vendors = await this.vendorRepo.find({ order: { name: 'ASC' } });
    if (opts?.misimportsOnly) {
      return vendors.filter((v) => this.looksLikeMisimportedVendor(v));
    }
    if (opts?.customersOnly) {
      return vendors.filter((v) => !this.looksLikeMisimportedVendor(v));
    }
    return vendors;
  }

  private looksLikeMisimportedVendor(v: Vendor): boolean {
    return looksLikeMisimportedVendorName(v.name || '', v.code);
  }

  /**
   * Fix existing vendor rows: strip "Buyer Name:" prefixes, purge "PO No :" junk,
   * merge duplicates when two rows resolve to the same company.
   */
  async repairVendorDisplayNames(userId: string): Promise<{
    renamed: number;
    merged: number;
    purged: number;
    purchaseOrdersReassigned: number;
  }> {
    const all = await this.vendorRepo.find({ order: { createdAt: 'ASC' } });
    let renamed = 0;
    let merged = 0;
    let purged = 0;
    let purchaseOrdersReassigned = 0;

    const findByName = async (name: string) =>
      this.vendorRepo.findOne({ where: { name } });

    for (const v of all) {
      const raw = (v.name || '').trim();
      if (!raw) continue;

      if (looksLikeMisimportedVendorName(raw, v.code)) {
        const pos = await this.poRepo.find({
          where: { vendorId: v.id },
          select: ['poNumber'],
        });
        for (const po of pos) {
          try {
            await this.repairPurchaseOrderCustomerFromStoredSource(
              po.poNumber,
              userId,
            );
          } catch {
            /* continue */
          }
        }
        const refreshed = await this.vendorRepo.findOne({ where: { id: v.id } });
        if (
          refreshed &&
          looksLikeMisimportedVendorName(refreshed.name, refreshed.code)
        ) {
          const poCount = await this.poRepo.count({ where: { vendorId: v.id } });
          if (poCount === 0) {
            await this.vendorRepo.delete(v.id);
            purged++;
          }
        }
        continue;
      }

      const fixed = stripCustomerNameLabel(raw);
      if (!fixed || isGarbageCustomerLabel(fixed) || fixed === raw) continue;

      const existing = await findByName(fixed);
      if (existing && existing.id !== v.id) {
        const updated = await this.poRepo.update(
          { vendorId: v.id },
          { vendorId: existing.id },
        );
        purchaseOrdersReassigned += updated.affected ?? 0;
        await this.vendorRepo.delete(v.id);
        merged++;
        continue;
      }

      v.name = fixed;
      v.code = fixed.replace(/\s+/g, '_').slice(0, 50);
      await this.vendorRepo.save(v);
      renamed++;
    }

    await this.createAuditLog(userId, 'vendor', 'bulk', 'repair_display_names', {}, {
      renamed,
      merged,
      purged,
      purchaseOrdersReassigned,
    });

    return { renamed, merged, purged, purchaseOrdersReassigned };
  }

  async createVendor(data: Partial<Vendor>): Promise<Vendor> {
    const name = sanitizeVendorNameForImport(data.name) || data.name?.trim();
    if (!name || isGarbageCustomerLabel(name)) {
      throw new BadRequestException(
        'Customer name must be a real company name, not a PO field label',
      );
    }
    return this.vendorRepo.save(this.vendorRepo.create({ ...data, name }));
  }

  async updateVendor(
    id: string,
    data: Partial<Vendor>,
    userId: string,
  ): Promise<Vendor> {
    const vendor = await this.vendorRepo.findOne({ where: { id } });
    if (!vendor) throw new NotFoundException(`Vendor ${id} not found`);

    if (data.name != null) {
      const name = sanitizeVendorNameForImport(data.name) || data.name.trim();
      if (!name || isGarbageCustomerLabel(name)) {
        throw new BadRequestException(
          'Customer name must be a real company name, not a PO field label',
        );
      }
      data.name = name;
    }

    await this.createAuditLog(userId, 'vendor', id, 'update', { ...vendor } as unknown as Record<string, unknown>, data as Record<string, unknown>);
    Object.assign(vendor, data);
    return this.vendorRepo.save(vendor);
  }

  async deleteVendor(id: string, userId: string): Promise<void> {
    const vendor = await this.vendorRepo.findOne({ where: { id } });
    if (!vendor) throw new NotFoundException(`Vendor ${id} not found`);

    await this.createAuditLog(
      userId,
      'vendor',
      id,
      'delete',
      { ...vendor } as unknown as Record<string, unknown>,
      {},
    );
    await this.vendorRepo.remove(vendor);
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

  async deleteSku(id: string, userId: string): Promise<void> {
    const sku = await this.skuRepo.findOne({ where: { id } });
    if (!sku) throw new NotFoundException(`SKU ${id} not found`);

    await this.createAuditLog(
      userId,
      'sku',
      id,
      'delete',
      { ...sku } as unknown as Record<string, unknown>,
      {},
    );
    await this.skuRepo.remove(sku);
  }

  // --- Routes ---
  async getRoutes(): Promise<Route[]> {
    return this.routeRepo.find({ order: { name: 'ASC' } });
  }

  async createRoute(data: Partial<Route>): Promise<Route> {
    return this.routeRepo.save(this.routeRepo.create(data));
  }

  async deleteRoute(id: string, userId: string): Promise<void> {
    const route = await this.routeRepo.findOne({ where: { id } });
    if (!route) throw new NotFoundException(`Route ${id} not found`);

    await this.createAuditLog(
      userId,
      'route',
      id,
      'delete',
      { ...route } as unknown as Record<string, unknown>,
      {},
    );
    await this.routeRepo.remove(route);
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

  async deleteLocationMapping(id: string, userId: string): Promise<void> {
    const mapping = await this.locationRepo.findOne({ where: { id } });
    if (!mapping) throw new NotFoundException(`Location mapping ${id} not found`);

    await this.createAuditLog(
      userId,
      'shipping_location_mapping',
      id,
      'delete',
      { ...mapping } as unknown as Record<string, unknown>,
      {},
    );
    await this.locationRepo.remove(mapping);
  }

  // --- PO / GRN cleanup ---
  async deletePoByNumber(poNumber: string, userId: string): Promise<{ deletedPoNumber: string }> {
    const po = await this.poRepo.findOne({ where: { poNumber } });
    if (!po) throw new NotFoundException(`PO ${poNumber} not found`);

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `DELETE FROM grn_line_items WHERE grn_id IN (SELECT id FROM grns WHERE purchase_order_id = $1)`,
        [po.id],
      );
      await runner.query(`DELETE FROM grns WHERE purchase_order_id = $1`, [po.id]);

      await runner.query(
        `DELETE FROM delivery_line_items WHERE delivery_id IN (SELECT id FROM deliveries WHERE purchase_order_id = $1)`,
        [po.id],
      );
      await runner.query(`DELETE FROM deliveries WHERE purchase_order_id = $1`, [po.id]);

      await runner.query(`DELETE FROM purchase_order_line_items WHERE purchase_order_id = $1`, [po.id]);
      await runner.query(`DELETE FROM purchase_orders WHERE id = $1`, [po.id]);

      await this.createAuditLog(userId, 'purchase_order', po.id, 'delete', {
        poNumber: po.poNumber,
      }, {});

      await runner.commitTransaction();
      return { deletedPoNumber: poNumber };
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }
  }

  private isGarbageCustomerLabel(name: string): boolean {
    return isGarbageCustomerLabel(name);
  }

  private extractionVendorIsUsable(name: string): boolean {
    const t = sanitizeVendorNameForImport(name) || name.trim();
    return !!t && !this.isGarbageCustomerLabel(t) && !isOwnCompanyName(t);
  }

  private scoreCustomerExtraction(result: PdfExtractionResult): number {
    let score = 0;
    if (this.extractionVendorIsUsable(result.vendorName ?? '')) {
      score += 20;
      if (/cloudstore/i.test(result.vendorName ?? '')) score += 8;
    }
    if (result.shippingLocation?.trim()) score += 4;
    if (result.lineItems?.length) score += Math.min(result.lineItems.length, 6);
    if (result.poNumber?.trim()) score += 2;
    return score;
  }

  private inferCloudstoreBuyerFallback(
    rawText: string,
    poNumber?: string,
  ): string | null {
    const po = (poNumber ?? '').trim();
    const isCloudstorePo =
      /^(CFF|CMP)PO/i.test(po) || /CLOUDSTORE/i.test(rawText);
    if (!isCloudstorePo) return null;
    if (/CLOUDSTORE\s+RETAIL/i.test(rawText)) {
      return 'Cloudstore Retail Private Limited';
    }
    return null;
  }

  private async extractFromStoredKey(
    s3Key: string,
    buffer: Buffer,
  ): Promise<PdfExtractionResult> {
    const lower = s3Key.toLowerCase();
    if (lower.endsWith('.pdf')) {
      return this.pdfExtractionService.extract(buffer);
    }
    if (/\.(xls|xlsx|csv)$/i.test(lower)) {
      const base = s3Key.split('/').pop() || s3Key;
      return this.xlsExtractionService.extract(buffer, base);
    }
    throw new BadRequestException(
      `Unsupported stored file type for key ${s3Key}; expected .pdf, .xls, .xlsx, or .csv`,
    );
  }

  /**
   * Cloudstore POs usually have both PDF + XLS on S3. The spreadsheet’s billing
   * block is more reliable than PDF text order (which often yields "PO No :").
   */
  private async attemptExtractCustomerFromStoredFiles(
    sourceRow: PurchaseOrder,
    poNumber: string,
  ): Promise<
    | { ok: true; extracted: PdfExtractionResult; sourceKey: string }
    | { ok: false; errors: string[]; allMissingStoredFiles: boolean }
  > {
    const keys = [
      ...new Set(
        [sourceRow.rawXlsFileKey, sourceRow.rawFileKey].filter(
          (k): k is string => !!k?.trim(),
        ),
      ),
    ];
    if (!keys.length) {
      throw new BadRequestException(
        'This PO has no stored PDF/XLS key on S3. Re-upload the file to repair.',
      );
    }

    let best: PdfExtractionResult | null = null;
    let bestKey = '';
    let bestScore = -1;
    const errors: string[] = [];

    for (const s3Key of keys) {
      try {
        const buffer = await this.storageService.getFile(s3Key);
        let extracted = await this.extractFromStoredKey(s3Key, buffer);
        const fallback = this.inferCloudstoreBuyerFallback(
          extracted.rawText ?? '',
          extracted.poNumber || poNumber,
        );
        if (
          fallback &&
          !this.extractionVendorIsUsable(extracted.vendorName ?? '')
        ) {
          extracted = { ...extracted, vendorName: fallback };
        }
        const score = this.scoreCustomerExtraction(extracted);
        this.logger.log(
          `Repair extract ${s3Key}: vendor="${extracted.vendorName || ''}" score=${score}`,
        );
        if (score > bestScore) {
          bestScore = score;
          best = extracted;
          bestKey = s3Key;
        }
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        errors.push(`${s3Key}: ${msg}`);
        this.logger.warn(`Repair skipped ${s3Key}: ${msg}`);
      }
    }

    if (best) {
      return { ok: true, extracted: best, sourceKey: bestKey };
    }

    const allMissingStoredFiles =
      errors.length > 0 &&
      errors.every((e) => /not found in S3|not found on server/i.test(e));

    return { ok: false, errors, allMissingStoredFiles };
  }

  private async extractBestCustomerFromStoredFiles(
    sourceRow: PurchaseOrder,
    poNumber: string,
  ): Promise<{
    extracted: PdfExtractionResult;
    sourceKey: string;
    restoredSourceFromEmail: boolean;
  }> {
    let row = sourceRow;
    let restoredSourceFromEmail = false;

    for (let pass = 0; pass < 2; pass++) {
      const attempt = await this.attemptExtractCustomerFromStoredFiles(row, poNumber);
      if (attempt.ok) {
        return {
          extracted: attempt.extracted,
          sourceKey: attempt.sourceKey,
          restoredSourceFromEmail,
        };
      }

      const msgId = row.emailMessageId?.trim();
      const canRestoreFromEmail = !!msgId && !msgId.startsWith('upload-');

      if (
        pass === 0 &&
        attempt.allMissingStoredFiles &&
        canRestoreFromEmail
      ) {
        this.logger.log(
          `S3 files missing for PO ${poNumber}; re-downloading attachments from email`,
        );
        try {
          await this.poService.restoreSourceFilesFromEmail(row.id);
          const refreshed = await this.poRepo.findOne({ where: { id: row.id } });
          if (refreshed) {
            row = refreshed;
            restoredSourceFromEmail = true;
            continue;
          }
        } catch (restoreErr) {
          const restoreMsg =
            (restoreErr as Error)?.message ?? String(restoreErr);
          throw new BadRequestException(
            `Stored files are missing from S3 and could not be restored from email: ${restoreMsg}`,
          );
        }
      }

      const hint = canRestoreFromEmail
        ? ' Open the PO drawer and use “Restore from email”, then try again.'
        : ' This PO was uploaded manually — re-upload the PDF or spreadsheet.';
      throw new BadRequestException(
        `Could not extract customer from any stored file. ${attempt.errors.join('; ')}.${hint}`,
      );
    }

    throw new BadRequestException(
      `Could not extract customer from stored files for PO ${poNumber}.`,
    );
  }

  /**
   * Re-fetch the PO’s stored PDF/XLS from S3, re-extract the buyer, and update
   * `vendor_id` + shipping location. Use after shipping parser fixes for rows
   * that were persisted with label junk (e.g. "PO No :") as the customer name.
   */
  async repairPurchaseOrderCustomerFromStoredSource(
    poNumber: string,
    userId: string,
  ): Promise<{
    purchaseOrderId: string;
    repairedPurchaseOrderIds: string[];
    poNumber: string;
    previousVendorId: string;
    previousVendorName: string;
    newVendorId: string;
    newVendorName: string;
    shippingLocation: string;
    restoredSourceFromEmail: boolean;
  }> {
    const trimmed = poNumber.trim();
    if (!trimmed) throw new BadRequestException('poNumber is required');

    const pos = await this.poRepo.find({
      where: { poNumber: trimmed },
      relations: ['vendor'],
      order: { createdAt: 'ASC' },
    });
    if (!pos.length) {
      throw new NotFoundException(`No purchase order found for number ${trimmed}`);
    }

    const junkVendor = (v?: Vendor | null) =>
      this.isGarbageCustomerLabel(v?.name ?? '');
    const hasKey = (p: PurchaseOrder) => !!(p.rawFileKey || p.rawXlsFileKey);

    let rowsToRepair = pos.filter((p) => junkVendor(p.vendor));
    if (!rowsToRepair.length) {
      rowsToRepair = [pos.find(hasKey) ?? pos[0]];
    }

    const sourceRow =
      rowsToRepair.find(hasKey) ?? pos.find(hasKey) ?? rowsToRepair[0];

    let extracted: PdfExtractionResult;
    let repairedFromS3Key: string;
    let restoredSourceFromEmail = false;
    try {
      const best = await this.extractBestCustomerFromStoredFiles(
        sourceRow,
        trimmed,
      );
      extracted = best.extracted;
      repairedFromS3Key = best.sourceKey;
      restoredSourceFromEmail = best.restoredSourceFromEmail;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`Re-extraction threw for ${trimmed}`, err as Error);
      throw new BadRequestException(
        `Re-extraction failed: ${(err as Error)?.message ?? String(err)}`,
      );
    }

    const vendorName = (extracted.vendorName ?? '').trim();
    if (!this.extractionVendorIsUsable(vendorName)) {
      throw new BadRequestException(
        `Re-extraction did not produce a usable customer name (got "${vendorName || '(empty)'}").`,
      );
    }

    const codeCandidate = vendorName.replace(/\s+/g, '_').substring(0, 50) || `v_${vendorName.length}`;
    let vendor: Vendor | null =
      (await this.vendorRepo.findOne({ where: { name: vendorName } })) ||
      (await this.vendorRepo.findOne({ where: { code: codeCandidate } }));
    if (!vendor) {
      let createCode = codeCandidate;
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          vendor = await this.vendorRepo.save(
            this.vendorRepo.create({
              name: vendorName,
              code: createCode.substring(0, 50),
            }),
          );
          break;
        } catch (err) {
          const pg = (err as { driverError?: { code?: string } })?.driverError?.code;
          if (pg === '23505' || err instanceof QueryFailedError) {
            createCode = `${codeCandidate}_${attempt + 1}`;
            continue;
          }
          throw err;
        }
      }
      if (!vendor) {
        throw new ConflictException(
          `Could not create vendor "${vendorName}" due to a database uniqueness conflict.`,
        );
      }
    }

    const shipLoc = extracted.shippingLocation?.trim() ?? '';
    const previousVendorId = rowsToRepair[0].vendorId;
    const previousVendorName = rowsToRepair[0].vendor?.name ?? '';

    const repairMeta = (row: PurchaseOrder) => {
      const base =
        row.extractedData && typeof row.extractedData === 'object'
          ? { ...(row.extractedData as Record<string, unknown>) }
          : {};
      row.extractedData = {
        ...base,
        repairedCustomerFromSourceAt: new Date().toISOString(),
        repairedFromS3Key: repairedFromS3Key,
        repairedExtractionVendorName: vendorName,
        repairedExtractionShippingLocation: extracted.shippingLocation ?? '',
      };
      if (shipLoc) row.shippingLocation = shipLoc;
    };

    /** Another row may already use (po_number, vendor_id) — unique index — e.g. duplicate imports. */
    const winnerSibling = await this.poRepo.findOne({
      where: { poNumber: trimmed, vendorId: vendor.id },
      relations: ['vendor'],
    });

    if (winnerSibling) {
      winnerSibling.rawFileKey = winnerSibling.rawFileKey || sourceRow.rawFileKey;
      winnerSibling.rawXlsFileKey = winnerSibling.rawXlsFileKey || sourceRow.rawXlsFileKey;
      repairMeta(winnerSibling);
      await this.poRepo.save(winnerSibling);

      for (const junk of rowsToRepair) {
        if (junk.id === winnerSibling.id) continue;
        const liN = await this.poLineItemRepo.count({ where: { purchaseOrderId: junk.id } });
        const poJ = await this.poRepo.findOne({
          where: { id: junk.id },
          relations: ['deliveries', 'grns'],
        });
        if (
          liN === 0 &&
          (poJ?.deliveries?.length ?? 0) === 0 &&
          (poJ?.grns?.length ?? 0) === 0
        ) {
          await this.poService.removeById(junk.id);
          await this.createAuditLog(
            userId,
            'purchase_order',
            junk.id,
            'repair_customer_removed_duplicate',
            { poNumber: junk.poNumber, keptPurchaseOrderId: winnerSibling.id },
            {},
          );
        } else {
          throw new ConflictException(
            `This PO number already exists for "${vendorName}" on row ${winnerSibling.id}, but duplicate row ${junk.id} still has line items, deliveries, or GRNs and cannot be removed automatically.`,
          );
        }
      }

      await this.createAuditLog(userId, 'purchase_order', winnerSibling.id, 'repair_customer', {
        poNumber: winnerSibling.poNumber,
        previousVendorId,
        previousVendorName,
        newVendorId: vendor.id,
        newVendorName: vendor.name,
        shippingLocation: winnerSibling.shippingLocation,
        mergedDuplicateJunkRows: true,
      }, {});

      try {
        await this.validationService.validatePo(winnerSibling.id);
      } catch (err) {
        this.logger.warn(
          `validatePo failed after customer repair for ${winnerSibling.poNumber}: ${(err as Error)?.message}`,
        );
      }

      return {
        purchaseOrderId: winnerSibling.id,
        repairedPurchaseOrderIds: [winnerSibling.id],
        poNumber: winnerSibling.poNumber,
        previousVendorId,
        previousVendorName,
        newVendorId: vendor.id,
        newVendorName: vendor.name,
        shippingLocation: winnerSibling.shippingLocation,
        restoredSourceFromEmail,
      };
    }

    const repairedIds: string[] = [];
    for (const row of rowsToRepair) {
      const prevId = row.vendorId;
      const prevName = row.vendor?.name ?? '';

      row.vendorId = vendor.id;
      repairMeta(row);

      try {
        await this.poRepo.save(row);
      } catch (err) {
        const pg = (err as { driverError?: { code?: string; detail?: string } })?.driverError
          ?.code;
        if (pg === '23505') {
          this.logger.error(`Unique violation saving PO ${row.id}`, err as Error);
          throw new ConflictException(
            `Cannot assign buyer "${vendorName}" to this PO: another row already has the same PO number and vendor (database unique index on po_number + vendor_id).`,
          );
        }
        throw err;
      }

      repairedIds.push(row.id);

      await this.createAuditLog(userId, 'purchase_order', row.id, 'repair_customer', {
        poNumber: row.poNumber,
        previousVendorId: prevId,
        previousVendorName: prevName,
        newVendorId: vendor.id,
        newVendorName: vendor.name,
        shippingLocation: row.shippingLocation,
      }, {});

      try {
        await this.validationService.validatePo(row.id);
      } catch (err) {
        this.logger.warn(
          `validatePo failed after customer repair for ${row.poNumber}: ${(err as Error)?.message}`,
        );
      }
    }

    const primary = rowsToRepair[0];
    return {
      purchaseOrderId: primary.id,
      repairedPurchaseOrderIds: repairedIds,
      poNumber: primary.poNumber,
      previousVendorId,
      previousVendorName,
      newVendorId: vendor.id,
      newVendorName: vendor.name,
      shippingLocation: primary.shippingLocation,
      restoredSourceFromEmail,
    };
  }

  async deleteGrnByNumber(grnNumber: string, userId: string): Promise<{ deletedGrnNumber: string }> {
    const grn = await this.grnRepo.findOne({ where: { grnNumber } });
    if (!grn) throw new NotFoundException(`GRN ${grnNumber} not found`);

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`DELETE FROM grn_line_items WHERE grn_id = $1`, [grn.id]);
      await runner.query(`DELETE FROM grns WHERE id = $1`, [grn.id]);

      await this.createAuditLog(userId, 'grn', grn.id, 'delete', {
        grnNumber: grn.grnNumber,
      }, {});

      await runner.commitTransaction();
      return { deletedGrnNumber: grnNumber };
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }
  }

  // --- Vehicles ---
  async getVehicles(): Promise<Vehicle[]> {
    return this.vehicleRepo.find({ order: { vehicleNumber: 'ASC' } });
  }

  async createVehicle(data: Partial<Vehicle>): Promise<Vehicle> {
    return this.vehicleRepo.save(this.vehicleRepo.create(data));
  }

  async updateVehicle(
    id: string,
    data: Partial<Vehicle>,
    userId: string,
  ): Promise<Vehicle> {
    const vehicle = await this.vehicleRepo.findOne({ where: { id } });
    if (!vehicle) throw new NotFoundException(`Vehicle ${id} not found`);

    await this.createAuditLog(userId, 'vehicle', id, 'update', { ...vehicle } as unknown as Record<string, unknown>, data as Record<string, unknown>);
    Object.assign(vehicle, data);
    return this.vehicleRepo.save(vehicle);
  }

  async deleteVehicle(id: string, userId: string): Promise<void> {
    const vehicle = await this.vehicleRepo.findOne({ where: { id } });
    if (!vehicle) throw new NotFoundException(`Vehicle ${id} not found`);

    await this.createAuditLog(
      userId,
      'vehicle',
      id,
      'delete',
      { ...vehicle } as unknown as Record<string, unknown>,
      {},
    );
    await this.vehicleRepo.remove(vehicle);
  }

  async getActiveVehicles(): Promise<Vehicle[]> {
    return this.vehicleRepo.find({
      where: { isActive: true },
      order: { vehicleNumber: 'ASC' },
    });
  }

  // --- Drivers ---
  async getDrivers(): Promise<Driver[]> {
    return this.driverRepo.find({ order: { name: 'ASC' } });
  }

  async createDriver(data: Partial<Driver>): Promise<Driver> {
    return this.driverRepo.save(this.driverRepo.create(data));
  }

  async updateDriver(
    id: string,
    data: Partial<Driver>,
    userId: string,
  ): Promise<Driver> {
    const driver = await this.driverRepo.findOne({ where: { id } });
    if (!driver) throw new NotFoundException(`Driver ${id} not found`);

    await this.createAuditLog(userId, 'driver', id, 'update', { ...driver } as unknown as Record<string, unknown>, data as Record<string, unknown>);
    Object.assign(driver, data);
    return this.driverRepo.save(driver);
  }

  async deleteDriver(id: string, userId: string): Promise<void> {
    const driver = await this.driverRepo.findOne({ where: { id } });
    if (!driver) throw new NotFoundException(`Driver ${id} not found`);

    await this.createAuditLog(
      userId,
      'driver',
      id,
      'delete',
      { ...driver } as unknown as Record<string, unknown>,
      {},
    );
    await this.driverRepo.remove(driver);
  }

  async getActiveDrivers(): Promise<Driver[]> {
    return this.driverRepo.find({
      where: { isActive: true },
      order: { name: 'ASC' },
    });
  }

  // --- Users ---
  async getUsers(): Promise<Array<Omit<User, 'passwordHash'>>> {
    const users = await this.userRepo.find({ order: { email: 'ASC' } });
    return users.map((user) => this.sanitizeUser(user));
  }

  async createUser(
    data: {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
      role?: UserRole;
      isActive?: boolean;
    },
    userId: string,
  ): Promise<Omit<User, 'passwordHash'>> {
    const existing = await this.userRepo.findOne({ where: { email: data.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(data.password, 12);
    const created = await this.userRepo.save(
      this.userRepo.create({
        email: data.email,
        passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        role: data.role || UserRole.VIEWER,
        isActive: data.isActive ?? true,
      }),
    );

    await this.createAuditLog(userId, 'user', created.id, 'create', {}, {
      email: created.email,
      firstName: created.firstName,
      lastName: created.lastName,
      role: created.role,
      isActive: created.isActive,
    });

    return this.sanitizeUser(created);
  }

  async updateUser(
    id: string,
    data: {
      email?: string;
      password?: string;
      firstName?: string;
      lastName?: string;
      role?: UserRole;
      isActive?: boolean;
    },
    userId: string,
  ): Promise<Omit<User, 'passwordHash'>> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User ${id} not found`);

    if (data.email && data.email !== user.email) {
      const existing = await this.userRepo.findOne({ where: { email: data.email } });
      if (existing) {
        throw new ConflictException('Email already registered');
      }
      user.email = data.email;
    }

    if (data.password) {
      user.passwordHash = await bcrypt.hash(data.password, 12);
    }
    if (data.firstName !== undefined) user.firstName = data.firstName;
    if (data.lastName !== undefined) user.lastName = data.lastName;
    if (data.role !== undefined) user.role = data.role;
    if (data.isActive !== undefined) user.isActive = data.isActive;

    const saved = await this.userRepo.save(user);

    await this.createAuditLog(userId, 'user', id, 'update', {}, {
      email: saved.email,
      firstName: saved.firstName,
      lastName: saved.lastName,
      role: saved.role,
      isActive: saved.isActive,
    });

    return this.sanitizeUser(saved);
  }

  async deleteUser(id: string, userId: string): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User ${id} not found`);

    await this.createAuditLog(
      userId,
      'user',
      id,
      'delete',
      {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isActive: user.isActive,
      },
      {},
    );
    await this.userRepo.remove(user);
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

  private sanitizeUser(user: User): Omit<User, 'passwordHash'> {
    const { passwordHash, ...safeUser } = user;
    return safeUser;
  }

  // --- Notification Contacts (WhatsApp) ---
  async getNotificationContacts(): Promise<NotificationContact[]> {
    return this.notifContactRepo.find({ order: { label: 'ASC' } });
  }

  async getActiveNotificationContacts(): Promise<NotificationContact[]> {
    return this.notifContactRepo.find({ where: { isActive: true }, order: { label: 'ASC' } });
  }

  async createNotificationContact(
    data: { label: string; phone: string; isActive?: boolean },
    userId: string,
  ): Promise<NotificationContact> {
    const normalizedPhone = this.normalizeWhatsappPhone(data.phone);
    const existing = await this.notifContactRepo.findOne({ where: { phone: normalizedPhone } });
    if (existing) throw new ConflictException(`Phone ${normalizedPhone} already registered`);
    const contact = await this.notifContactRepo.save(
      this.notifContactRepo.create({
        ...data,
        label: String(data.label || '').trim(),
        phone: normalizedPhone,
        isActive: data.isActive ?? true,
      }),
    );
    await this.createAuditLog(userId, 'notification_contact', contact.id, 'create', {}, { label: contact.label, phone: contact.phone });
    return contact;
  }

  async updateNotificationContact(
    id: string,
    data: Partial<{ label: string; phone: string; isActive: boolean }>,
    userId: string,
  ): Promise<NotificationContact> {
    const contact = await this.notifContactRepo.findOne({ where: { id } });
    if (!contact) throw new NotFoundException(`Notification contact ${id} not found`);
    const updateData = {
      ...data,
      ...(data.phone ? { phone: this.normalizeWhatsappPhone(data.phone) } : {}),
      ...(data.label != null ? { label: String(data.label).trim() } : {}),
    };
    await this.createAuditLog(userId, 'notification_contact', id, 'update', { ...contact } as unknown as Record<string, unknown>, data as Record<string, unknown>);
    Object.assign(contact, updateData);
    return this.notifContactRepo.save(contact);
  }

  async deleteNotificationContact(id: string, userId: string): Promise<void> {
    const contact = await this.notifContactRepo.findOne({ where: { id } });
    if (!contact) throw new NotFoundException(`Notification contact ${id} not found`);
    await this.createAuditLog(userId, 'notification_contact', id, 'delete', { ...contact } as unknown as Record<string, unknown>, {});
    await this.notifContactRepo.remove(contact);
  }

  /**
   * Bulk-import WhatsApp numbers from CSV (comma or tab separated).
   * Optional header: phone,label — otherwise each line is phone only or phone,label.
   */
  async importNotificationContactsFromCsv(
    csvRaw: string,
    userId: string,
  ): Promise<{
    created: number;
    updated: number;
    skipped: number;
    errors: Array<{ line: number; message: string }>;
  }> {
    const lines = csvRaw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    let startIdx = 0;
    if (
      lines.length > 0 &&
      /^(phone|whatsapp|number|mobile)\b/i.test(lines[0])
    ) {
      startIdx = 1;
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: Array<{ line: number; message: string }> = [];

    for (let i = startIdx; i < lines.length; i++) {
      const lineNum = i + 1;
      const parts = lines[i]
        .split(/[,\t]/)
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s.length > 0);
      if (parts.length === 0) {
        skipped++;
        continue;
      }

      try {
        const phone = this.normalizeWhatsappPhone(parts[0]);
        const label =
          (parts[1] && parts[1].trim()) ||
          `Contact ${phone.replace(/^\+/, '')}`;

        const existing = await this.notifContactRepo.findOne({
          where: { phone },
        });
        if (existing) {
          if (label && label !== existing.label) {
            existing.label = label;
            await this.notifContactRepo.save(existing);
            updated++;
          } else {
            skipped++;
          }
        } else {
          const contact = await this.notifContactRepo.save(
            this.notifContactRepo.create({
              phone,
              label,
              isActive: true,
            }),
          );
          created++;
          await this.createAuditLog(
            userId,
            'notification_contact',
            contact.id,
            'create',
            {},
            { label: contact.label, phone: contact.phone, source: 'csv_import' },
          );
        }
      } catch (e) {
        errors.push({
          line: lineNum,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await this.createAuditLog(userId, 'notification_contact', 'csv-import', 'import_csv', {}, {
      created,
      updated,
      skipped,
      errorCount: errors.length,
    });

    return { created, updated, skipped, errors };
  }
}
