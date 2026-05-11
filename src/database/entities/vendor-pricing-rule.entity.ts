import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Vendor } from './vendor.entity';

export enum PricingRuleType {
  /** (NECC price [PO date - 1] + margin) × pack size */
  PREMIUM_FRESH = 'premium_fresh',
  /** MRP × (1 - margin) */
  DR_GOOD_EGGS = 'dr_good_eggs',
  /** Same formula as dr_good_eggs: MRP × (1 - margin) */
  PURE_O_FRESH = 'pure_o_fresh',
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

  /**
   * Optional: when set, this Premium Fresh rule only applies to POs with this exact ship-to
   * (matches purchase_orders.shipping_location). Null = all locations for the vendor/brand.
   */
  @Column({ name: 'shipping_location', nullable: true })
  shippingLocation?: string;

  /**
   * Optional: pack size for Premium Fresh per-pack-size margin rules.
   * When set, this rule only applies to SKUs with this pack size.
   * When null, applies to all pack sizes of the brand.
   */
  @Column({ name: 'pack_size', type: 'int', nullable: true })
  packSize?: number;

  /** Effective from date */
  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom!: Date;

  /** Effective to date (null = currently active) */
  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo?: Date;

  @Column({ default: true })
  isActive!: boolean;
}
