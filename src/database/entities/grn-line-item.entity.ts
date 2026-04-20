import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Grn } from './grn.entity';
import { Sku } from './sku.entity';

@Entity('grn_line_items')
export class GrnLineItem extends BaseEntity {
  @Column({ name: 'grn_id' })
  grnId!: string;

  @ManyToOne(() => Grn, (g) => g.lineItems)
  @JoinColumn({ name: 'grn_id' })
  grn!: Grn;

  @Column({ name: 'sku_id' })
  skuId!: string;

  @ManyToOne(() => Sku)
  @JoinColumn({ name: 'sku_id' })
  sku!: Sku;

  /** Quantity received as per GRN */
  @Column({ name: 'received_quantity', type: 'int' })
  receivedQuantity!: number;

  /** Quantity accepted after inspection */
  @Column({ name: 'accepted_quantity', type: 'int' })
  acceptedQuantity!: number;

  /** Quantity rejected */
  @Column({ name: 'rejected_quantity', type: 'int', default: 0 })
  rejectedQuantity!: number;

  @Column({ name: 'rejection_reason', nullable: true })
  rejectionReason?: string;
}
