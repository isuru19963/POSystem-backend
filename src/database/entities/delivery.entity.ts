import { Entity, Column, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { PurchaseOrder } from './purchase-order.entity';
import { Route } from './route.entity';
import { DeliveryLineItem } from './delivery-line-item.entity';

export enum DispatchStatus {
  PLANNED = 'planned',
  IN_TRANSIT = 'in_transit',
  DELIVERED = 'delivered',
  PARTIAL = 'partial',
}

@Entity('deliveries')
export class Delivery extends BaseEntity {
  @Column({ name: 'purchase_order_id' })
  purchaseOrderId!: string;

  @ManyToOne(() => PurchaseOrder, (po) => po.deliveries)
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder!: PurchaseOrder;

  @Column({ name: 'route_id', nullable: true })
  routeId?: string;

  @ManyToOne(() => Route, { nullable: true })
  @JoinColumn({ name: 'route_id' })
  route?: Route;

  @Column({ name: 'vehicle_number', nullable: true })
  vehicleNumber?: string;

  @Column({ name: 'driver_name', nullable: true })
  driverName?: string;

  @Column({ name: 'driver_phone', nullable: true })
  driverPhone?: string;

  @Column({ name: 'dispatch_date', type: 'date' })
  dispatchDate!: Date;

  @Column({ name: 'actual_delivery_date', type: 'timestamp', nullable: true })
  actualDeliveryDate?: Date;

  @Column({ type: 'enum', enum: DispatchStatus, default: DispatchStatus.PLANNED })
  status!: DispatchStatus;

  /** Packing summary generated for this dispatch */
  @Column({ name: 'packing_summary', type: 'jsonb', nullable: true })
  packingSummary?: Record<string, unknown>;

  @OneToMany(() => DeliveryLineItem, (li) => li.delivery, { cascade: true })
  lineItems!: DeliveryLineItem[];
}
