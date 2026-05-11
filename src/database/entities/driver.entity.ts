import { Entity, Column } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity('drivers')
export class Driver extends BaseEntity {
  @Column()
  name!: string;

  @Column({ unique: true })
  phone!: string;

  @Column({ nullable: true })
  license?: string;

  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ nullable: true })
  notes?: string;
}
