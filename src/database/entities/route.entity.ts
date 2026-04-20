import { Entity, Column } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity('routes')
export class Route extends BaseEntity {
  @Column({ unique: true })
  name!: string;

  @Column({ nullable: true })
  description?: string;

  /** Ordered list of cities/stops on this route */
  @Column({ type: 'jsonb', default: [] })
  stops!: string[];

  @Column({ name: 'vehicle_type', nullable: true })
  vehicleType?: string;

  @Column({ default: true })
  isActive!: boolean;
}
