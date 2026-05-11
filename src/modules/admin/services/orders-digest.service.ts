import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PurchaseOrder, NotificationContact } from '../../../database/entities';
import { WhatsappService } from '../../../whatsapp/whatsapp.service';

/** Calendar date YYYY-MM-DD in Asia/Kolkata */
export function istDateString(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Sends a daily WhatsApp digest of POs whose PO date OR expected delivery date
 * falls on "today" (IST) to every active notification_contacts row.
 */
@Injectable()
export class OrdersDigestService {
  private readonly logger = new Logger(OrdersDigestService.name);
  /** WhatsApp body limit — cap how many PO blocks we list */
  private static readonly MAX_POS_LISTED = 30;

  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepo: Repository<PurchaseOrder>,
    @InjectRepository(NotificationContact)
    private readonly notifRepo: Repository<NotificationContact>,
    private readonly whatsappService: WhatsappService,
  ) {}

  /**
   * Query POs relevant for "today" in IST: po_date = today OR expected_delivery_date = today.
   */
  async findTodaysOrders(): Promise<PurchaseOrder[]> {
    const todayStr = istDateString();
    return this.poRepo
      .createQueryBuilder('po')
      .leftJoinAndSelect('po.vendor', 'vendor')
      .where(
        `(
          to_char(po.poDate, 'YYYY-MM-DD') = :today
          OR to_char(po.expectedDeliveryDate, 'YYYY-MM-DD') = :today
        )`,
        { today: todayStr },
      )
      .orderBy('po.poNumber', 'ASC')
      .getMany();
  }

  formatDigestMessage(pos: PurchaseOrder[], headerDateHuman: string): string {
    const lines: string[] = [];
    lines.push(`📋 *Today's Orders*`);
    lines.push(headerDateHuman);
    lines.push('');

    if (!pos.length) {
      lines.push('_No purchase orders with PO date or expected delivery date matching today._');
      lines.push('');
      lines.push('_IST • Good Eggs POS_');
      return lines.join('\n');
    }

    const slice = pos.slice(0, OrdersDigestService.MAX_POS_LISTED);
    slice.forEach((po, idx) => {
      const vendorName = (po.vendor?.name ?? '').trim() || '—';
      const total =
        po.totalAmount != null
          ? `₹${Number(po.totalAmount).toLocaleString('en-IN')}`
          : '—';
      const ship = po.shippingLocation ? po.shippingLocation : '—';
      const poD = po.poDate
        ? new Date(po.poDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
        : '—';
      const due = po.expectedDeliveryDate
        ? new Date(po.expectedDeliveryDate).toLocaleDateString('en-IN', {
            timeZone: 'Asia/Kolkata',
          })
        : '—';
      lines.push(
        `${idx + 1}. *${po.poNumber}* — ${vendorName}`,
        `   PO date: ${poD} • Due: ${due} • Ship: ${ship} • Total: ${total}`,
      );
    });
    if (pos.length > slice.length) {
      lines.push('');
      lines.push(
        `_…and ${pos.length - slice.length} more order(s) not shown (limit ${OrdersDigestService.MAX_POS_LISTED})._`,
      );
    }

    lines.push('');
    lines.push(`_Total: ${pos.length} order(s) • IST • Good Eggs POS_`);
    return lines.join('\n');
  }

  /**
   * Sends digest to all active WhatsApp numbers in notification_contacts.
   * When there are zero matching POs, still sends a short message so recipients know the digest ran.
   */
  async sendTodaysOrdersDigest(): Promise<{
    sentTo: number;
    orderCount: number;
    messageChars: number;
  }> {
    const todayStr = istDateString();
    const headerHuman = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date());

    const contacts = await this.notifRepo.find({
      where: { isActive: true },
      order: { label: 'ASC' },
    });

    if (!contacts.length) {
      this.logger.warn(
        'Skipping Today\'s Orders digest — no active WhatsApp notification contacts',
      );
      return { sentTo: 0, orderCount: 0, messageChars: 0 };
    }

    const pos = await this.findTodaysOrders();
    const body = this.formatDigestMessage(pos, headerHuman);
    this.logger.log(
      `Today's Orders digest (${todayStr} IST): ${pos.length} PO(s) → ${contacts.length} contact(s)`,
    );

    await Promise.all(
      contacts.map((c) =>
        this.whatsappService.sendMessage(c.phone, body).catch((err) => {
          this.logger.warn(
            `WhatsApp digest failed for ${c.phone}: ${err instanceof Error ? err.message : err}`,
          );
        }),
      ),
    );

    return {
      sentTo: contacts.length,
      orderCount: pos.length,
      messageChars: body.length,
    };
  }
}
