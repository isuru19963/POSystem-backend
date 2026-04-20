import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

/** Consolidation of orders by SKU + City + Route */
@Entity('consolidations')
@Index(['consolidationDate', 'city'])
export class Consolidation extends BaseEntity {
  @Column({ name: 'consolidation_date', type: 'date' })
  consolidationDate!: Date;

  @Column()
  city!: string;

  @Column({ name: 'route_name', nullable: true })
  routeName?: string;

  /** Aggregated line items: SKU → total packs, total eggs, crates needed */
  @Column({ type: 'jsonb' })
  items!: Array<{
    skuId: string;
    skuCode: string;
    skuName: string;
    totalPacks: number;
    totalEggs: number;
    requiredCrates: number;
  }>;

  @Column({ name: 'total_packs', type: 'int' })
  totalPacks!: number;

  @Column({ name: 'total_eggs', type: 'int' })
  totalEggs!: number;

  @Column({ name: 'total_crates', type: 'int' })
  totalCrates!: number;

  /** PO IDs included in this consolidation */
  @Column({ name: 'po_ids', type: 'jsonb' })
  poIds!: string[];
}
