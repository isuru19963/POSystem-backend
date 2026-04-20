import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { PurchaseOrder } from './purchase-order.entity';
import { Sku } from './sku.entity';

export enum LineItemValidationStatus {
  PENDING = 'pending',
  VALID = 'valid',
  MISMATCH = 'mismatch',
}

@Entity('purchase_order_line_items')
export class PurchaseOrderLineItem extends BaseEntity {
  @Column({ name: 'purchase_order_id' })
  purchaseOrderId!: string;

  @ManyToOne(() => PurchaseOrder, (po) => po.lineItems)
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder!: PurchaseOrder;

  @Column({ name: 'sku_id', nullable: true })
  skuId?: string;

  @ManyToOne(() => Sku, (sku) => sku.lineItems, { nullable: true })
  @JoinColumn({ name: 'sku_id' })
  sku?: Sku;

  /** Item code from the PO (used to resolve SKU) */
  @Column({ name: 'item_code' })
  itemCode!: string;

  /** Item description from the PO */
  @Column({ name: 'item_name', nullable: true })
  itemName?: string;

  /** HSN code from the PO */
  @Column({ name: 'hsn_code', nullable: true })
  hsnCode?: string;

  @Column({ type: 'int' })
  quantity!: number;

  /** Price per unit as stated in the PO */
  @Column({ name: 'po_price', type: 'decimal', precision: 10, scale: 2 })
  poPrice!: number;

  /** MRP as stated in the PO */
  @Column({ name: 'po_mrp', type: 'decimal', precision: 10, scale: 2, nullable: true })
  poMrp?: number;

  /** System-calculated price */
  @Column({ name: 'calculated_price', type: 'decimal', precision: 10, scale: 2, nullable: true })
  calculatedPrice?: number;

  @Column({
    name: 'validation_status',
    type: 'enum',
    enum: LineItemValidationStatus,
    default: LineItemValidationStatus.PENDING,
  })
  validationStatus!: LineItemValidationStatus;

  /** Difference between PO price and calculated price */
  @Column({ name: 'price_variance', type: 'decimal', precision: 10, scale: 2, nullable: true })
  priceVariance?: number;
}
