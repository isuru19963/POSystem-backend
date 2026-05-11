import { Column, Entity } from 'typeorm';
import { BaseEntity } from './base.entity';

/** Stores WhatsApp numbers that should be notified when a new PO is created. */
@Entity('notification_contacts')
export class NotificationContact extends BaseEntity {
  @Column({ length: 100 })
  label: string;

  /** E.164 format, e.g. +919876543210 */
  @Column({ length: 20, unique: true })
  phone: string;

  @Column({ default: true })
  isActive: boolean;
}
