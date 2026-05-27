import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotificationContact,
  PoStatus,
  PurchaseOrder,
  PurchaseOrderLineItem,
} from '../../../database/entities';
import { EGGS_PER_CRATE } from '../../../common/constants/app.constants';
import { istDateHuman, istDateString } from '../../../common/utils/ist-date.util';
import { WhatsappService } from '../../../whatsapp/whatsapp.service';
import { formatWhatsAppSendError } from '../../../whatsapp/whatsapp.errors';

export type DailyConsolidationSlot = 'morning' | 'evening';

export interface DailySkuConsolidationRow {
  skuCode: string;
  skuName: string;
  packSize: number;
  totalPacks: number;
  totalEggs: number;
  requiredCrates: number;
}

export interface DailySkuConsolidationCityBlock {
  city: string;
  poCount: number;
  rows: DailySkuConsolidationRow[];
  totalPacks: number;
  totalEggs: number;
  totalCrates: number;
}

export interface DailyDeliveryConsolidationReport {
  deliveryDate: string;
  slot: DailyConsolidationSlot;
  slotLabel: string;
  generatedAt: string;
  poCount: number;
  posWithUnmappedLines: number;
  rows: DailySkuConsolidationRow[];
  totalPacks: number;
  totalEggs: number;
  totalCrates: number;
  byCity: DailySkuConsolidationCityBlock[];
}

const SLOT_LABELS: Record<DailyConsolidationSlot, string> = {
  morning: '6:00 AM',
  evening: '7:00 PM',
};

const EXCLUDED_STATUSES = [PoStatus.REJECTED];

@Injectable()
export class DailyDeliveryConsolidationService {
  private readonly logger = new Logger(DailyDeliveryConsolidationService.name);
  private static readonly MAX_SKU_LINES_WHATSAPP = 35;

  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepo: Repository<PurchaseOrder>,
    @InjectRepository(PurchaseOrderLineItem)
    private readonly lineItemRepo: Repository<PurchaseOrderLineItem>,
    @InjectRepository(NotificationContact)
    private readonly notifRepo: Repository<NotificationContact>,
    private readonly whatsappService: WhatsappService,
  ) {}

  /**
   * SKU-wise totals for POs whose expected delivery date is `deliveryDate`
   * (IST calendar day, default today).
   */
  async buildReport(
    deliveryDate?: string,
    slot: DailyConsolidationSlot = 'morning',
  ): Promise<DailyDeliveryConsolidationReport> {
    const dateStr = deliveryDate ?? istDateString();

    const deliveryDateWhere = `(
      to_char(po.expectedDeliveryDate, 'YYYY-MM-DD') = :dateStr
      OR to_char(po.poDate, 'YYYY-MM-DD') = :dateStr
    )`;

    const rawRows = await this.lineItemRepo
      .createQueryBuilder('li')
      .select('po.shippingLocation', 'city')
      .addSelect('s.code', 'skuCode')
      .addSelect('s.name', 'skuName')
      .addSelect('s.packSize', 'packSize')
      .addSelect('SUM(li.quantity)', 'totalPacks')
      .innerJoin('li.purchaseOrder', 'po')
      .innerJoin('li.sku', 's')
      .where(deliveryDateWhere, { dateStr })
      .andWhere('po.status NOT IN (:...excluded)', {
        excluded: EXCLUDED_STATUSES,
      })
      .groupBy('po.shippingLocation')
      .addGroupBy('s.code')
      .addGroupBy('s.name')
      .addGroupBy('s.packSize')
      .orderBy('po.shippingLocation', 'ASC')
      .addOrderBy('s.code', 'ASC')
      .getRawMany();

    const poCount = await this.poRepo
      .createQueryBuilder('po')
      .where(deliveryDateWhere, { dateStr })
      .andWhere('po.status NOT IN (:...excluded)', {
        excluded: EXCLUDED_STATUSES,
      })
      .getCount();

    const posWithUnmappedLines = await this.poRepo
      .createQueryBuilder('po')
      .innerJoin('po.lineItems', 'li')
      .where(deliveryDateWhere, { dateStr })
      .andWhere('po.status NOT IN (:...excluded)', {
        excluded: EXCLUDED_STATUSES,
      })
      .andWhere('li.skuId IS NULL')
      .getCount();

    const cityMap = new Map<string, DailySkuConsolidationCityBlock>();
    const grandMap = new Map<string, DailySkuConsolidationRow>();

    for (const r of rawRows) {
      const city = String(r.city || 'Unknown').trim() || 'Unknown';
      const packSize = this.num(r.packSize, 1);
      const totalPacks = this.num(r.totalPacks);
      const row = this.toRow(
        String(r.skuCode),
        String(r.skuName || r.skuCode),
        packSize,
        totalPacks,
      );

      if (!cityMap.has(city)) {
        cityMap.set(city, {
          city,
          poCount: 0,
          rows: [],
          totalPacks: 0,
          totalEggs: 0,
          totalCrates: 0,
        });
      }
      const block = cityMap.get(city)!;
      block.rows.push(row);
      block.totalPacks += row.totalPacks;
      block.totalEggs += row.totalEggs;
      block.totalCrates += row.requiredCrates;

      const gKey = row.skuCode;
      if (grandMap.has(gKey)) {
        const g = grandMap.get(gKey)!;
        g.totalPacks += row.totalPacks;
        g.totalEggs += row.totalEggs;
        g.requiredCrates = Math.ceil(g.totalEggs / EGGS_PER_CRATE);
      } else {
        grandMap.set(gKey, { ...row });
      }
    }

    const byCity = [...cityMap.values()].map((b) => ({
      ...b,
      poCount: 0,
    }));

    if (byCity.length) {
      const cityExpr = `COALESCE(NULLIF(TRIM(po.shippingLocation), ''), 'Unknown')`;
      const poPerCity = await this.poRepo
        .createQueryBuilder('po')
        .select(cityExpr, 'city')
        .addSelect('COUNT(po.id)', 'poCount')
        .where(deliveryDateWhere, { dateStr })
        .andWhere('po.status NOT IN (:...excluded)', {
          excluded: EXCLUDED_STATUSES,
        })
        .groupBy(cityExpr)
        .getRawMany();

      for (const b of byCity) {
        const match = poPerCity.find((p) => String(p.city) === b.city);
        b.poCount = match ? this.num(match.poCount) : 0;
      }
    }

    const rows = [...grandMap.values()].sort((a, b) =>
      a.skuCode.localeCompare(b.skuCode),
    );
    const totalPacks = rows.reduce((s, r) => s + r.totalPacks, 0);
    const totalEggs = rows.reduce((s, r) => s + r.totalEggs, 0);
    const totalCrates = rows.reduce((s, r) => s + r.requiredCrates, 0);

    return {
      deliveryDate: dateStr,
      slot,
      slotLabel: SLOT_LABELS[slot],
      generatedAt: new Date().toISOString(),
      poCount,
      posWithUnmappedLines,
      rows,
      totalPacks,
      totalEggs,
      totalCrates,
      byCity,
    };
  }

  formatWhatsAppMessage(report: DailyDeliveryConsolidationReport): string {
    const lines: string[] = [];
    lines.push(`📦 *Today's Delivery — SKU Consolidation*`);
    lines.push(
      `${istDateHuman(new Date(report.deliveryDate + 'T12:00:00Z'))} • ${report.slotLabel} cut-off`,
    );
    lines.push('');

    if (!report.rows.length) {
      lines.push(
        '_No mapped SKU quantities for POs with expected delivery today._',
      );
      if (report.poCount > 0) {
        lines.push(
          `_${report.poCount} PO(s) scheduled — map SKUs on unmapped lines to include them._`,
        );
      }
      lines.push('');
      lines.push('_IST • Good Eggs POS_');
      return lines.join('\n');
    }

    const slice = report.rows.slice(
      0,
      DailyDeliveryConsolidationService.MAX_SKU_LINES_WHATSAPP,
    );
    lines.push('*SKU totals (all cities)*');
    for (const r of slice) {
      lines.push(
        `• *${r.skuCode}* — ${r.totalPacks} pk • ${r.totalEggs} eggs • ${r.requiredCrates} cr`,
      );
    }
    if (report.rows.length > slice.length) {
      lines.push(
        `_…${report.rows.length - slice.length} more SKU(s) — see Reports in POS._`,
      );
    }

    lines.push('');
    lines.push(
      `*Grand total:* ${report.totalPacks} pk • ${report.totalEggs} eggs • ${report.totalCrates} crates`,
    );
    lines.push(`*POs for delivery today:* ${report.poCount}`);
    if (report.posWithUnmappedLines > 0) {
      lines.push(
        `⚠️ ${report.posWithUnmappedLines} PO(s) have unmapped line items (excluded from totals).`,
      );
    }

    if (report.byCity.length > 1) {
      lines.push('');
      lines.push('*By city*');
      for (const c of report.byCity.slice(0, 8)) {
        lines.push(
          `• ${c.city}: ${c.totalPacks} pk • ${c.totalCrates} cr (${c.poCount} PO)`,
        );
      }
    }

    lines.push('');
    lines.push('_IST • Good Eggs POS_');
    return lines.join('\n');
  }

  async sendScheduledReport(
    slot: DailyConsolidationSlot,
    deliveryDate?: string,
  ): Promise<{
    delivered: number;
    attempted: number;
    failed: number;
    failures?: Array<{ phone: string; error: string }>;
    orderCount: number;
    skuCount: number;
    messageChars: number;
  }> {
    const report = await this.buildReport(deliveryDate, slot);
    const body = this.formatWhatsAppMessage(report);

    const contacts = await this.notifRepo.find({
      where: { isActive: true },
      order: { label: 'ASC' },
    });

    if (!contacts.length) {
      this.logger.warn(
        `Skipping ${slot} delivery consolidation — no active WhatsApp contacts`,
      );
      return {
        delivered: 0,
        attempted: 0,
        failed: 0,
        orderCount: report.poCount,
        skuCount: report.rows.length,
        messageChars: body.length,
      };
    }

    this.logger.log(
      `Delivery SKU consolidation (${report.deliveryDate} IST, ${slot}): ${report.rows.length} SKU(s), ${report.poCount} PO(s) → ${contacts.length} contact(s)`,
    );

    const templateSummary = `${report.deliveryDate} ${report.slotLabel}: ${report.poCount} order(s), ${report.rows.length} SKU(s), ${report.totalPacks} packs total. Review full breakdown in the order portal.`;

    const results = await Promise.all(
      contacts.map(async (c) => {
        try {
          const r = await this.whatsappService.sendScheduledNotification(
            c.phone,
            body,
            {
              templatePurpose: 'delivery_report',
              templateSummary,
            },
          );
          if (r.mode === 'skipped') {
            return {
              ok: false as const,
              phone: c.phone,
              error: r.error || 'WhatsApp send skipped',
            };
          }
          return { ok: true as const, phone: c.phone };
        } catch (err) {
          const msg = formatWhatsAppSendError(err);
          this.logger.warn(`WhatsApp consolidation report failed for ${c.phone}: ${msg}`);
          return { ok: false as const, phone: c.phone, error: msg };
        }
      }),
    );

    const delivered = results.filter((r) => r.ok).length;
    const failures = results
      .filter((r): r is { ok: false; phone: string; error: string } => !r.ok)
      .map((r) => ({ phone: r.phone, error: r.error }));

    return {
      delivered,
      attempted: contacts.length,
      failed: failures.length,
      failures: failures.length ? failures : undefined,
      orderCount: report.poCount,
      skuCount: report.rows.length,
      messageChars: body.length,
    };
  }

  toCsvRows(report: DailyDeliveryConsolidationReport): Record<string, unknown>[] {
    return report.rows.map((r) => ({
      deliveryDate: report.deliveryDate,
      slot: report.slot,
      skuCode: r.skuCode,
      skuName: r.skuName,
      packSize: r.packSize,
      totalPacks: r.totalPacks,
      totalEggs: r.totalEggs,
      requiredCrates: r.requiredCrates,
    }));
  }

  private toRow(
    skuCode: string,
    skuName: string,
    packSize: number,
    totalPacks: number,
  ): DailySkuConsolidationRow {
    const totalEggs = totalPacks * packSize;
    return {
      skuCode,
      skuName,
      packSize,
      totalPacks,
      totalEggs,
      requiredCrates: Math.ceil(totalEggs / EGGS_PER_CRATE),
    };
  }

  private num(v: unknown, fallback = 0): number {
    if (v === null || v === undefined) return fallback;
    const n = typeof v === 'string' ? parseFloat(v) : Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
}
