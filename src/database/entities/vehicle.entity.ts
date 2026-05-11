import { Entity, Column } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity('vehicles')
export class Vehicle extends BaseEntity {
  @Column({ name: 'vehicle_number', unique: true })
  vehicleNumber!: string;

  @Column({ nullable: true })
  type?: string; // e.g. "Truck", "Van", "Tempo"

  @Column({ nullable: true })
  capacity?: string; // e.g. "1 ton", "500 crates"

  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ nullable: true })
  notes?: string;
}
