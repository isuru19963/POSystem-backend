import { Entity, Column, OneToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { PurchaseOrderLineItem } from './purchase-order-line-item.entity';

@Entity('skus')
export class Sku extends BaseEntity {
  @Column({ unique: true })
  code!: string;

  @Column()
  name!: string;

  @Column({ nullable: true })
  description?: string;

  /** Brand: "Premium Fresh" or "dr. Good Eggs" etc. */
  @Column()
  brand!: string;

  /** Number of eggs per pack */
  @Column({ type: 'int' })
  packSize!: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  mrp?: number;

  @Column({ default: true })
  isActive!: boolean;

  @OneToMany(() => PurchaseOrderLineItem, (li) => li.sku)
  lineItems!: PurchaseOrderLineItem[];
}
