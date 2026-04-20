import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Vendor } from './vendor.entity';

export enum PricingRuleType {
  /** (NECC price [PO date - 1] + margin) × pack size */
  PREMIUM_FRESH = 'premium_fresh',
  /** MRP - vendor margin */
  DR_GOOD_EGGS = 'dr_good_eggs',
  /** Custom formula stored as JSON */
  CUSTOM = 'custom',
}

@Entity('vendor_pricing_rules')
export class VendorPricingRule extends BaseEntity {
  @Column({ name: 'vendor_id' })
  vendorId!: string;

  @ManyToOne(() => Vendor, (v) => v.pricingRules)
  @JoinColumn({ name: 'vendor_id' })
  vendor!: Vendor;

  /** Which SKU brand / category this rule applies to */
  @Column()
  brand!: string;

  @Column({ type: 'enum', enum: PricingRuleType })
  type!: PricingRuleType;

  /** Margin percentage or fixed amount depending on type */
  @Column({ type: 'decimal', precision: 10, scale: 4 })
  margin!: number;

  /** Whether margin is percentage (true) or fixed (false) */
  @Column({ name: 'is_percentage', default: true })
  isPercentage!: boolean;

  /** Optional: NECC city for Premium Fresh rules */
  @Column({ name: 'necc_city', nullable: true })
  neccCity?: string;

  /** Effective from date */
  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom!: Date;

  /** Effective to date (null = currently active) */
  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo?: Date;

  @Column({ default: true })
  isActive!: boolean;
}
