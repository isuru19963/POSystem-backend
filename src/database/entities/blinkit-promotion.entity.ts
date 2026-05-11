import { Column, Entity } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity('blinkit_promotions')
export class BlinkitPromotion extends BaseEntity {
  @Column({ name: 'title' })
  title!: string;

  @Column({ name: 'description', nullable: true })
  description?: string;

  @Column({ name: 'target_url', nullable: true })
  targetUrl?: string;

  @Column({ name: 'image_url', nullable: true })
  imageUrl?: string;

  @Column({ name: 'search_query', default: 'eggs' })
  searchQuery!: string;

  @Column({ name: 'scraped_at', type: 'timestamptz' })
  scrapedAt!: Date;

  @Column({ name: 'session_id' })
  sessionId!: string;
}
