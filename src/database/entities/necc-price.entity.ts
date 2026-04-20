import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity('necc_prices')
@Index(['city', 'date'], { unique: true })
export class NeccPrice extends BaseEntity {
  @Column()
  city!: string;

  @Column({ type: 'date' })
  date!: Date;

  /** Price per egg as fetched from NECC */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price!: number;

  /** Raw data from NECC source */
  @Column({ name: 'raw_data', type: 'jsonb', nullable: true })
  rawData?: Record<string, unknown>;
}
