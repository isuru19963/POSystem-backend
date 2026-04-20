import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Delivery } from './delivery.entity';
import { Sku } from './sku.entity';

@Entity('delivery_line_items')
export class DeliveryLineItem extends BaseEntity {
  @Column({ name: 'delivery_id' })
  deliveryId!: string;

  @ManyToOne(() => Delivery, (d) => d.lineItems)
  @JoinColumn({ name: 'delivery_id' })
  delivery!: Delivery;

  @Column({ name: 'sku_id' })
  skuId!: string;

  @ManyToOne(() => Sku)
  @JoinColumn({ name: 'sku_id' })
  sku!: Sku;

  /** Quantity ordered (from PO) */
  @Column({ name: 'ordered_quantity', type: 'int' })
  orderedQuantity!: number;

  /** Quantity actually delivered */
  @Column({ name: 'delivered_quantity', type: 'int' })
  deliveredQuantity!: number;

  /** Shortage if any */
  @Column({ type: 'int', default: 0 })
  shortage!: number;
}
