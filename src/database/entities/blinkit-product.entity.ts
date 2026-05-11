import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity('blinkit_products')
export class BlinkitProduct extends BaseEntity {
  /** Human-readable product name */
  @Column()
  name!: string;

  /** Blinkit internal product id, if available */
  @Column({ name: 'blinkit_id', nullable: true })
  blinkitId?: string;

  /** Pack size / variant label e.g. "10 pcs", "6 pcs" */
  @Column({ nullable: true })
  size?: string;

  /** Sale price in INR (paise stored as decimal) */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  price?: number;

  /** MRP in INR */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  mrp?: number;

  /** Discount percentage */
  @Column({ name: 'discount_percent', type: 'decimal', precision: 5, scale: 2, nullable: true })
  discountPercent?: number;

  /** Promotional badge text shown on product cards, if present */
  @Column({ name: 'promo_badge', nullable: true })
  promoBadge?: string;

  /** true = in stock */
  @Column({ name: 'in_stock', default: true })
  inStock!: boolean;

  /** Product image URL */
  @Column({ name: 'image_url', nullable: true })
  imageUrl?: string;

  /** Blinkit category / brand string */
  @Column({ nullable: true })
  brand?: string;

  /** City where the scrape was performed */
  @Column({ nullable: true })
  city?: string;

  /** Search query used when scraping */
  @Column({ name: 'search_query', default: 'eggs' })
  searchQuery!: string;

  /** Timestamp of the scrape session that produced this row */
  @Index()
  @Column({ name: 'scraped_at', type: 'timestamptz' })
  scrapedAt!: Date;

  /** Scrape session identifier (groups rows from same run) */
  @Column({ name: 'session_id' })
  sessionId!: string;
}
