import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Vendor } from './vendor.entity';
import { PurchaseOrderLineItem } from './purchase-order-line-item.entity';
import { Delivery } from './delivery.entity';
import { Grn } from './grn.entity';

export enum PoStatus {
  RECEIVED = 'received',
  PROCESSING = 'processing',
  EXTRACTED = 'extracted',
  VALIDATED = 'validated',
  PRICE_MISMATCH = 'price_mismatch',
  CONSOLIDATED = 'consolidated',
  DISPATCHED = 'dispatched',
  DELIVERED = 'delivered',
  COMPLETED = 'completed',
  REJECTED = 'rejected',
}

@Entity('purchase_orders')
@Index(['poNumber', 'vendorId'], { unique: true })
export class PurchaseOrder extends BaseEntity {
  @Column({ name: 'po_number' })
  poNumber!: string;

  @Column({ name: 'po_date', type: 'date' })
  poDate!: Date;

  @Column({ name: 'vendor_id' })
  vendorId!: string;

  @ManyToOne(() => Vendor, (vendor) => vendor.purchaseOrders)
  @JoinColumn({ name: 'vendor_id' })
  vendor!: Vendor;

  @Column({ name: 'shipping_location' })
  shippingLocation!: string;

  @Column({ type: 'enum', enum: PoStatus, default: PoStatus.RECEIVED })
  status!: PoStatus;

  /** S3 key for the raw PDF file */
  @Column({ name: 'raw_file_key', nullable: true })
  rawFileKey?: string;

  /** S3 key for the raw XLS file */
  @Column({ name: 'raw_xls_file_key', nullable: true })
  rawXlsFileKey?: string;

  /** Email message ID for deduplication */
  @Column({ name: 'email_message_id', nullable: true, unique: true })
  emailMessageId?: string;

  @Column({ name: 'expected_delivery_date', type: 'date', nullable: true })
  expectedDeliveryDate?: Date;

  @Column({ name: 'expiry_date', type: 'date', nullable: true })
  expiryDate?: Date;

  @Column({ name: 'payment_terms', nullable: true })
  paymentTerms?: string;

  /** Raw extracted data from PDF/XLS */
  @Column({ name: 'extracted_data', type: 'jsonb', nullable: true })
  extractedData?: Record<string, unknown>;

  @Column({ name: 'total_amount', type: 'decimal', precision: 12, scale: 2, nullable: true })
  totalAmount?: number;

  @OneToMany(() => PurchaseOrderLineItem, (li) => li.purchaseOrder, { cascade: true })
  lineItems!: PurchaseOrderLineItem[];

  @OneToMany(() => Delivery, (d) => d.purchaseOrder)
  deliveries!: Delivery[];

  @OneToMany(() => Grn, (g) => g.purchaseOrder)
  grns!: Grn[];
}
