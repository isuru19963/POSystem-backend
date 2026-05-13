import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import {
  PurchaseOrder,
  PurchaseOrderLineItem,
  Delivery,
  DeliveryLineItem,
  Grn,
  GrnLineItem,
  NeccPrice,
  Vendor,
  Sku,
} from '../../../database/entities';

/** Quick guard: TypeORM raw queries return strings for SUM/AVG — cast safely. */
function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
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
    @InjectRepository(NeccPrice)
    private readonly neccPriceRepo: Repository<NeccPrice>,
    @InjectRepository(Vendor)
    private readonly vendorRepo: Repository<Vendor>,
    @InjectRepository(Sku)
    private readonly skuRepo: Repository<Sku>,
  ) {}

  async getVendorPerformance(
    fromDate: Date,
    toDate: Date,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.poRepo
      .createQueryBuilder('po')
      .select('po.vendor_id', 'vendorId')
      .addSelect('v.name', 'vendorName')
      .addSelect('COUNT(po.id)', 'totalPos')
      .addSelect(
        `SUM(CASE WHEN po.status = 'validated' OR po.status = 'completed' THEN 1 ELSE 0 END)`,
        'validPos',
      )
      .addSelect(
        `SUM(CASE WHEN po.status = 'price_mismatch' THEN 1 ELSE 0 END)`,
        'mismatchPos',
      )
      .addSelect(
        `SUM(CASE WHEN po.status = 'delivered' OR po.status = 'completed' THEN 1 ELSE 0 END)`,
        'deliveredPos',
      )
      .addSelect('COALESCE(SUM(po.total_amount), 0)', 'totalAmount')
      .addSelect('COALESCE(AVG(po.total_amount), 0)', 'avgAmount')
      .innerJoin('vendors', 'v', 'v.id = po.vendor_id')
      .where('po.po_date BETWEEN :fromDate AND :toDate', { fromDate, toDate })
      .groupBy('po.vendor_id')
      .addGroupBy('v.name')
      .orderBy('"totalAmount"', 'DESC')
      .getRawMany();

    return rows.map((r) => {
      const totalPos = num(r.totalPos);
      const validPos = num(r.validPos);
      const deliveredPos = num(r.deliveredPos);
      return {
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        totalPos,
        validPos,
        mismatchPos: num(r.mismatchPos),
        deliveredPos,
        totalAmount: num(r.totalAmount),
        avgAmount: num(r.avgAmount),
        accuracyPercent: totalPos > 0 ? +((validPos / totalPos) * 100).toFixed(2) : 0,
        fulfillmentPercent:
          totalPos > 0 ? +((deliveredPos / totalPos) * 100).toFixed(2) : 0,
      };
    });
  }

  /**
   * Sum of `purchase_orders.total_amount` per city (shipping_location).
   * Empty / null shipping_location values are bucketed as "Unknown".
   */
  async getCityWisePoAmount(
    fromDate: Date,
    toDate: Date,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.poRepo
      .createQueryBuilder('po')
      .select(
        `COALESCE(NULLIF(TRIM(po.shipping_location), ''), 'Unknown')`,
        'city',
      )
      .addSelect('COUNT(po.id)', 'poCount')
      .addSelect('COALESCE(SUM(po.total_amount), 0)', 'totalAmount')
      .addSelect('COALESCE(AVG(po.total_amount), 0)', 'avgAmount')
      .where('po.po_date BETWEEN :fromDate AND :toDate', { fromDate, toDate })
      .groupBy('city')
      .orderBy('"totalAmount"', 'DESC')
      .getRawMany();

    return rows.map((r) => ({
      city: r.city,
      poCount: num(r.poCount),
      totalAmount: num(r.totalAmount),
      avgAmount: num(r.avgAmount),
    }));
  }

  /**
   * Per-product (PO line items) breakdown — total ordered quantity, total PO
   * value, average price and number of distinct POs containing the item.
   *
   * SKU is matched via the line_items.sku_id join when available; falls back
   * to `item_code` so unmapped products are still reported (under their PO
   * item code).
   */
  async getProductWise(
    fromDate: Date,
    toDate: Date,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.poLineItemRepo
      .createQueryBuilder('li')
      .select(`COALESCE(s.code, li.item_code, 'UNKNOWN')`, 'productCode')
      .addSelect(`COALESCE(s.name, li.item_name, 'Unnamed')`, 'productName')
      .addSelect('s.brand', 'brand')
      .addSelect('s.pack_size', 'packSize')
      .addSelect('COUNT(DISTINCT po.id)', 'poCount')
      .addSelect('COALESCE(SUM(li.quantity), 0)', 'totalQuantity')
      .addSelect('COALESCE(SUM(li.quantity * li.po_price), 0)', 'totalAmount')
      .addSelect('COALESCE(AVG(li.po_price), 0)', 'avgPrice')
      .innerJoin('purchase_orders', 'po', 'po.id = li.purchase_order_id')
      .leftJoin('skus', 's', 's.id = li.sku_id')
      .where('po.po_date BETWEEN :fromDate AND :toDate', { fromDate, toDate })
      .groupBy('s.code')
      .addGroupBy('li.item_code')
      .addGroupBy('s.name')
      .addGroupBy('li.item_name')
      .addGroupBy('s.brand')
      .addGroupBy('s.pack_size')
      .orderBy('"totalAmount"', 'DESC')
      .getRawMany();

    return rows.map((r) => ({
      productCode: r.productCode,
      productName: r.productName,
      brand: r.brand || null,
      packSize: r.packSize != null ? num(r.packSize) : null,
      poCount: num(r.poCount),
      totalQuantity: num(r.totalQuantity),
      totalAmount: num(r.totalAmount),
      avgPrice: num(r.avgPrice),
    }));
  }

  /**
   * Per-product breakdown of "not delivered" (shortage from GRNs) and
   * "returns" (GRN rejections), filtered by PO date range.
   *
   * For every PO line item in the window we compute:
   *  - orderedQty  = sum(li.quantity)
   *  - receivedQty = sum(grn.received_quantity) over linked GRNs (by item_code)
   *  - acceptedQty = sum(grn.accepted_quantity)
   *  - rejectedQty = sum(grn.rejected_quantity)
   *  - shortageQty = max(0, ordered - received)              // "not delivered"
   *  - shortageValue = shortageQty * avg poPrice              // value of shortage
   *  - returnsValue  = rejectedQty * avg poPrice              // value of returns
   */
  async getUndeliveredAndReturns(
    fromDate: Date,
    toDate: Date,
  ): Promise<{
    summary: Record<string, unknown>;
    items: Record<string, unknown>[];
  }> {
    const rows = await this.poLineItemRepo
      .createQueryBuilder('li')
      .select(`COALESCE(s.code, li.item_code, 'UNKNOWN')`, 'productCode')
      .addSelect(`COALESCE(s.name, li.item_name, 'Unnamed')`, 'productName')
      .addSelect('COALESCE(SUM(li.quantity), 0)', 'orderedQty')
      .addSelect('COALESCE(AVG(li.po_price), 0)', 'avgPoPrice')
      // GRN aggregates per PO line item (matched by item_code within the PO)
      .addSelect(
        `COALESCE((
          SELECT SUM(gli.received_quantity)
          FROM grn_line_items gli
          INNER JOIN grns g ON g.id = gli.grn_id
          WHERE g.purchase_order_id = li.purchase_order_id
            AND COALESCE(gli.item_code, '') = COALESCE(li.item_code, '')
        ), 0)`,
        'receivedQty',
      )
      .addSelect(
        `COALESCE((
          SELECT SUM(gli.accepted_quantity)
          FROM grn_line_items gli
          INNER JOIN grns g ON g.id = gli.grn_id
          WHERE g.purchase_order_id = li.purchase_order_id
            AND COALESCE(gli.item_code, '') = COALESCE(li.item_code, '')
        ), 0)`,
        'acceptedQty',
      )
      .addSelect(
        `COALESCE((
          SELECT SUM(gli.rejected_quantity)
          FROM grn_line_items gli
          INNER JOIN grns g ON g.id = gli.grn_id
          WHERE g.purchase_order_id = li.purchase_order_id
            AND COALESCE(gli.item_code, '') = COALESCE(li.item_code, '')
        ), 0)`,
        'rejectedQty',
      )
      .innerJoin('purchase_orders', 'po', 'po.id = li.purchase_order_id')
      .leftJoin('skus', 's', 's.id = li.sku_id')
      .where('po.po_date BETWEEN :fromDate AND :toDate', { fromDate, toDate })
      .groupBy('s.code')
      .addGroupBy('li.item_code')
      .addGroupBy('s.name')
      .addGroupBy('li.item_name')
      .addGroupBy('li.purchase_order_id')
      .getRawMany();

    // Roll up by product (collapse the per-PO grouping so shortages add up
    // across the date range).
    const byProduct = new Map<
      string,
      {
        productCode: string;
        productName: string;
        orderedQty: number;
        receivedQty: number;
        acceptedQty: number;
        rejectedQty: number;
        avgPoPriceSum: number;
        priceSamples: number;
      }
    >();

    for (const r of rows) {
      const key = r.productCode as string;
      const ordered = num(r.orderedQty);
      const received = num(r.receivedQty);
      const accepted = num(r.acceptedQty);
      const rejected = num(r.rejectedQty);
      const avgPrice = num(r.avgPoPrice);

      const existing = byProduct.get(key);
      if (existing) {
        existing.orderedQty += ordered;
        existing.receivedQty += received;
        existing.acceptedQty += accepted;
        existing.rejectedQty += rejected;
        existing.avgPoPriceSum += avgPrice;
        existing.priceSamples += 1;
      } else {
        byProduct.set(key, {
          productCode: key,
          productName: r.productName,
          orderedQty: ordered,
          receivedQty: received,
          acceptedQty: accepted,
          rejectedQty: rejected,
          avgPoPriceSum: avgPrice,
          priceSamples: 1,
        });
      }
    }

    const items = [...byProduct.values()].map((p) => {
      const shortageQty = Math.max(0, p.orderedQty - p.receivedQty);
      const avgPoPrice = p.priceSamples ? p.avgPoPriceSum / p.priceSamples : 0;
      const shortageValue = +(shortageQty * avgPoPrice).toFixed(2);
      const returnsValue = +(p.rejectedQty * avgPoPrice).toFixed(2);
      return {
        productCode: p.productCode,
        productName: p.productName,
        orderedQty: p.orderedQty,
        receivedQty: p.receivedQty,
        acceptedQty: p.acceptedQty,
        rejectedQty: p.rejectedQty,
        shortageQty,
        avgPoPrice: +avgPoPrice.toFixed(2),
        shortageValue,
        returnsValue,
        fulfillmentPercent:
          p.orderedQty > 0 ? +((p.receivedQty / p.orderedQty) * 100).toFixed(2) : 0,
      };
    });

    items.sort((a, b) => b.shortageValue + b.returnsValue - (a.shortageValue + a.returnsValue));

    const summary = items.reduce(
      (acc, x) => ({
        productsTracked: acc.productsTracked + 1,
        totalOrderedQty: acc.totalOrderedQty + x.orderedQty,
        totalReceivedQty: acc.totalReceivedQty + x.receivedQty,
        totalShortageQty: acc.totalShortageQty + x.shortageQty,
        totalRejectedQty: acc.totalRejectedQty + x.rejectedQty,
        totalShortageValue: +(acc.totalShortageValue + x.shortageValue).toFixed(2),
        totalReturnsValue: +(acc.totalReturnsValue + x.returnsValue).toFixed(2),
      }),
      {
        productsTracked: 0,
        totalOrderedQty: 0,
        totalReceivedQty: 0,
        totalShortageQty: 0,
        totalRejectedQty: 0,
        totalShortageValue: 0,
        totalReturnsValue: 0,
      },
    );

    return { summary, items };
  }

  async getCitySkuAnalytics(
    fromDate: Date,
    toDate: Date,
  ): Promise<Record<string, unknown>[]> {
    return this.poRepo
      .createQueryBuilder('po')
      .select('po.shipping_location', 'city')
      .addSelect('li.sku_id', 'skuId')
      .addSelect('s.code', 'skuCode')
      .addSelect('s.name', 'skuName')
      .addSelect('SUM(li.quantity)', 'totalQuantity')
      .addSelect('AVG(li.po_price)', 'avgPrice')
      .innerJoin('purchase_order_line_items', 'li', 'li.purchase_order_id = po.id')
      .innerJoin('skus', 's', 's.id = li.sku_id')
      .where('po.po_date BETWEEN :fromDate AND :toDate', { fromDate, toDate })
      .groupBy('po.shipping_location')
      .addGroupBy('li.sku_id')
      .addGroupBy('s.code')
      .addGroupBy('s.name')
      .getRawMany();
  }

  async getFulfillmentRates(
    fromDate: Date,
    toDate: Date,
  ): Promise<Record<string, unknown>> {
    const total = await this.poRepo.count({
      where: { poDate: Between(fromDate, toDate) },
    });

    const delivered = await this.poRepo.count({
      where: { poDate: Between(fromDate, toDate), status: 'delivered' as any },
    });

    const completed = await this.poRepo.count({
      where: { poDate: Between(fromDate, toDate), status: 'completed' as any },
    });

    return {
      totalOrders: total,
      delivered,
      completed,
      fulfillmentRate: total > 0 ? ((delivered + completed) / total) * 100 : 0,
    };
  }

  async getNeccTrends(
    city: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<NeccPrice[]> {
    return this.neccPriceRepo.find({
      where: { city, date: Between(fromDate, toDate) },
      order: { date: 'ASC' },
    });
  }

  async getDispatchSummary(date: Date): Promise<Record<string, unknown>[]> {
    return this.deliveryRepo
      .createQueryBuilder('d')
      .select('d.status', 'status')
      .addSelect('COUNT(d.id)', 'count')
      .where('d.dispatch_date = :date', { date })
      .groupBy('d.status')
      .getRawMany();
  }
}
