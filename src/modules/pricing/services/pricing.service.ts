import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, IsNull, Or } from 'typeorm';
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
  ): Promise<CalculatedPrice> {
    // Find the active pricing rule for this vendor + brand
    const rule = await this.ruleRepo.findOne({
      where: {
        vendorId,
        brand: sku.brand,
        isActive: true,
        effectiveFrom: LessThanOrEqual(poDate),
        effectiveTo: Or(MoreThanOrEqual(poDate), IsNull()),
      },
      order: { effectiveFrom: 'DESC' },
    });

    if (!rule) {
      throw new NotFoundException(
        `No active pricing rule found for vendor ${vendorId}, brand ${sku.brand}`,
      );
    }

    switch (rule.type) {
      case PricingRuleType.PREMIUM_FRESH:
        return this.calculatePremiumFresh(rule, sku, poDate, city);
      case PricingRuleType.DR_GOOD_EGGS:
        return this.calculateDrGoodEggs(rule, sku);
      default:
        throw new Error(`Unsupported pricing rule type: ${rule.type}`);
    }
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
    const neccPrice = await this.neccPriceRepo.findOne({
      where: { city: neccCity, date: previousDay },
    });

    if (!neccPrice) {
      throw new NotFoundException(
        `NECC price not found for city ${neccCity} on ${previousDay.toISOString().split('T')[0]}`,
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
}
