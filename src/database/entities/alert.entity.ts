import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

export enum AlertType {
  PRICE_MISMATCH = 'price_mismatch',
  SHORT_DELIVERY = 'short_delivery',
  DELAY = 'delay',
  GRN_DELAY = 'grn_delay',
  PO_NOT_RECEIVED = 'po_not_received',
  GRN_MISMATCH = 'grn_mismatch',
}

export enum AlertChannel {
  WHATSAPP = 'whatsapp',
  EMAIL = 'email',
  BOTH = 'both',
}

export enum AlertStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  ACKNOWLEDGED = 'acknowledged',
}

@Entity('alerts')
@Index(['type', 'status'])
export class Alert extends BaseEntity {
  @Column({ type: 'enum', enum: AlertType })
  type!: AlertType;

  @Column({ type: 'enum', enum: AlertChannel, default: AlertChannel.WHATSAPP })
  channel!: AlertChannel;

  @Column({ type: 'enum', enum: AlertStatus, default: AlertStatus.PENDING })
  status!: AlertStatus;

  @Column()
  subject!: string;

  @Column({ type: 'text' })
  message!: string;

  /** Reference to the entity that triggered this alert (PO ID, Delivery ID, etc.) */
  @Column({ name: 'reference_id', nullable: true })
  referenceId?: string;

  @Column({ name: 'reference_type', nullable: true })
  referenceType?: string;

  @Column({ name: 'sent_at', type: 'timestamp', nullable: true })
  sentAt?: Date;

  @Column({ name: 'error_details', nullable: true })
  errorDetails?: string;
}
