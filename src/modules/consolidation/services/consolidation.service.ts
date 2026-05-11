import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, In } from 'typeorm';
import {
  PurchaseOrder,
  PoStatus,
  Consolidation,
} from '../../../database/entities';
import { EGGS_PER_CRATE } from '../../../common/constants/app.constants';

@Injectable()
export class ConsolidationService {
  private readonly logger = new Logger(ConsolidationService.name);

  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepo: Repository<PurchaseOrder>,
    @InjectRepository(Consolidation)
    private readonly consolidationRepo: Repository<Consolidation>,
  ) {}

  /**
   * Aggregate validated orders by SKU, City, and Route
   * Calculate total packs, total eggs, and required crates
   */
  async consolidate(date: Date): Promise<Consolidation[]> {
    const dateStr = date.toISOString().split('T')[0];
    this.logger.log(`Running consolidation for ${dateStr}`);

    // Use date range to reliably match the `date` column regardless of timezone
    const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
    const endOfDay = new Date(`${dateStr}T23:59:59.999Z`);

    // Get all validated POs for this date
    const pos = await this.poRepo.find({
      where: {
        poDate: Between(startOfDay, endOfDay) as any,
        status: PoStatus.VALIDATED,
      },
      relations: ['lineItems', 'lineItems.sku'],
    });

    if (pos.length === 0) {
      this.logger.log('No validated POs found for consolidation');
      return [];
    }

    // Group by city (shipping location)
    const cityGroups = new Map<string, PurchaseOrder[]>();
    for (const po of pos) {
      const city = po.shippingLocation;
      if (!cityGroups.has(city)) cityGroups.set(city, []);
      cityGroups.get(city)!.push(po);
    }

    const consolidations: Consolidation[] = [];

    for (const [city, cityPos] of cityGroups) {
      // Aggregate SKUs
      const skuTotals = new Map<
        string,
        { skuId: string; skuCode: string; skuName: string; totalPacks: number; packSize: number }
      >();

      const poIds: string[] = [];

      for (const po of cityPos) {
        poIds.push(po.id);
        for (const li of po.lineItems) {
          const key = li.skuId || li.itemCode;
          if (!skuTotals.has(key)) {
            skuTotals.set(key, {
              skuId: li.skuId || li.itemCode,
              skuCode: li.sku?.code || li.itemCode,
              skuName: li.sku?.name || li.itemName || '',
              totalPacks: 0,
              packSize: li.sku?.packSize || 1,
            });
          }
          skuTotals.get(key)!.totalPacks += li.quantity;
        }
      }

      const items = Array.from(skuTotals.values()).map((s) => ({
        skuId: s.skuId,
        skuCode: s.skuCode,
        skuName: s.skuName,
        totalPacks: s.totalPacks,
        totalEggs: s.totalPacks * s.packSize,
        requiredCrates: Math.ceil((s.totalPacks * s.packSize) / EGGS_PER_CRATE),
      }));

      const totalPacks = items.reduce((sum, i) => sum + i.totalPacks, 0);
      const totalEggs = items.reduce((sum, i) => sum + i.totalEggs, 0);
      const totalCrates = items.reduce((sum, i) => sum + i.requiredCrates, 0);

      // Upsert: update existing consolidation for this date+city, or create new
      let consolidation = await this.consolidationRepo.findOne({
        where: { consolidationDate: startOfDay as any, city },
      });

      if (consolidation) {
        consolidation.items = items;
        consolidation.totalPacks = totalPacks;
        consolidation.totalEggs = totalEggs;
        consolidation.totalCrates = totalCrates;
        consolidation.poIds = poIds;
      } else {
        consolidation = this.consolidationRepo.create({
          consolidationDate: date,
          city,
          items,
          totalPacks,
          totalEggs,
          totalCrates,
          poIds,
        });
      }

      consolidations.push(await this.consolidationRepo.save(consolidation));

      // Fix: use In() operator to update multiple POs by ID
      await this.poRepo.update(
        { id: In(poIds) },
        { status: PoStatus.CONSOLIDATED },
      );
    }

    this.logger.log(
      `Upserted ${consolidations.length} consolidations for ${pos.length} POs`,
    );
    return consolidations;
  }

  async findByDate(date: Date): Promise<Consolidation[]> {
    const dateStr = date.toISOString().split('T')[0];
    const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
    const endOfDay = new Date(`${dateStr}T23:59:59.999Z`);
    return this.consolidationRepo.find({
      where: { consolidationDate: Between(startOfDay, endOfDay) as any },
      order: { city: 'ASC' },
    });
  }
}
