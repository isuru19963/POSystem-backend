import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

/** TAT (Turn-Around-Time) configuration for expected PO schedules */
@Entity('tat_configs')
@Index(['vendorId', 'dayOfWeek'], { unique: true })
export class TatConfig extends BaseEntity {
  @Column({ name: 'vendor_id' })
  vendorId!: string;

  /** 0 = Sunday, 6 = Saturday */
  @Column({ name: 'day_of_week', type: 'int' })
  dayOfWeek!: number;

  /** Expected time by which PO should arrive (HH:mm) */
  @Column({ name: 'expected_by', type: 'time' })
  expectedBy!: string;

  @Column({ default: true })
  isActive!: boolean;
}
