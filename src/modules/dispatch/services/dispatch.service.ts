import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Delivery,
  DeliveryLineItem,
  DispatchStatus,
  Route,
  PurchaseOrder,
  PoStatus,
  AlertType,
  Grn,
  GrnLineItem,
  GrnStatus,
  Sku,
  Vehicle,
  Driver,
} from '../../../database/entities';
import { CreateDispatchDto } from '../dto/create-dispatch.dto';
import { UpdateDeliveryDto } from '../dto/update-delivery.dto';
import { EGGS_PER_CRATE } from '../../../common/constants/app.constants';
import { AlertsService } from '../../alerts/services/alerts.service';

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    @InjectRepository(Delivery)
    private readonly deliveryRepo: Repository<Delivery>,
    @InjectRepository(DeliveryLineItem)
    private readonly lineItemRepo: Repository<DeliveryLineItem>,
    @InjectRepository(Route)
    private readonly routeRepo: Repository<Route>,
    @InjectRepository(PurchaseOrder)
    private readonly poRepo: Repository<PurchaseOrder>,
    @InjectRepository(Grn)
    private readonly grnRepo: Repository<Grn>,
    @InjectRepository(GrnLineItem)
    private readonly grnLineItemRepo: Repository<GrnLineItem>,
    @InjectRepository(Sku)
    private readonly skuRepo: Repository<Sku>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepo: Repository<Vehicle>,
    @InjectRepository(Driver)
    private readonly driverRepo: Repository<Driver>,
    private readonly alertsService: AlertsService,
  ) {}

  async getActiveVehicles(): Promise<Vehicle[]> {
    return this.vehicleRepo.find({
      where: { isActive: true },
      order: { vehicleNumber: 'ASC' },
    });
  }

  async getActiveDrivers(): Promise<Driver[]> {
    return this.driverRepo.find({
      where: { isActive: true },
      order: { name: 'ASC' },
    });
  }

  private async syncAutoGrnForDelivery(delivery: Delivery): Promise<boolean> {
    const hasDeliveredItems = delivery.lineItems.some((li) => li.deliveredQuantity > 0);
    if (!hasDeliveredItems) {
      this.logger.debug(`Delivery ${delivery.id} has no delivered quantities, skipping GRN`);
      return false;
    }

    const purchaseOrder = await this.poRepo.findOne({
      where: { id: delivery.purchaseOrderId },
      relations: ['lineItems'],
    });
    if (!purchaseOrder) {
      throw new NotFoundException(
        `PO ${delivery.purchaseOrderId} not found for delivery ${delivery.id}`,
      );
    }

    this.logger.debug(`Starting GRN auto-sync for delivery ${delivery.id}, PO ${delivery.purchaseOrderId}`);
    this.logger.debug(`  Delivery line items: ${delivery.lineItems.length}`);
    this.logger.debug(`  PO line items: ${purchaseOrder.lineItems.length}`);

    const skuCodeCandidates = Array.from(
      new Set(
        delivery.lineItems
          .flatMap((lineItem) => {
            const poLineItem = purchaseOrder.lineItems.find((poItem) => {
              if (lineItem.itemCode && poItem.itemCode === lineItem.itemCode) {
                return true;
              }

              return Boolean(
                lineItem.itemName &&
                  poItem.itemName &&
                  poItem.itemName.trim().toLowerCase() ===
                    lineItem.itemName.trim().toLowerCase(),
              );
            });

            return [lineItem.itemCode, poLineItem?.itemCode].filter(Boolean);
          })
          .map((code) => String(code)),
      ),
    );

    const skuRows = skuCodeCandidates.length
      ? await this.skuRepo
          .createQueryBuilder('sku')
          .where('sku.code IN (:...codes)', { codes: skuCodeCandidates })
          .getMany()
      : [];
    const activeSkus = await this.skuRepo.find({ where: { isActive: true } });

    const skuIdByCode = new Map(skuRows.map((sku) => [sku.code, sku.id]));

    const parsePackSize = (text?: string): number | undefined => {
      if (!text) return undefined;

      const pieceMatches = Array.from(
        text.matchAll(/(\d+)\s*(pcs|pieces)\b/gi),
      )
        .map((m) => Number(m[1]))
        .filter((v) => Number.isFinite(v));
      if (pieceMatches.length > 0) {
        return Math.max(...pieceMatches);
      }

      const packMatches = Array.from(text.matchAll(/(\d+)\s*pack\b/gi))
        .map((m) => Number(m[1]))
        .filter((v) => Number.isFinite(v) && v > 1);
      if (packMatches.length > 0) {
        return Math.max(...packMatches);
      }

      return undefined;
    };

    const detectBrand = (text?: string): string | undefined => {
      if (!text) return undefined;

      const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (normalized.includes('dr good eggs')) return 'dr good eggs';
      if (normalized.includes('premium fresh')) return 'premium fresh';
      if (normalized.includes('pure o fresh')) return 'pure o fresh';

      // Fallback for common feed naming that still belongs to Premium Fresh set.
      if (normalized.includes('omega') && normalized.includes('good eggs')) {
        return 'premium fresh';
      }

      return undefined;
    };

    const resolveSkuId = (lineItem: DeliveryLineItem): string | undefined => {
      if (lineItem.skuId) return lineItem.skuId;

      const poLineItem = purchaseOrder.lineItems.find((poItem) => {
        if (lineItem.itemCode && poItem.itemCode === lineItem.itemCode) {
          return true;
        }

        return Boolean(
          lineItem.itemName &&
            poItem.itemName &&
            poItem.itemName.trim().toLowerCase() ===
              lineItem.itemName.trim().toLowerCase(),
        );
      });

      const directSkuId = (
        poLineItem?.skuId ||
        (lineItem.itemCode ? skuIdByCode.get(lineItem.itemCode) : undefined) ||
        (poLineItem?.itemCode ? skuIdByCode.get(poLineItem.itemCode) : undefined)
      );

      if (directSkuId) return directSkuId;

      const combinedName = lineItem.itemName || poLineItem?.itemName;
      const brandKey = detectBrand(combinedName);
      const packSize = parsePackSize(combinedName);
      
      this.logger.debug(`SKU resolution for "${lineItem.itemName}": brandKey="${brandKey}", packSize=${packSize}`);
      
      if (!brandKey || !packSize) {
        this.logger.debug(`Skipping brand+pack matching: missing brandKey or packSize`);
        return undefined;
      }

      this.logger.debug(`Active SKUs count: ${activeSkus.length}`);
      activeSkus.forEach((sku, idx) => {
        if (idx < 5) {
          this.logger.debug(`  SKU[${idx}]: code=${sku.code}, brand="${sku.brand}", packSize=${sku.packSize}`);
        }
      });

      const matchedByBrandAndPack = activeSkus.find((sku) => {
        const skuBrand = (sku.brand || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
        const isMatch = skuBrand.includes(brandKey) && sku.packSize === packSize;
        if (isMatch || (skuBrand && brandKey)) {
          this.logger.debug(`  Checking SKU ${sku.code}: normalized brand="${skuBrand}", match=${isMatch}`);
        }
        return isMatch;
      });

      if (matchedByBrandAndPack) {
        this.logger.debug(`Matched SKU by brand+pack: ${matchedByBrandAndPack.id} (${matchedByBrandAndPack.code})`);
      } else {
        this.logger.debug(`No SKU matched for brand="${brandKey}", packSize=${packSize}`);
      }

      return matchedByBrandAndPack?.id;
    };

    const receivedLineItems = delivery.lineItems
      .filter((li) => li.deliveredQuantity > 0)
      .map((li) => {
        const poLineItem = purchaseOrder.lineItems.find((poItem) =>
          (li.itemCode && poItem.itemCode === li.itemCode) ||
          (li.itemName && poItem.itemName?.trim().toLowerCase() === li.itemName.trim().toLowerCase())
        );
        return {
          lineItem: li,
          skuId: resolveSkuId(li),
          itemCode: li.itemCode || poLineItem?.itemCode,
          itemName: li.itemName || poLineItem?.itemName,
        };
      });

    this.logger.debug(`Resolved line items: ${receivedLineItems.length} delivered items (${receivedLineItems.filter(e => e.skuId).length} with SKU match)`);
    if (receivedLineItems.length === 0) {
      this.logger.warn(`No delivered quantities for delivery ${delivery.id} - cannot create GRN`);
      return false;
    }

    const grnNumber = `AUTO-${delivery.id.slice(0, 8).toUpperCase()}`;
    const grnDate = delivery.actualDeliveryDate || new Date();

    let autoGrn = await this.grnRepo.findOne({
      where: { grnNumber },
      relations: ['lineItems'],
    });

    if (!autoGrn) {
      autoGrn = this.grnRepo.create({
        purchaseOrderId: delivery.purchaseOrderId,
        grnNumber,
        grnDate,
        status: GrnStatus.RECEIVED,
        lineItems: receivedLineItems.map(({ lineItem, skuId, itemCode, itemName }) =>
          this.grnLineItemRepo.create({
            skuId: skuId || undefined,
            itemCode,
            itemName,
            receivedQuantity: lineItem.deliveredQuantity,
            acceptedQuantity: lineItem.deliveredQuantity,
            rejectedQuantity: 0,
          }),
        ),
      });
      await this.grnRepo.save(autoGrn);
      return true;
    }

    autoGrn.purchaseOrderId = delivery.purchaseOrderId;
    autoGrn.grnDate = grnDate;

    await this.grnLineItemRepo.delete({ grnId: autoGrn.id });
    autoGrn.lineItems = receivedLineItems.map(({ lineItem, skuId, itemCode, itemName }) =>
      this.grnLineItemRepo.create({
        grnId: autoGrn!.id,
        skuId: skuId || undefined,
        itemCode,
        itemName,
        receivedQuantity: lineItem.deliveredQuantity,
        acceptedQuantity: lineItem.deliveredQuantity,
        rejectedQuantity: 0,
      }),
    );

    await this.grnRepo.save(autoGrn);
    return true;
  }

  async createDispatch(dto: CreateDispatchDto): Promise<Delivery> {
    const po = await this.poRepo.findOne({
      where: { id: dto.purchaseOrderId },
    });
    if (!po)
      throw new NotFoundException(`PO ${dto.purchaseOrderId} not found`);

    const delivery = this.deliveryRepo.create({
      purchaseOrderId: dto.purchaseOrderId,
      routeId: dto.routeId,
      vehicleNumber: dto.vehicleNumber,
      driverName: dto.driverName,
      driverPhone: dto.driverPhone,
      dispatchDate: new Date(dto.dispatchDate),
      status: DispatchStatus.PLANNED,
      lineItems: dto.lineItems.map((li) =>
        this.lineItemRepo.create({
          skuId: li.skuId,
          orderedQuantity: li.orderedQuantity,
          deliveredQuantity: 0,
          shortage: 0,
        }),
      ),
    });

    const saved = await this.deliveryRepo.save(delivery);

    // Update PO status
    po.status = PoStatus.DISPATCHED;
    await this.poRepo.save(po);

    return saved;
  }

  /** Generate packing summary for a dispatch date */
  async generatePackingSummary(
    date: Date,
  ): Promise<Record<string, unknown>> {
    const deliveries = await this.deliveryRepo.find({
      where: { dispatchDate: date },
      relations: ['lineItems', 'lineItems.sku', 'route', 'purchaseOrder'],
    });

    const summary: Record<string, unknown> = {};
    for (const delivery of deliveries) {
      const routeName = delivery.route?.name || 'Unassigned';
      const items = delivery.lineItems.map((li) => ({
        sku: li.sku?.code,
        packs: li.orderedQuantity,
        eggs: li.orderedQuantity * (li.sku?.packSize || 0),
        crates: Math.ceil(
          (li.orderedQuantity * (li.sku?.packSize || 0)) / EGGS_PER_CRATE,
        ),
      }));
      summary[routeName] = {
        vehicle: delivery.vehicleNumber,
        driver: delivery.driverName,
        items,
      };
    }
    return summary;
  }

  /** Record delivery quantities (manual entry) */
  async recordDelivery(
    deliveryId: string,
    lineItems: Array<{ lineItemId: string; deliveredQuantity: number }>,
  ): Promise<Delivery> {
    const delivery = await this.deliveryRepo.findOne({
      where: { id: deliveryId },
      relations: ['lineItems'],
    });
    if (!delivery)
      throw new NotFoundException(`Delivery ${deliveryId} not found`);

    for (const update of lineItems) {
      const li = delivery.lineItems.find((l) => l.id === update.lineItemId);
      if (li) {
        const deliveredQuantity = Math.max(
          0,
          Math.min(li.orderedQuantity, Math.floor(update.deliveredQuantity || 0)),
        );
        li.deliveredQuantity = deliveredQuantity;
        li.shortage = li.orderedQuantity - deliveredQuantity;
        await this.lineItemRepo.save(li);
      }
    }

    delivery.actualDeliveryDate = new Date();

    const hasShortage = delivery.lineItems.some((li) => li.shortage > 0);

    const saved = await this.deliveryRepo.save(delivery);
    let grnGenerated = false;

    try {
      grnGenerated = await this.syncAutoGrnForDelivery(delivery);
    } catch (err) {
      this.logger.error(`Failed to sync auto GRN for delivery ${deliveryId}: ${err}`);
    }

    if (hasShortage) {
      const shortLines = delivery.lineItems
        .filter((li) => li.shortage > 0)
        .map((li) => `SKU ${li.skuId}: ordered ${li.orderedQuantity}, delivered ${li.deliveredQuantity}, short ${li.shortage}`)
        .join('\n');
      try {
        await this.alertsService.createAlert({
          type: AlertType.SHORT_DELIVERY,
          subject: `Short delivery on Delivery ${deliveryId}`,
          message: `Short delivery recorded for delivery ${deliveryId}:\n${shortLines}`,
          referenceId: deliveryId,
          referenceType: 'delivery',
        });
      } catch (err) {
        this.logger.error(`Failed to create short delivery alert: ${err}`);
      }
    }

    (saved as Delivery & { grnGenerated?: boolean }).grnGenerated = grnGenerated;
    return saved;
  }

  async getRoutes(): Promise<Route[]> {
    return this.routeRepo.find({ where: { isActive: true } });
  }

  async getDeliveries(filters?: { status?: string; date?: string }): Promise<Delivery[]> {
    const qb = this.deliveryRepo.createQueryBuilder('d')
      .leftJoinAndSelect('d.lineItems', 'li')
      .leftJoinAndSelect('li.sku', 'sku')
      .leftJoinAndSelect('d.route', 'route')
      .leftJoinAndSelect('d.purchaseOrder', 'po')
      .orderBy('d.dispatchDate', 'DESC');

    if (filters?.status) {
      qb.andWhere('d.status = :status', { status: filters.status });
    }
    if (filters?.date) {
      qb.andWhere('CAST(d.dispatch_date AS date) = :date', { date: filters.date });
    }
    return qb.getMany();
  }

  /**
   * Returns a summary of pending deliveries grouped as:
   * - today: scheduled for today
   * - tomorrow: scheduled for tomorrow
   * - remaining: scheduled after tomorrow (not yet delivered/partial)
   */
  async getDeliverySchedule(): Promise<{ today: number; tomorrow: number; remaining: number }> {
    const todayStr = new Date().toISOString().slice(0, 10);
    const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const pendingStatuses = [DispatchStatus.PLANNED, DispatchStatus.IN_TRANSIT];

    const count = (date?: string, afterDate?: string): Promise<number> => {
      const qb = this.deliveryRepo.createQueryBuilder('d')
        .where('d.status IN (:...statuses)', { statuses: pendingStatuses });
      if (date) {
        qb.andWhere('CAST(d.dispatch_date AS date) = :date', { date });
      }
      if (afterDate) {
        qb.andWhere('CAST(d.dispatch_date AS date) > :afterDate', { afterDate });
      }
      return qb.getCount();
    };

    const [today, tomorrow, remaining] = await Promise.all([
      count(todayStr),
      count(tomorrowStr),
      count(undefined, tomorrowStr),
    ]);

    return { today, tomorrow, remaining };
  }

  async getDeliveryById(id: string): Promise<Delivery> {
    const delivery = await this.deliveryRepo.findOne({
      where: { id },
      relations: ['lineItems', 'lineItems.sku', 'route', 'purchaseOrder'],
    });
    if (!delivery) throw new NotFoundException(`Delivery ${id} not found`);
    return delivery;
  }

  async updateDeliveryStatus(id: string, status: string): Promise<Delivery> {
    await this.deliveryRepo.update(id, { status: status as DispatchStatus });
    return this.getDeliveryById(id);
  }

  async updateDelivery(id: string, dto: UpdateDeliveryDto): Promise<Delivery> {
    const delivery = await this.deliveryRepo.findOne({ where: { id } });
    if (!delivery) throw new NotFoundException(`Delivery ${id} not found`);

    const updates: Record<string, unknown> = {};
    if (dto.status !== undefined) updates['status'] = dto.status;
    if (dto.vehicleNumber !== undefined) updates['vehicleNumber'] = dto.vehicleNumber;
    if (dto.driverName !== undefined) updates['driverName'] = dto.driverName;
    if (dto.driverPhone !== undefined) updates['driverPhone'] = dto.driverPhone;
    if (dto.routeId !== undefined) updates['routeId'] = dto.routeId;
    if (dto.dispatchDate !== undefined) updates['dispatchDate'] = new Date(dto.dispatchDate);

    await this.deliveryRepo.update(id, updates);
    return this.getDeliveryById(id);
  }
}
