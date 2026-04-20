import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import {
  PurchaseOrder,
  Delivery,
  NeccPrice,
  Vendor,
} from '../../../database/entities';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepo: Repository<PurchaseOrder>,
    @InjectRepository(Delivery)
    private readonly deliveryRepo: Repository<Delivery>,
    @InjectRepository(NeccPrice)
    private readonly neccPriceRepo: Repository<NeccPrice>,
    @InjectRepository(Vendor)
    private readonly vendorRepo: Repository<Vendor>,
  ) {}

  async getVendorPerformance(
    fromDate: Date,
    toDate: Date,
  ): Promise<Record<string, unknown>[]> {
    const result = await this.poRepo
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
      .innerJoin('vendors', 'v', 'v.id = po.vendor_id')
      .where('po.po_date BETWEEN :fromDate AND :toDate', { fromDate, toDate })
      .groupBy('po.vendor_id')
      .addGroupBy('v.name')
      .getRawMany();

    return result;
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
