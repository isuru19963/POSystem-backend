import { Entity, Column, OneToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { PurchaseOrder } from './purchase-order.entity';
import { VendorPricingRule } from './vendor-pricing-rule.entity';

@Entity('vendors')
export class Vendor extends BaseEntity {
  @Column({ unique: true })
  name!: string;

  @Column({ unique: true })
  code!: string;

  @Column({ nullable: true })
  email?: string;

  @Column({ nullable: true })
  phone?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Column({ default: true })
  isActive!: boolean;

  @OneToMany(() => PurchaseOrder, (po) => po.vendor)
  purchaseOrders!: PurchaseOrder[];

  @OneToMany(() => VendorPricingRule, (rule) => rule.vendor)
  pricingRules!: VendorPricingRule[];
}
