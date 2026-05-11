import { Entity, Column } from 'typeorm';
import { BaseEntity } from './base.entity';

export enum ScrapeStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
}

@Entity('blinkit_scrape_sessions')
export class BlinkitScrapeSession extends BaseEntity {
  @Column({ name: 'search_query', default: 'eggs' })
  searchQuery!: string;

  @Column({ nullable: true })
  city?: string;

  @Column({ type: 'enum', enum: ScrapeStatus, default: ScrapeStatus.PENDING })
  status!: ScrapeStatus;

  @Column({ name: 'products_found', default: 0 })
  productsFound!: number;

  @Column({ name: 'scraped_at', type: 'timestamptz', nullable: true })
  scrapedAt?: Date;

  @Column({ nullable: true, type: 'text' })
  error?: string;
}
