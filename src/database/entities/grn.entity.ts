import { Entity, Column, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { PurchaseOrder } from './purchase-order.entity';
import { GrnLineItem } from './grn-line-item.entity';

export enum GrnStatus {
  RECEIVED = 'received',
  PROCESSING = 'processing',
  MATCHED = 'matched',
  MISMATCH = 'mismatch',
}

@Entity('grns')
export class Grn extends BaseEntity {
  @Column({ name: 'grn_number', unique: true })
  grnNumber!: string;

  @Column({ name: 'purchase_order_id' })
  purchaseOrderId!: string;

  @ManyToOne(() => PurchaseOrder, (po) => po.grns)
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder!: PurchaseOrder;

  @Column({ name: 'grn_date', type: 'date' })
  grnDate!: Date;

  @Column({ type: 'enum', enum: GrnStatus, default: GrnStatus.RECEIVED })
  status!: GrnStatus;

  /** S3 key for the raw GRN file */
  @Column({ name: 'raw_file_key', nullable: true })
  rawFileKey?: string;

  @Column({ name: 'email_message_id', nullable: true, unique: true })
  emailMessageId?: string;

  /** 3-way match result: PO vs Delivered vs GRN */
  @Column({ name: 'match_result', type: 'jsonb', nullable: true })
  matchResult?: Record<string, unknown>;

  @OneToMany(() => GrnLineItem, (li) => li.grn, { cascade: true })
  lineItems!: GrnLineItem[];
}
