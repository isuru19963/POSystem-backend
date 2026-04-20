import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    this.logger.log(`Running consolidation for ${date.toISOString().split('T')[0]}`);

    // Get all validated POs for this date
    const pos = await this.poRepo.find({
      where: { poDate: date, status: PoStatus.VALIDATED },
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

      const consolidation = this.consolidationRepo.create({
        consolidationDate: date,
        city,
        items,
        totalPacks,
        totalEggs,
        totalCrates,
        poIds,
      });

      consolidations.push(await this.consolidationRepo.save(consolidation));

      // Update PO statuses
      await this.poRepo.update(
        poIds.map((id) => id),
        { status: PoStatus.CONSOLIDATED },
      );
    }

    this.logger.log(
      `Created ${consolidations.length} consolidations for ${pos.length} POs`,
    );
    return consolidations;
  }

  async findByDate(date: Date): Promise<Consolidation[]> {
    return this.consolidationRepo.find({
      where: { consolidationDate: date },
      order: { city: 'ASC' },
    });
  }
}
