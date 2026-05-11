import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, IsNull, Or, FindOptionsWhere } from 'typeorm';
import {
  VendorPricingRule,
  PricingRuleType,
  NeccPrice,
  Sku,
} from '../../../database/entities';

export interface CalculatedPrice {
  price: number;
  ruleType: PricingRuleType;
  neccPrice?: number;
  margin: number;
  breakdown: string;
}

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);

  constructor(
    @InjectRepository(VendorPricingRule)
    private readonly ruleRepo: Repository<VendorPricingRule>,
    @InjectRepository(NeccPrice)
    private readonly neccPriceRepo: Repository<NeccPrice>,
  ) {}

  /**
   * Calculate the expected price for a SKU based on vendor pricing rules
   * 
   * Premium Fresh: (NECC price [PO date - 1] + margin) × pack size
   * dr. Good Eggs: MRP - vendor margin
   */
  async calculatePrice(
    vendorId: string,
    sku: Sku,
    poDate: Date,
    city: string,
    poShippingLocation?: string,
  ): Promise<CalculatedPrice> {
    const baseWhere = {
      vendorId,
      brand: sku.brand,
      isActive: true,
      effectiveFrom: LessThanOrEqual(poDate),
      effectiveTo: Or(MoreThanOrEqual(poDate), IsNull()),
    };

    const rule = await this.findApplicableRule(baseWhere, sku.packSize, poShippingLocation);

    if (!rule) {
      throw new NotFoundException(
        `No active pricing rule found for vendor ${vendorId}, brand ${sku.brand}, pack size ${sku.packSize}`,
      );
    }

    switch (rule.type) {
      case PricingRuleType.PREMIUM_FRESH:
        return this.calculatePremiumFresh(rule, sku, poDate, city);
      case PricingRuleType.DR_GOOD_EGGS:
      case PricingRuleType.PURE_O_FRESH:
        return this.calculateDrGoodEggs(rule, sku);
      default:
        throw new Error(`Unsupported pricing rule type: ${rule.type}`);
    }
  }

  /**
   * Prefer pack-size + shipping-location-specific rules, then fall back to broader rules.
   * Rules with shipping_location set only match POs with the same ship-to; rules with null
   * shipping_location apply to any PO (for that pack-size tier).
   */
  private async findApplicableRule(
    baseWhere: {
      vendorId: string;
      brand: string;
      isActive: boolean;
      effectiveFrom: ReturnType<typeof LessThanOrEqual>;
      effectiveTo: ReturnType<typeof Or>;
    },
    packSize: number,
    poShippingLocation?: string,
  ): Promise<VendorPricingRule | null> {
    const ship = poShippingLocation?.trim();

    const tryOne = async (ps: number | ReturnType<typeof IsNull>, loc: string | ReturnType<typeof IsNull>) =>
      this.ruleRepo.findOne({
        where: { ...baseWhere, packSize: ps as any, shippingLocation: loc as any } as FindOptionsWhere<VendorPricingRule>,
        order: { effectiveFrom: 'DESC' },
      });

    const attempts: Array<[number | ReturnType<typeof IsNull>, string | ReturnType<typeof IsNull>]> = [];
    if (ship) {
      attempts.push([packSize, ship]);
      attempts.push([packSize, IsNull()]);
      attempts.push([IsNull() as any, ship]);
      attempts.push([IsNull() as any, IsNull()]);
    } else {
      attempts.push([packSize, IsNull()]);
      attempts.push([IsNull() as any, IsNull()]);
    }

    for (const [ps, loc] of attempts) {
      const found = await tryOne(ps, loc);
      if (found) return found;
    }
    return null;
  }

  /**
   * Premium Fresh: (NECC price [PO date - 1] + margin) × pack size
   */
  private async calculatePremiumFresh(
    rule: VendorPricingRule,
    sku: Sku,
    poDate: Date,
    city: string,
  ): Promise<CalculatedPrice> {
    // Get NECC price for the day before PO date
    const previousDay = new Date(poDate);
    previousDay.setDate(previousDay.getDate() - 1);

    const neccCity = rule.neccCity || city;
    // Use the closest available rate on or before the required date (handles weekends/holidays/missing data)
    const neccPrice = await this.neccPriceRepo.findOne({
      where: { city: neccCity, date: LessThanOrEqual(previousDay) },
      order: { date: 'DESC' },
    });

    if (!neccPrice) {
      throw new NotFoundException(
        `No NECC price found for city ${neccCity} on or before ${previousDay.toISOString().split('T')[0]}`,
      );
    }

    const margin = rule.isPercentage
      ? Number(neccPrice.price) * (Number(rule.margin) / 100)
      : Number(rule.margin);

    const pricePerEgg = Number(neccPrice.price) + margin;
    const totalPrice = pricePerEgg * sku.packSize;

    return {
      price: Math.round(totalPrice * 100) / 100,
      ruleType: PricingRuleType.PREMIUM_FRESH,
      neccPrice: Number(neccPrice.price),
      margin: Number(rule.margin),
      breakdown: `(NECC ₹${neccPrice.price} + margin ₹${margin.toFixed(2)}) × ${sku.packSize} = ₹${totalPrice.toFixed(2)}`,
    };
  }

  /**
   * dr. Good Eggs: MRP - vendor margin
   */
  private async calculateDrGoodEggs(
    rule: VendorPricingRule,
    sku: Sku,
  ): Promise<CalculatedPrice> {
    if (!sku.mrp) {
      throw new Error(`MRP not set for SKU ${sku.code}`);
    }

    const mrp = Number(sku.mrp);
    const discount = rule.isPercentage
      ? mrp * (Number(rule.margin) / 100)
      : Number(rule.margin);

    const price = mrp - discount;

    return {
      price: Math.round(price * 100) / 100,
      ruleType: PricingRuleType.DR_GOOD_EGGS,
      margin: Number(rule.margin),
      breakdown: `MRP ₹${mrp} - margin ₹${discount.toFixed(2)} = ₹${price.toFixed(2)}`,
    };
  }

  async findAllRules(vendorId?: string): Promise<VendorPricingRule[]> {
    const where = vendorId ? { vendorId } : {};
    return this.ruleRepo.find({
      where,
      relations: ['vendor'],
      order: { effectiveFrom: 'DESC' },
    });
  }

  async createRule(data: Partial<VendorPricingRule>): Promise<VendorPricingRule> {
    const rule = this.ruleRepo.create(data);
    return this.ruleRepo.save(rule);
  }

  async updateRule(id: string, data: Partial<VendorPricingRule>): Promise<VendorPricingRule> {
    const { vendor, ...updateData } = data as any;
    await this.ruleRepo.update(id, updateData);
    const updated = await this.ruleRepo.findOne({ where: { id }, relations: ['vendor'] });
    if (!updated) throw new NotFoundException(`Pricing rule ${id} not found`);
    return updated;
  }

  async deleteRule(id: string): Promise<void> {
    const rule = await this.ruleRepo.findOne({ where: { id } });
    if (!rule) throw new NotFoundException(`Pricing rule ${id} not found`);
    await this.ruleRepo.remove(rule);
  }
}
