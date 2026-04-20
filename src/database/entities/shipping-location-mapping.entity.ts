import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

/** Maps shipping locations from POs to NECC city names */
@Entity('shipping_location_mappings')
@Index(['shippingLocation'], { unique: true })
export class ShippingLocationMapping extends BaseEntity {
  @Column({ name: 'shipping_location' })
  shippingLocation!: string;

  @Column({ name: 'necc_city' })
  neccCity!: string;

  @Column({ nullable: true })
  state?: string;

  @Column({ default: true })
  isActive!: boolean;
}
