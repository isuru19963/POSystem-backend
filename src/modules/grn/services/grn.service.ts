import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import {
  Grn,
  GrnLineItem,
  GrnStatus,
  PurchaseOrder,
  PoStatus,
  Delivery,
  DispatchStatus,
} from '../../../database/entities';
import { AlertsService } from '../../alerts/services/alerts.service';
import { AlertType } from '../../../database/entities';
import { CreateGrnDto } from '../dto/create-grn.dto';
import { CreateGrnManualDto, ManualGrnLineItemDto } from '../dto/create-grn-manual.dto';
import { GrnPdfExtractionService, GrnExtractionResult, GrnExtractedLineItem } from './grn-pdf-extraction.service';
import { messageIdSearchVariants } from '../../../common/utils/email-message-id.util';

function parseFlexibleDate(dateStr?: string): Date | undefined {
  if (!dateStr) return undefined;
  const raw = String(dateStr).trim();
  if (!raw || /^0+$/.test(raw)) return undefined;
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    const ms = raw.length === 10 ? n * 1000 : n;
    const tsDate = new Date(ms);
    if (!isNaN(tsDate.getTime()) && tsDate.getUTCFullYear() >= 2000) return tsDate;
    return undefined;
  }
  const dmy = raw.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const parsed = new Date(iso);
    if (!isNaN(parsed.getTime()) && parsed.getUTCFullYear() >= 2000) return parsed;
    return undefined;
  }
  const normalized = raw.replace(/\b([ap])\.?m\.?\b/gi, '$1m');
  const parsed = new Date(normalized);
  if (isNaN(parsed.getTime()) || parsed.getUTCFullYear() < 2000) return undefined;
  return parsed;
}

export interface SyncDeliveredStatusResult {
  poUpdated: boolean;
  deliveriesUpdated: number;
}

export interface BackfillDeliveredFromGrnsResult {
  purchaseOrdersChecked: number;
  purchaseOrdersMarkedDelivered: number;
  deliveriesMarkedDelivered: number;
}

export interface ThreeWayMatchResult {
  grnId: string;
  poNumber: string;
  isMatched: boolean;
  items: Array<{
    skuCode: string;
    poQuantity: number;
    deliveredQuantity: number;
    grnQuantity: number;
    accepted: number;
    rejected: number;
    status: 'matched' | 'mismatch';
  }>;
}

@Injectable()
export class GrnService {
  private readonly logger = new Logger(GrnService.name);

  constructor(
    @InjectRepository(Grn)
    private readonly grnRepo: Repository<Grn>,
    @InjectRepository(GrnLineItem)
    private readonly grnLineItemRepo: Repository<GrnLineItem>,
    @InjectRepository(PurchaseOrder)
    private readonly poRepo: Repository<PurchaseOrder>,
    @InjectRepository(Delivery)
    private readonly deliveryRepo: Repository<Delivery>,
    private readonly alertsService: AlertsService,
    private readonly grnPdfService: GrnPdfExtractionService,
  ) {}

  /**
   * When a GRN is linked to a PO, mark the PO and its deliveries as delivered.
   */
  async syncDeliveredStatusForPo(
    purchaseOrderId: string,
  ): Promise<SyncDeliveredStatusResult> {
    const result: SyncDeliveredStatusResult = {
      poUpdated: false,
      deliveriesUpdated: 0,
    };

    const po = await this.poRepo.findOne({ where: { id: purchaseOrderId } });
    if (!po) return result;

    if (po.status !== PoStatus.COMPLETED && po.status !== PoStatus.REJECTED) {
      if (po.status !== PoStatus.DELIVERED) {
        po.status = PoStatus.DELIVERED;
        await this.poRepo.save(po);
        result.poUpdated = true;
        this.logger.log(`PO ${po.poNumber} marked delivered (GRN received)`);
      }
    }

    const deliveries = await this.deliveryRepo.find({
      where: { purchaseOrderId },
    });
    for (const delivery of deliveries) {
      if (delivery.status === DispatchStatus.DELIVERED) continue;
      delivery.status = DispatchStatus.DELIVERED;
      if (!delivery.actualDeliveryDate) {
        delivery.actualDeliveryDate = new Date();
      }
      await this.deliveryRepo.save(delivery);
      result.deliveriesUpdated += 1;
      this.logger.log(
        `Delivery ${delivery.id} marked delivered (GRN for PO ${po.poNumber})`,
      );
    }

    return result;
  }

  /**
   * One-time / on-demand: for every PO that already has at least one GRN,
   * apply delivered status to the PO and its deliveries.
   */
  async backfillDeliveredStatusFromExistingGrns(): Promise<BackfillDeliveredFromGrnsResult> {
    const rows = await this.grnRepo
      .createQueryBuilder('g')
      .select('DISTINCT g.purchase_order_id', 'purchaseOrderId')
      .getRawMany<{ purchaseOrderId: string }>();

    let purchaseOrdersMarkedDelivered = 0;
    let deliveriesMarkedDelivered = 0;

    for (const row of rows) {
      const purchaseOrderId = row.purchaseOrderId;
      if (!purchaseOrderId) continue;
      const sync = await this.syncDeliveredStatusForPo(purchaseOrderId);
      if (sync.poUpdated) purchaseOrdersMarkedDelivered += 1;
      deliveriesMarkedDelivered += sync.deliveriesUpdated;
    }

    return {
      purchaseOrdersChecked: rows.length,
      purchaseOrdersMarkedDelivered,
      deliveriesMarkedDelivered,
    };
  }

  /**
   * Perform 3-way matching: PO vs Delivered vs GRN
   */
  async performThreeWayMatch(grnId: string): Promise<ThreeWayMatchResult> {
    const grn = await this.grnRepo.findOne({
      where: { id: grnId },
      relations: ['lineItems', 'lineItems.sku', 'purchaseOrder'],
    });
    if (!grn) throw new NotFoundException(`GRN ${grnId} not found`);

    const po = await this.poRepo.findOne({
      where: { id: grn.purchaseOrderId },
      relations: ['lineItems', 'lineItems.sku'],
    });
    if (!po) throw new NotFoundException(`PO for GRN ${grnId} not found`);

    // Get delivery data
    const deliveries = await this.deliveryRepo.find({
      where: { purchaseOrderId: po.id },
      relations: ['lineItems'],
    });

    // Build delivery totals by SKU
    const deliveryTotals = new Map<string, number>();
    for (const delivery of deliveries) {
      for (const li of delivery.lineItems) {
        if (!li.skuId) continue;
        const current = deliveryTotals.get(li.skuId) || 0;
        deliveryTotals.set(li.skuId, current + li.deliveredQuantity);
      }
    }

    let allMatched = true;
    const items: ThreeWayMatchResult['items'] = [];

    for (const grnItem of grn.lineItems) {
      const poItem = po.lineItems.find((li) => li.skuId === grnItem.skuId);
      const deliveredQty = (grnItem.skuId ? deliveryTotals.get(grnItem.skuId) : undefined) || 0;

      const isMatch =
        poItem &&
        poItem.quantity === deliveredQty &&
        deliveredQty === grnItem.acceptedQuantity;

      if (!isMatch) allMatched = false;

      items.push({
        skuCode: grnItem.sku?.code || grnItem.itemCode || grnItem.skuId || 'unknown',
        poQuantity: poItem?.quantity || 0,
        deliveredQuantity: deliveredQty,
        grnQuantity: grnItem.receivedQuantity,
        accepted: grnItem.acceptedQuantity,
        rejected: grnItem.rejectedQuantity,
        status: isMatch ? 'matched' : 'mismatch',
      });
    }

    // Update GRN status
    grn.status = allMatched ? GrnStatus.MATCHED : GrnStatus.MISMATCH;
    grn.matchResult = { items, matchedAt: new Date().toISOString() };
    await this.grnRepo.save(grn);

    // Alert on mismatch
    if (!allMatched) {
      const mismatches = items.filter((i) => i.status === 'mismatch');
      await this.alertsService.createAlert({
        type: AlertType.GRN_MISMATCH,
        subject: `GRN Mismatch - PO ${po.poNumber}`,
        message: `3-way match failed for GRN ${grn.grnNumber}.\n${mismatches
          .map(
            (m) =>
              `SKU ${m.skuCode}: PO=${m.poQuantity}, Delivered=${m.deliveredQuantity}, GRN=${m.accepted}`,
          )
          .join('\n')}`,
        referenceId: grn.id,
        referenceType: 'grn',
      });
    }

    return {
      grnId: grn.id,
      poNumber: po.poNumber,
      isMatched: allMatched,
      items,
    };
  }

  async createGrn(dto: CreateGrnDto): Promise<Grn> {
    const po = await this.poRepo.findOne({ where: { id: dto.purchaseOrderId } });
    if (!po) throw new NotFoundException(`PO ${dto.purchaseOrderId} not found`);

    const grn = this.grnRepo.create({
      purchaseOrderId: dto.purchaseOrderId,
      grnNumber: dto.grnNumber,
      grnDate: new Date(dto.grnDate),
      status: GrnStatus.RECEIVED,
      lineItems: dto.lineItems.map((li) =>
        this.grnLineItemRepo.create({
          skuId: li.skuId,
          receivedQuantity: li.receivedQuantity,
          acceptedQuantity: li.acceptedQuantity,
          rejectedQuantity: li.rejectedQuantity ?? li.receivedQuantity - li.acceptedQuantity,
          rejectionReason: li.rejectionReason,
        }),
      ),
    });

    const saved = await this.grnRepo.save(grn);
    await this.syncDeliveredStatusForPo(saved.purchaseOrderId);
    return saved;
  }

  async findById(id: string): Promise<Grn> {
    const grn = await this.grnRepo.findOne({
      where: { id },
      relations: [
        'purchaseOrder',
        'purchaseOrder.vendor',
        'purchaseOrder.lineItems',
        'purchaseOrder.lineItems.sku',
        'lineItems',
        'lineItems.sku',
      ],
    });
    if (!grn) throw new NotFoundException(`GRN ${id} not found`);
    return grn;
  }

  async updateStatus(id: string, status: GrnStatus): Promise<Grn> {
    const grn = await this.grnRepo.findOne({ where: { id } });
    if (!grn) throw new NotFoundException(`GRN ${id} not found`);
    await this.grnRepo.update(id, { status });
    return this.findById(id);
  }

  async updateNotes(id: string, notes: string | undefined): Promise<Grn> {
    const grn = await this.grnRepo.findOne({ where: { id } });
    if (!grn) throw new NotFoundException(`GRN ${id} not found`);
    await this.grnRepo.update(id, { notes });
    return this.findById(id);
  }

  async findAll(): Promise<Grn[]> {
    return this.grnRepo.find({
      relations: [
        'purchaseOrder',
        'purchaseOrder.vendor',
        'purchaseOrder.lineItems',
        'lineItems',
        'lineItems.sku',
      ],
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Match PO by number with common PDF/email variants (spaces, case, prefixes).
   */
  private async findPurchaseOrderForGrn(
    poNumber: string,
  ): Promise<PurchaseOrder | null> {
    const trimmed = poNumber.trim();
    if (!trimmed) return null;

    const variants = new Set<string>([trimmed, trimmed.toUpperCase()]);
    const compact = trimmed.replace(/\s+/g, '');
    if (compact) variants.add(compact.toUpperCase());

    const cloudstorePo = trimmed.match(
      /\b((?:CFF|CMP|CVPL|CVP|HP)PO\d{4,}[A-Z0-9-]*)\b/i,
    );
    if (cloudstorePo?.[1]) {
      variants.add(cloudstorePo[1].toUpperCase());
    }

    const poNumMatch = trimmed.match(
      /\b((?:CFF|HP|PO|CVP|CVPL)?[-_]?\d{5,}[A-Z0-9-]*)\b/i,
    );
    if (poNumMatch?.[1]) {
      variants.add(poNumMatch[1].toUpperCase());
    }

    for (const candidate of variants) {
      const po = await this.poRepo.findOne({
        where: { poNumber: ILike(candidate) },
        relations: ['lineItems'],
      });
      if (po) return po;
    }

    return this.poRepo
      .createQueryBuilder('po')
      .leftJoinAndSelect('po.lineItems', 'lineItems')
      .where('po.po_number ILIKE :q', { q: `%${compact || trimmed}%` })
      .orderBy('po.created_at', 'DESC')
      .getOne();
  }

  /** Quick PDF sniff — email subject/filename may not mention GRN. */
  async pdfLooksLikeGrn(pdfBuffer: Buffer): Promise<boolean> {
    return this.grnPdfService.looksLikeGrnDocument(pdfBuffer);
  }

  private normalizeDocNumber(raw?: string): string {
    if (!raw) return '';
    let t = String(raw).trim().replace(/[.,;:\-]+$/g, '');
    const cloudstore = t.match(
      /\b((?:CFF|CMP|CVPL|CVP|HP)PO\d{4,}[A-Z0-9-]*)\b/i,
    );
    if (cloudstore?.[1]) return cloudstore[1].toUpperCase();
    return t;
  }

  async findByEmailMessageId(messageId: string | undefined): Promise<Grn | null> {
    const variants = messageIdSearchVariants(messageId);
    if (!variants.length) return null;
    return this.grnRepo.findOne({
      where: variants.map((emailMessageId) => ({ emailMessageId })),
    });
  }

  /**
   * Ingest a GRN PDF from email: extract, match PO by number, persist with email dedupe.
   * Idempotent when the same email Message-Id or GRN number already exists.
   */
  async createFromEmailPdf(params: {
    emailMessageId?: string;
    emailSubject?: string;
    rawFileKey?: string;
    pdfBuffer: Buffer;
  }): Promise<Grn | null> {
    const msgId = params.emailMessageId?.trim();
    if (msgId) {
      const byEmail = await this.findByEmailMessageId(msgId);
      if (byEmail) {
        this.logger.log(`GRN email already processed (Message-Id): ${msgId}`);
        await this.syncDeliveredStatusForPo(byEmail.purchaseOrderId);
        return byEmail;
      }
    }

    let extracted = await this.grnPdfService.extract(params.pdfBuffer, {
      emailSubject: params.emailSubject,
    });
    const poNumber = this.normalizeDocNumber(extracted.poNumber);
    const grnNumber = this.normalizeDocNumber(extracted.grnNumber);
    if (!poNumber || !grnNumber) {
      throw new BadRequestException('GRN PDF is missing PO number or GRN number after extraction');
    }

    const po = await this.findPurchaseOrderForGrn(poNumber);
    if (!extracted.lineItems?.length && po?.lineItems?.length) {
      const text = extracted.rawText ?? '';
      const fromCatalog = this.grnPdfService.extractLineItemsFromPoCatalog(
        text,
        po.lineItems,
      );
      if (fromCatalog.length) {
        this.logger.log(
          `GRN ${grnNumber}: matched ${fromCatalog.length} line item(s) from PO ${poNumber} catalogue`,
        );
        extracted = { ...extracted, lineItems: fromCatalog };
      }
    }

    if (!extracted.lineItems?.length && po?.lineItems?.length) {
      const text = extracted.rawText ?? '';
      const sniffed = this.grnPdfService.sniffLineItemsFromPoCatalog(
        text,
        po.lineItems,
      );
      if (sniffed.length) {
        this.logger.log(
          `GRN ${grnNumber}: sniffed ${sniffed.length} line item(s) from PDF text for PO ${poNumber}`,
        );
        extracted = { ...extracted, lineItems: sniffed };
      }
    }

    let importNote: string | undefined;
    if (!extracted.lineItems?.length && po?.lineItems?.length) {
      const fallback = this.grnPdfService.buildFallbackLineItemsFromPo(
        po.lineItems,
      );
      if (fallback.length) {
        this.logger.warn(
          `GRN ${grnNumber}: using ${fallback.length} PO line(s) as placeholder — PDF had no parseable quantities`,
        );
        extracted = { ...extracted, lineItems: fallback };
        importNote =
          'Imported from email; line quantities could not be read from PDF — please review and update received/accepted qty.';
      }
    }

    if (!extracted.lineItems?.length) {
      throw new BadRequestException(
        po
          ? 'GRN PDF has no line items after extraction — check the PDF format or re-import the PO'
          : `PO "${poNumber}" not found — import POs from email first (PO List → Fetch from Email), then fetch GRNs again`,
      );
    }

    const existingNum = await this.grnRepo.findOne({ where: { grnNumber } });
    if (existingNum) {
      this.logger.warn(`GRN number ${grnNumber} already exists; skipping email import`);
      await this.syncDeliveredStatusForPo(existingNum.purchaseOrderId);
      return existingNum;
    }

    const grnDateIso =
      parseFlexibleDate(extracted.grnDate)?.toISOString().slice(0, 10) ??
      new Date().toISOString().slice(0, 10);

    const lineItems = extracted.lineItems.map((li) => this.mapExtractedLineToManual(li));
    for (const li of lineItems) {
      if (!li.itemCode) {
        throw new BadRequestException('GRN PDF has a line item without item code');
      }
    }

    const grn = await this.createGrnManual({
      poNumber,
      grnNumber,
      grnDate: grnDateIso,
      lineItems,
      emailMessageId: msgId,
      rawFileKey: params.rawFileKey,
    });
    if (importNote) {
      await this.grnRepo.update(grn.id, { notes: importNote });
      grn.notes = importNote;
    }
    await this.syncDeliveredStatusForPo(grn.purchaseOrderId);
    return grn;
  }

  private mapExtractedLineToManual(li: GrnExtractedLineItem): ManualGrnLineItemDto {
    let accepted = Math.max(0, Math.round(Number(li.acceptedQty) || 0));
    const r = Number(li.receivedQty);
    const j = Number(li.rejectedQty);
    const hasReceived = Number.isFinite(r);
    const hasRejected = Number.isFinite(j);

    let receivedQuantity = hasReceived ? Math.max(0, Math.round(r)) : accepted;
    let rejectedQuantity = hasRejected ? Math.max(0, Math.round(j)) : Math.max(0, receivedQuantity - accepted);

    if (!hasReceived && hasRejected) {
      receivedQuantity = accepted + rejectedQuantity;
    }
    if (accepted === 0 && receivedQuantity > 0) {
      accepted = Math.max(0, receivedQuantity - rejectedQuantity);
    }

    return {
      itemCode: String(li.itemCode || '').trim(),
      itemName: li.itemName?.trim(),
      receivedQuantity,
      acceptedQuantity: accepted,
      rejectedQuantity,
      rejectionReason: li.rejectionReason,
    };
  }

  /**
   * Manually create a GRN by PO number (no delivery required).
   * Line items are matched to PO items by itemCode.
   */
  async createGrnManual(dto: CreateGrnManualDto): Promise<Grn> {
    if (dto.emailMessageId?.trim()) {
      const dupEmail = await this.findByEmailMessageId(dto.emailMessageId);
      if (dupEmail) {
        throw new BadRequestException(`This email was already imported as GRN ${dupEmail.grnNumber}`);
      }
    }

    const po = await this.findPurchaseOrderForGrn(dto.poNumber);
    if (!po) {
      throw new NotFoundException(
        `PO "${dto.poNumber}" not found — import the PO first, then fetch GRNs again`,
      );
    }

    // Guard against duplicate GRN number
    const existing = await this.grnRepo.findOne({ where: { grnNumber: dto.grnNumber } });
    if (existing) throw new BadRequestException(`GRN number ${dto.grnNumber} already exists`);

    const grn = this.grnRepo.create({
      purchaseOrderId: po.id,
      grnNumber: dto.grnNumber,
      grnDate: new Date(dto.grnDate),
      status: GrnStatus.RECEIVED,
      emailMessageId: dto.emailMessageId?.trim() || undefined,
      rawFileKey: dto.rawFileKey,
      lineItems: dto.lineItems.map((li) => {
        const code = li.itemCode.trim();
        const poItem =
          po.lineItems.find((p) => p.itemCode === code) ||
          po.lineItems.find(
            (p) => p.itemCode?.toUpperCase() === code.toUpperCase(),
          );
        return this.grnLineItemRepo.create({
          skuId: poItem?.skuId,
          itemCode: li.itemCode,
          itemName: li.itemName || poItem?.itemName,
          receivedQuantity: li.receivedQuantity,
          acceptedQuantity: li.acceptedQuantity,
          rejectedQuantity: li.rejectedQuantity ?? (li.receivedQuantity - li.acceptedQuantity),
          rejectionReason: li.rejectionReason,
        });
      }),
    });

    const saved = await this.grnRepo.save(grn);
    await this.syncDeliveredStatusForPo(saved.purchaseOrderId);
    return saved;
  }

  /**
   * Compare PO ordered quantities against GRN received quantities.
   * Finds PO by PO number, gathers all linked GRNs and returns
   * a per-item breakdown showing full/partial/not-received status.
   */
  async compareByPoNumber(poNumber: string): Promise<PoGrnComparisonResult> {
    const po = await this.poRepo.findOne({
      where: { poNumber },
      relations: ['lineItems', 'lineItems.sku', 'vendor', 'grns', 'grns.lineItems'],
    });
    if (!po) throw new NotFoundException(`PO ${poNumber} not found`);

    // Aggregate received qty per itemCode across all GRNs
    const receivedMap = new Map<string, number>();
    for (const grn of po.grns) {
      for (const li of grn.lineItems) {
        const key = li.itemCode || li.skuId || '';
        receivedMap.set(key, (receivedMap.get(key) ?? 0) + li.acceptedQuantity);
      }
    }

    const items: PoGrnComparisonResult['items'] = po.lineItems.map((li) => {
      const key = li.itemCode || li.skuId || '';
      const received = receivedMap.get(key) ?? 0;
      const ordered = li.quantity;
      let fulfillmentStatus: 'full' | 'partial' | 'not_received';
      if (received === 0) fulfillmentStatus = 'not_received';
      else if (received >= ordered) fulfillmentStatus = 'full';
      else fulfillmentStatus = 'partial';

      return {
        itemCode: li.itemCode,
        itemName: li.itemName || li.sku?.name || li.itemCode,
        hsnCode: li.hsnCode,
        orderedQty: ordered,
        receivedQty: received,
        pendingQty: Math.max(0, ordered - received),
        poPrice: Number(li.poPrice),
        fulfillmentStatus,
      };
    });

    const totalOrdered = items.reduce((s, i) => s + i.orderedQty, 0);
    const totalReceived = items.reduce((s, i) => s + i.receivedQty, 0);

    return {
      poNumber: po.poNumber,
      poDate: po.poDate,
      vendor: po.vendor?.name || '',
      shippingLocation: po.shippingLocation,
      expectedDeliveryDate: po.expectedDeliveryDate,
      totalAmount: po.totalAmount ? Number(po.totalAmount) : undefined,
      grnCount: po.grns.length,
      totalOrdered,
      totalReceived,
      fulfillmentPercent: totalOrdered > 0 ? Math.round((totalReceived / totalOrdered) * 100) : 0,
      overallStatus: totalReceived === 0 ? 'not_received' : totalReceived >= totalOrdered ? 'full' : 'partial',
      items,
    };
  }

  /**
   * Extract GRN data from a PDF. Does NOT write to the database.
   * Returns the raw extraction result for the user to review and confirm.
   */
  async extractGrnPdf(fileBuffer: Buffer): Promise<GrnExtractionResult> {
    const extraction = await this.grnPdfService.extract(fileBuffer);
    this.logger.log(
      `Extracted GRN PDF: number=${extraction.grnNumber}, PO=${extraction.poNumber}, items=${extraction.lineItems.length}`,
    );
    return extraction;
  }
}

export interface PoGrnComparisonResult {
  poNumber: string;
  poDate: Date;
  vendor: string;
  shippingLocation: string;
  expectedDeliveryDate?: Date;
  totalAmount?: number;
  grnCount: number;
  totalOrdered: number;
  totalReceived: number;
  fulfillmentPercent: number;
  overallStatus: 'full' | 'partial' | 'not_received';
  items: Array<{
    itemCode: string;
    itemName: string;
    hsnCode?: string;
    orderedQty: number;
    receivedQty: number;
    pendingQty: number;
    poPrice: number;
    fulfillmentStatus: 'full' | 'partial' | 'not_received';
  }>;
}
