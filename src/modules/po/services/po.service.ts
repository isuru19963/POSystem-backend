import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  Between,
  FindOptionsWhere,
  In,
  ILike,
  IsNull,
} from 'typeorm';
import {
  PurchaseOrder,
  PoStatus,
  Vendor,
  PurchaseOrderLineItem,
  Sku,
  Delivery,
  DeliveryLineItem,
  Grn,
  GrnLineItem,
  NotificationContact,
} from '../../../database/entities';
import { QueryPoDto } from '../dto/query-po.dto';
import { ExtractedLineItem } from './pdf-extraction.service';
import { isOwnCompanyName } from './own-company';
import { WhatsappService } from '../../../whatsapp/whatsapp.service';
import { StorageService } from '../../../storage/storage.service';
import { ValidationService } from '../../validation/services/validation.service';
import { SkuResolutionService } from './sku-resolution.service';
import { messageIdSearchVariants } from '../../../common/utils/email-message-id.util';
import { sanitizeVendorNameForImport } from '../../../common/utils/customer-name.util';
import {
  EmailAttachment,
  ImapService,
  IncomingEmail,
} from '../../../email/imap.service';
import { v4 as uuidv4 } from 'uuid';

export type PoSourceFileKind = 'pdf' | 'xls';

export interface PoSourceFileInfo {
  kind: PoSourceFileKind;
  fileName: string;
}

@Injectable()
export class PoService {
  private readonly logger = new Logger(PoService.name);

  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepo: Repository<PurchaseOrder>,
    @InjectRepository(Vendor)
    private readonly vendorRepo: Repository<Vendor>,
    @InjectRepository(PurchaseOrderLineItem)
    private readonly lineItemRepo: Repository<PurchaseOrderLineItem>,
    @InjectRepository(Sku)
    private readonly skuRepo: Repository<Sku>,
    @InjectRepository(Delivery)
    private readonly deliveryRepo: Repository<Delivery>,
    @InjectRepository(DeliveryLineItem)
    private readonly deliveryLineItemRepo: Repository<DeliveryLineItem>,
    @InjectRepository(Grn)
    private readonly grnRepo: Repository<Grn>,
    @InjectRepository(GrnLineItem)
    private readonly grnLineItemRepo: Repository<GrnLineItem>,
    @InjectRepository(NotificationContact)
    private readonly notifContactRepo: Repository<NotificationContact>,
    private readonly whatsappService: WhatsappService,
    private readonly storageService: StorageService,
    private readonly validationService: ValidationService,
    private readonly skuResolutionService: SkuResolutionService,
    private readonly imapService: ImapService,
  ) {}

  async findAll(query: QueryPoDto): Promise<PurchaseOrder[]> {
    const baseWhere: FindOptionsWhere<PurchaseOrder> = {};

    if (query.status) baseWhere.status = query.status;
    if (query.vendorId) baseWhere.vendorId = query.vendorId;
    if (query.poNumber) baseWhere.poNumber = query.poNumber;
    if (query.fromDate && query.toDate) {
      baseWhere.poDate = Between(
        new Date(query.fromDate),
        new Date(query.toDate),
      );
    }

    const search = query.search?.trim();
    let where:
      | FindOptionsWhere<PurchaseOrder>
      | FindOptionsWhere<PurchaseOrder>[] = baseWhere;
    if (search) {
      const term = `%${search}%`;
      // Match on PO number OR vendor (customer) name; both must respect the other base filters.
      where = [
        { ...baseWhere, poNumber: ILike(term) },
        { ...baseWhere, vendor: { name: ILike(term) } },
      ];
    }

    return this.poRepo.find({
      where,
      relations: ['vendor', 'lineItems', 'lineItems.sku'],
      order: { createdAt: 'DESC' },
    });
  }

  async findById(id: string): Promise<PurchaseOrder> {
    const po = await this.poRepo.findOne({
      where: { id },
      relations: ['vendor', 'lineItems', 'lineItems.sku'],
    });
    if (!po) throw new NotFoundException(`PO with id ${id} not found`);
    return Object.assign(po, { sourceFiles: this.listSourceFiles(po) });
  }

  /** Stored PDF/XLS keys on the PO — used by the drawer “view original” actions. */
  listSourceFiles(po: Pick<PurchaseOrder, 'rawFileKey' | 'rawXlsFileKey' | 'poNumber'>): PoSourceFileInfo[] {
    const files: PoSourceFileInfo[] = [];
    if (po.rawFileKey?.trim()) {
      files.push({
        kind: 'pdf',
        fileName: this.sourceFileName(po.rawFileKey, po.poNumber, 'pdf'),
      });
    }
    if (po.rawXlsFileKey?.trim()) {
      files.push({
        kind: 'xls',
        fileName: this.sourceFileName(po.rawXlsFileKey, po.poNumber, 'xls'),
      });
    }
    return files;
  }

  async getSourceFile(
    id: string,
    kind?: PoSourceFileKind,
  ): Promise<{ buffer: Buffer; fileName: string; contentType: string }> {
    const po = await this.poRepo.findOne({ where: { id } });
    if (!po) throw new NotFoundException(`PO with id ${id} not found`);

    const resolved = this.resolveSourceFileKey(po, kind);
    if (!resolved) {
      throw new NotFoundException('No original PO file is stored for this order');
    }

    const buffer = await this.storageService.getFile(resolved.key);
    return {
      buffer,
      fileName: this.sourceFileName(resolved.key, po.poNumber, resolved.kind),
      contentType: this.contentTypeForKey(resolved.key),
    };
  }

  private resolveSourceFileKey(
    po: Pick<PurchaseOrder, 'rawFileKey' | 'rawXlsFileKey'>,
    kind?: PoSourceFileKind,
  ): { key: string; kind: PoSourceFileKind } | null {
    if (kind === 'pdf') {
      return po.rawFileKey?.trim()
        ? { key: po.rawFileKey.trim(), kind: 'pdf' }
        : null;
    }
    if (kind === 'xls') {
      return po.rawXlsFileKey?.trim()
        ? { key: po.rawXlsFileKey.trim(), kind: 'xls' }
        : null;
    }
    if (po.rawFileKey?.trim()) {
      return { key: po.rawFileKey.trim(), kind: 'pdf' };
    }
    if (po.rawXlsFileKey?.trim()) {
      return { key: po.rawXlsFileKey.trim(), kind: 'xls' };
    }
    return null;
  }

  private sourceFileName(
    storageKey: string,
    poNumber: string,
    kind: PoSourceFileKind,
  ): string {
    const base = storageKey.split('/').pop()?.trim();
    if (base) return base;
    return kind === 'pdf' ? `${poNumber}.pdf` : `${poNumber}.xls`;
  }

  private contentTypeForKey(key: string): string {
    const lower = key.toLowerCase();
    if (lower.endsWith('.pdf')) return 'application/pdf';
    if (lower.endsWith('.xlsx')) {
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
    if (lower.endsWith('.csv')) return 'text/csv';
    return 'application/octet-stream';
  }

  /**
   * Re-download the PO's PDF/XLS from the mailbox (by stored Message-ID),
   * upload to S3, and refresh raw_file_key columns. Fixes POs imported before
   * persistent S3 storage or after ephemeral disk loss on EB.
   */
  async restoreSourceFilesFromEmail(
    poId: string,
  ): Promise<{ sourceFiles: PoSourceFileInfo[]; restoredPdf: boolean; restoredXls: boolean }> {
    const po = await this.poRepo.findOne({ where: { id: poId } });
    if (!po) throw new NotFoundException(`PO with id ${poId} not found`);

    const msgId = po.emailMessageId?.trim();
    if (!msgId || msgId.startsWith('upload-')) {
      throw new BadRequestException(
        'This PO has no linked email message (manual upload). Re-upload the file instead.',
      );
    }

    const email = await this.imapService.fetchEmailByMessageId(msgId);
    if (!email?.attachments?.length) {
      throw new NotFoundException(
        'Could not find this email in the mailbox, or it has no PDF/spreadsheet attachment. Check that the message still exists in INBOX.',
      );
    }

    const pdfAttachment = this.pickPoPdfAttachment(email);
    const xlsAttachment = this.pickPoXlsAttachment(email);

    if (!pdfAttachment && !xlsAttachment) {
      throw new BadRequestException(
        'The email was found but has no PDF or spreadsheet attachment.',
      );
    }

    const batchId = uuidv4();
    let restoredPdf = false;
    let restoredXls = false;

    if (pdfAttachment) {
      po.rawFileKey = `po-files/${batchId}/${pdfAttachment.filename}`;
      await this.storageService.uploadFile(
        po.rawFileKey,
        pdfAttachment.content,
        pdfAttachment.contentType,
      );
      restoredPdf = true;
      this.logger.log(
        `Restored PDF for PO ${po.poNumber} from email → ${po.rawFileKey}`,
      );
    }

    if (xlsAttachment) {
      po.rawXlsFileKey = `po-files/${batchId}/${xlsAttachment.filename}`;
      await this.storageService.uploadFile(
        po.rawXlsFileKey,
        xlsAttachment.content,
        xlsAttachment.contentType,
      );
      restoredXls = true;
      this.logger.log(
        `Restored XLS for PO ${po.poNumber} from email → ${po.rawXlsFileKey}`,
      );
    }

    await this.poRepo.save(po);

    return {
      sourceFiles: this.listSourceFiles(po),
      restoredPdf,
      restoredXls,
    };
  }

  private pickPoPdfAttachment(
    email: IncomingEmail,
  ): EmailAttachment | undefined {
    return email.attachments.find(
      (a) =>
        a.contentType === 'application/pdf' ||
        a.filename.toLowerCase().endsWith('.pdf'),
    );
  }

  private pickPoXlsAttachment(
    email: IncomingEmail,
  ): EmailAttachment | undefined {
    return email.attachments.find(
      (a) =>
        a.filename.toLowerCase().endsWith('.xls') ||
        a.filename.toLowerCase().endsWith('.xlsx') ||
        a.filename.toLowerCase().endsWith('.csv') ||
        a.contentType.includes('spreadsheet') ||
        a.contentType.includes('excel') ||
        a.contentType.includes('csv'),
    );
  }

  /** Check for duplicate PO by poNumber + vendorId */
  async isDuplicate(poNumber: string, vendorId: string): Promise<boolean> {
    const existing = await this.poRepo.findOne({
      where: { poNumber, vendorId },
    });
    return !!existing;
  }

  /** Prefer rows with shipping, totals, line items, and a specific legal-entity vendor name. */
  private poCompletenessScore(po: PurchaseOrder): number {
    let s = 0;
    if (po.shippingLocation?.trim()) s += 3;
    if (po.expectedDeliveryDate) s += 2;
    if (po.totalAmount != null && Number(po.totalAmount) > 0) s += 3;
    s += (po.lineItems?.length ?? 0) * 2;
    const vn = (po.vendor?.name ?? '').trim().toLowerCase();
    if (vn && vn !== 'hyperpure') s += 2;
    return s;
  }

  private shouldPreferIncomingVendor(
    incoming: Vendor,
    existingPo: PurchaseOrder,
  ): boolean {
    const oldName = (existingPo.vendor?.name ?? '').trim();
    const newName = incoming.name.trim();
    if (!oldName) return true;
    if (/^hyperpure$/i.test(oldName) && /hyperpure/i.test(newName)) return true;
    if (newName.length > oldName.length + 8) return true;
    return false;
  }

  /**
   * Same PO number was stored more than once because the unique key is (poNumber, vendorId)
   * and extraction sometimes used "Hyperpure" vs "Zomato Hyperpure Pvt. Ltd.".
   * Merge onto the most complete row and drop empty duplicate siblings that have no GRN/delivery.
   */
  private async mergeDuplicatePosByNumber(
    poNumber: string,
    data: {
      poDate: Date;
      vendorName: string;
      shippingLocation: string;
      rawFileKey?: string;
      rawXlsFileKey?: string;
      emailMessageId: string;
      expectedDeliveryDate?: Date;
      expiryDate?: Date;
      paymentTerms?: string;
      totalAmount?: number;
      lineItems?: ExtractedLineItem[];
      extractedData?: Record<string, unknown>;
    },
    resolvedVendor: Vendor,
  ): Promise<PurchaseOrder | null> {
    const trimmed = poNumber.trim();
    if (!trimmed) return null;

    const siblings = await this.poRepo.find({
      where: { poNumber: trimmed },
      relations: ['vendor', 'lineItems', 'deliveries', 'grns'],
    });
    if (siblings.length === 0) return null;

    const best = siblings.reduce((a, b) => {
      const sa = this.poCompletenessScore(a);
      const sb = this.poCompletenessScore(b);
      if (sb !== sa) return sb > sa ? b : a;
      return new Date(a.createdAt).getTime() <= new Date(b.createdAt).getTime()
        ? a
        : b;
    });

    let dirty = false;
    if (!best.shippingLocation?.trim() && data.shippingLocation?.trim()) {
      best.shippingLocation = data.shippingLocation;
      dirty = true;
    }
    if (!best.expectedDeliveryDate && data.expectedDeliveryDate) {
      best.expectedDeliveryDate = data.expectedDeliveryDate;
      dirty = true;
    }
    if (!best.expiryDate && data.expiryDate) {
      best.expiryDate = data.expiryDate;
      dirty = true;
    }
    if (!best.paymentTerms?.trim() && data.paymentTerms?.trim()) {
      best.paymentTerms = data.paymentTerms;
      dirty = true;
    }
    if (
      (best.totalAmount == null || Number(best.totalAmount) <= 0) &&
      data.totalAmount != null
    ) {
      best.totalAmount = data.totalAmount;
      dirty = true;
    }
    if (!best.rawFileKey && data.rawFileKey) {
      best.rawFileKey = data.rawFileKey;
      dirty = true;
    }
    if (!best.rawXlsFileKey && data.rawXlsFileKey) {
      best.rawXlsFileKey = data.rawXlsFileKey;
      dirty = true;
    }
    if (!best.emailMessageId?.trim() && data.emailMessageId?.trim()) {
      best.emailMessageId = data.emailMessageId;
      dirty = true;
    }

    if (
      this.shouldPreferIncomingVendor(resolvedVendor, best) &&
      best.vendorId !== resolvedVendor.id
    ) {
      best.vendorId = resolvedVendor.id;
      dirty = true;
    }

    if (data.extractedData && Object.keys(data.extractedData).length > 0) {
      best.extractedData = {
        ...(best.extractedData ?? {}),
        ...data.extractedData,
        mergedFromDuplicatePoNumber: true,
      } as Record<string, unknown>;
      dirty = true;
    }

    if (dirty) await this.poRepo.save(best);

    // Keep the merged row's status in sync with the SKU-mapping state of its
    // line items. After enriching with newly-extracted items below, this is
    // re-evaluated again to flip back to `EXTRACTED` if everything maps.
    await this.refreshPoSkuMappingStatus(best.id);

    const liCount = await this.lineItemRepo.count({
      where: { purchaseOrderId: best.id },
    });
    if (liCount === 0 && data.lineItems && data.lineItems.length > 0) {
      const lineItemEntities: PurchaseOrderLineItem[] = [];
      for (const item of data.lineItems) {
        const sku = await this.resolveSkuForItem(item);
        lineItemEntities.push(
          this.lineItemRepo.create({
            purchaseOrderId: best.id,
            itemCode: item.skuCode,
            itemName: item.skuName,
            hsnCode: item.hsnCode,
            skuId: sku?.id,
            quantity: item.quantity,
            poPrice: item.price,
            poMrp: item.mrp,
          }),
        );
      }
      await this.lineItemRepo.save(lineItemEntities);
      this.logger.log(
        `Enriched PO ${trimmed}: added ${lineItemEntities.length} line items from a later email/extraction.`,
      );
    }

    const winnerScore = this.poCompletenessScore(best);
    for (const loser of siblings) {
      if (loser.id === best.id) continue;
      const dCount = loser.deliveries?.length ?? 0;
      const gCount = loser.grns?.length ?? 0;
      const loserLiCount = await this.lineItemRepo.count({
        where: { purchaseOrderId: loser.id },
      });
      if (
        dCount === 0 &&
        gCount === 0 &&
        loserLiCount === 0 &&
        this.poCompletenessScore(loser) < winnerScore
      ) {
        this.logger.warn(
          `Removing incomplete duplicate PO row ${loser.id} (${loser.poNumber}, vendor=${loser.vendor?.name}) in favour of ${best.id}.`,
        );
        await this.removeById(loser.id);
      }
    }

    const allMapped = await this.refreshPoSkuMappingStatus(best.id);
    if (allMapped) {
      try {
        await this.validationService.validatePo(best.id);
      } catch (err) {
        this.logger.error(
          `Auto-validation failed after PO merge for ${trimmed}: ${(err as Error)?.message}`,
        );
      }
    } else {
      this.logger.warn(
        `Merged PO ${trimmed} still has unmapped line items — skipping auto-validation until SKUs are mapped.`,
      );
    }

    this.logger.log(
      `Merged duplicate PO number ${trimmed} onto PO id ${best.id}.`,
    );
    return this.findById(best.id);
  }

  /** Check for duplicate by email message ID (any common Message-ID formatting). */
  async isDuplicateEmail(emailMessageId: string): Promise<boolean> {
    const variants = messageIdSearchVariants(emailMessageId);
    if (!variants.length) return false;
    const existing = await this.poRepo.findOne({
      where: variants.map((emailMessageId) => ({ emailMessageId })),
    });
    return !!existing;
  }

  async createFromEmail(data: {
    poNumber: string;
    poDate: Date;
    vendorName: string;
    shippingLocation: string;
    rawFileKey?: string;
    rawXlsFileKey?: string;
    emailMessageId: string;
    expectedDeliveryDate?: Date;
    expiryDate?: Date;
    paymentTerms?: string;
    totalAmount?: number;
    lineItems?: ExtractedLineItem[];
    extractedData?: Record<string, unknown>;
  }): Promise<PurchaseOrder> {
    data.poNumber = data.poNumber.trim();
    if (!data.poNumber) {
      throw new BadRequestException('PO number is required');
    }
    // Defensive guard: if extraction accidentally returned our own company as
    // the customer/vendor, fall back to a placeholder so we never persist
    // ourselves as the buyer. This complements the per-extractor filters.
    const cleanedVendor = sanitizeVendorNameForImport(data.vendorName);
    if (cleanedVendor) {
      data.vendorName = cleanedVendor;
    } else if (isOwnCompanyName(data.vendorName)) {
      this.logger.warn(
        `Vendor name "${data.vendorName}" matched our own company; saving as "Unknown Customer".`,
      );
      data.vendorName = 'Unknown Customer';
    } else if (data.vendorName?.trim()) {
      this.logger.warn(
        `Discarding junk vendor label on import: ${JSON.stringify(data.vendorName)}`,
      );
      data.vendorName = 'Unknown Customer';
    }

    // Resolve vendor by name (fuzzy) or code
    let vendor = await this.vendorRepo.findOne({
      where: { name: data.vendorName },
    });
    if (!vendor) {
      // Try by code
      vendor = await this.vendorRepo.findOne({
        where: { code: data.vendorName },
      });
    }
    if (!vendor) {
      // Auto-create vendor if not found
      this.logger.warn(
        `Vendor "${data.vendorName}" not found, creating automatically`,
      );
      vendor = this.vendorRepo.create({
        name: data.vendorName,
        code: data.vendorName.replace(/\s+/g, '_').substring(0, 50),
      });
      vendor = await this.vendorRepo.save(vendor);
    }

    const merged = await this.mergeDuplicatePosByNumber(
      data.poNumber,
      data,
      vendor,
    );
    if (merged) {
      return merged;
    }

    // Check for duplicate
    if (await this.isDuplicate(data.poNumber, vendor.id)) {
      this.logger.warn(
        `Duplicate PO detected: ${data.poNumber} for vendor ${vendor.name}`,
      );
      throw new Error(
        `Duplicate PO: ${data.poNumber} already exists for vendor ${vendor.name}`,
      );
    }

    const po = this.poRepo.create({
      poNumber: data.poNumber,
      poDate: data.poDate,
      vendorId: vendor.id,
      shippingLocation: data.shippingLocation,
      rawFileKey: data.rawFileKey,
      rawXlsFileKey: data.rawXlsFileKey,
      emailMessageId: data.emailMessageId,
      expectedDeliveryDate: data.expectedDeliveryDate,
      expiryDate: data.expiryDate,
      paymentTerms: data.paymentTerms,
      totalAmount: data.totalAmount,
      extractedData: data.extractedData,
      status: PoStatus.EXTRACTED,
    });

    const savedPo = await this.poRepo.save(po);

    // Create line items
    if (data.lineItems && data.lineItems.length > 0) {
      const lineItemEntities: PurchaseOrderLineItem[] = [];
      for (const item of data.lineItems) {
        const sku = await this.resolveSkuForItem(item);

        const lineItem = this.lineItemRepo.create({
          purchaseOrderId: savedPo.id,
          itemCode: item.skuCode,
          itemName: item.skuName,
          hsnCode: item.hsnCode,
          skuId: sku?.id,
          quantity: item.quantity,
          poPrice: item.price,
          poMrp: item.mrp,
        });
        lineItemEntities.push(lineItem);
      }
      await this.lineItemRepo.save(lineItemEntities);
      this.logger.log(
        `Created ${lineItemEntities.length} line items for PO ${data.poNumber}`,
      );
    }

    // Every line item must resolve to one of our SKUs before we trust the PO
    // enough to validate, consolidate, or feed it into reports. If any line
    // item is unmapped, hold the PO in NEEDS_SKU_MAPPING and skip auto-
    // validation — admins can either add the missing SKU then re-match, or
    // map line items individually from the PO drawer.
    const allMapped = await this.refreshPoSkuMappingStatus(savedPo.id);
    if (allMapped) {
      try {
        await this.validationService.validatePo(savedPo.id);
      } catch (err) {
        this.logger.error(
          `Auto-validation failed for PO ${savedPo.poNumber}: ${(err as Error)?.message}`,
        );
      }
    } else {
      this.logger.warn(
        `PO ${savedPo.poNumber} has one or more unmapped line items — held in NEEDS_SKU_MAPPING until mapping is completed.`,
      );
    }

    const fullPo = await this.findById(savedPo.id);
    // Fire-and-forget — don't block PO creation on WhatsApp send
    void this.sendPoWhatsAppNotification(fullPo);
    return fullPo;
  }

  private async sendPoWhatsAppNotification(po: PurchaseOrder): Promise<void> {
    try {
      const contacts = await this.notifContactRepo.find({
        where: { isActive: true },
      });
      if (!contacts.length) return;

      const dateStr = po.poDate
        ? new Date(po.poDate).toLocaleDateString('en-IN')
        : '';
      const totalStr =
        po.totalAmount != null
          ? `₹${Number(po.totalAmount).toLocaleString('en-IN')}`
          : 'N/A';
      const itemCount = (po.lineItems ?? []).length;

      const message = [
        `📦 *New PO Received*`,
        `PO Number: ${po.poNumber}`,
        `Vendor: ${(po as any).vendor?.name ?? 'N/A'}`,
        `Date: ${dateStr}`,
        `Items: ${itemCount}`,
        `Total: ${totalStr}`,
        po.shippingLocation ? `Ship To: ${po.shippingLocation}` : '',
        po.expectedDeliveryDate
          ? `Delivery By: ${new Date(po.expectedDeliveryDate).toLocaleDateString('en-IN')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      // Prefer the original PDF; fall back to the XLS if no PDF was captured.
      const mediaUrls: string[] = [];
      const mediaKey = po.rawFileKey || po.rawXlsFileKey;
      if (mediaKey) {
        const signed = await this.storageService.getSignedUrl(
          mediaKey,
          24 * 60 * 60,
        );
        if (signed) mediaUrls.push(signed);
      }

      const templateSummary = [
        po.poNumber,
        `${itemCount} item(s)`,
        totalStr,
        po.shippingLocation,
      ]
        .filter(Boolean)
        .join(', ');

      await Promise.all(
        contacts.map((c) =>
          this.whatsappService
            .sendBusinessNotification(c.phone, message, {
              templatePurpose: 'new_po',
              templateSummary,
              mediaUrls,
            })
            .then((r) => {
              if (r.mode === 'skipped' && r.error) {
                this.logger.warn(
                  `WhatsApp notify failed for ${c.phone}: ${r.error}`,
                );
              }
            })
            .catch((err) => {
              this.logger.warn(
                `WhatsApp notify failed for ${c.phone}: ${err?.message}`,
              );
            }),
        ),
      );
    } catch (err) {
      this.logger.warn(
        `WhatsApp PO notification error: ${(err as Error)?.message}`,
      );
    }
  }

  async updateStatus(id: string, status: PoStatus): Promise<PurchaseOrder> {
    const po = await this.findById(id);
    po.status = status;
    return this.poRepo.save(po);
  }

  /** Resolve PO line → master SKU (exact code/name, then brand + pack-size rules). */
  private resolveSkuForItem(item: {
    skuCode?: string | null;
    skuName?: string | null;
  }): Promise<Sku | null> {
    return this.skuResolutionService.resolve(item);
  }

  /**
   * Recompute whether a PO has any unmapped line items and slot it into the
   * correct status:
   *  - At least one line item has no `skuId` AND the PO has not yet moved
   *    past validation → status flips to NEEDS_SKU_MAPPING.
   *  - Every line item is now mapped AND the PO was sitting in
   *    NEEDS_SKU_MAPPING → status flips back to EXTRACTED so the rest of
   *    the pipeline can pick it up.
   * Returns true when all line items are mapped.
   */
  private async refreshPoSkuMappingStatus(poId: string): Promise<boolean> {
    const po = await this.poRepo.findOne({ where: { id: poId } });
    if (!po) return false;

    const totalCount = await this.lineItemRepo.count({
      where: { purchaseOrderId: poId },
    });
    if (totalCount === 0) {
      // No line items at all — nothing to map; leave status untouched.
      return false;
    }

    const unmappedCount = await this.lineItemRepo.count({
      where: { purchaseOrderId: poId, skuId: IsNull() },
    });
    const allMapped = unmappedCount === 0;

    // Statuses that mean we are still in the early "raw PO" phase — these
    // are the only ones we are allowed to flip in response to mapping
    // changes. Once the PO has been validated/consolidated/dispatched we
    // leave the status alone (manual remapping is still possible but it
    // doesn't reopen the flow).
    const preValidationStatuses: PoStatus[] = [
      PoStatus.RECEIVED,
      PoStatus.PROCESSING,
      PoStatus.EXTRACTED,
      PoStatus.NEEDS_SKU_MAPPING,
    ];

    if (!preValidationStatuses.includes(po.status)) {
      return allMapped;
    }

    const targetStatus = allMapped
      ? PoStatus.EXTRACTED
      : PoStatus.NEEDS_SKU_MAPPING;
    if (po.status !== targetStatus) {
      po.status = targetStatus;
      await this.poRepo.save(po);
    }
    return allMapped;
  }

  /**
   * Map a single PO line item to an SKU (admin/manager action from the PO
   * drawer). When this completes mapping for every line item on the PO, the
   * PO is auto-promoted to EXTRACTED and re-validated against pricing rules.
   */
  async mapLineItemSku(
    poId: string,
    lineItemId: string,
    skuId: string,
  ): Promise<PurchaseOrder> {
    const lineItem = await this.lineItemRepo.findOne({
      where: { id: lineItemId, purchaseOrderId: poId },
    });
    if (!lineItem) {
      throw new NotFoundException(
        `Line item ${lineItemId} not found on PO ${poId}`,
      );
    }
    const sku = await this.skuRepo.findOne({ where: { id: skuId } });
    if (!sku) {
      throw new NotFoundException(`SKU ${skuId} not found`);
    }

    lineItem.skuId = sku.id;
    await this.lineItemRepo.save(lineItem);

    const allMapped = await this.refreshPoSkuMappingStatus(poId);
    if (allMapped) {
      try {
        await this.validationService.validatePo(poId);
      } catch (err) {
        this.logger.error(
          `Auto-validation failed after manual SKU mapping on PO ${poId}: ${(err as Error)?.message}`,
        );
      }
    }
    return this.findById(poId);
  }

  /**
   * Re-attempt SKU resolution for every unmapped line item on a PO using the
   * current SKU catalogue. Useful after admins add a missing SKU and want to
   * unblock POs that were waiting on it.
   */
  async rematchSkus(
    poId: string,
  ): Promise<{ matched: number; stillUnmapped: number; status: PoStatus }> {
    const unmapped = await this.lineItemRepo.find({
      where: { purchaseOrderId: poId, skuId: IsNull() },
    });
    let matched = 0;
    for (const li of unmapped) {
      const sku = await this.resolveSkuForItem({
        skuCode: li.itemCode,
        skuName: li.itemName,
      });
      if (sku) {
        li.skuId = sku.id;
        await this.lineItemRepo.save(li);
        matched++;
      }
    }
    const allMapped = await this.refreshPoSkuMappingStatus(poId);
    if (allMapped) {
      try {
        await this.validationService.validatePo(poId);
      } catch (err) {
        this.logger.error(
          `Auto-validation failed after PO rematch for ${poId}: ${(err as Error)?.message}`,
        );
      }
    }
    const fresh = await this.poRepo.findOne({ where: { id: poId } });
    return {
      matched,
      stillUnmapped: unmapped.length - matched,
      status: fresh?.status ?? PoStatus.NEEDS_SKU_MAPPING,
    };
  }

  /**
   * Re-run SKU resolution on every unmapped line item in the database.
   * Use after deploying smarter matching or adding SKUs so existing PO rows
   * show catalogue codes in the UI and reports.
   */
  async rematchAllUnmappedSkus(): Promise<{
    lineItemsScanned: number;
    matched: number;
    stillUnmapped: number;
    posTouched: number;
  }> {
    const unmapped = await this.lineItemRepo.find({
      where: { skuId: IsNull() },
      order: { createdAt: 'ASC' },
    });
    const poIds = new Set<string>();
    let matched = 0;

    for (const li of unmapped) {
      const sku = await this.resolveSkuForItem({
        skuCode: li.itemCode,
        skuName: li.itemName,
      });
      if (sku) {
        li.skuId = sku.id;
        await this.lineItemRepo.save(li);
        matched++;
        poIds.add(li.purchaseOrderId);
      }
    }

    for (const poId of poIds) {
      await this.refreshPoSkuMappingStatus(poId);
    }

    this.logger.log(
      `Bulk SKU rematch: ${matched}/${unmapped.length} line items mapped across ${poIds.size} PO(s).`,
    );

    return {
      lineItemsScanned: unmapped.length,
      matched,
      stillUnmapped: unmapped.length - matched,
      posTouched: poIds.size,
    };
  }

  /**
   * Aggregate every distinct vendor item code that the system has seen on a
   * PO line item but has not been able to map to an SKU. Used by the admin
   * UI to build the "missing SKU" worklist.
   */
  async listUnmappedItemCodes(): Promise<
    Array<{
      itemCode: string;
      itemName: string | null;
      occurrences: number;
      lastSeenAt: Date | null;
      sampleVendorNames: string[];
    }>
  > {
    interface UnmappedRow {
      itemCode: string | null;
      itemName: string | null;
      occurrences: number | string;
      lastSeenAt: string | Date | null;
      vendorNames: string[] | null;
    }

    const rows = (await this.lineItemRepo
      .createQueryBuilder('li')
      .select('li.item_code', 'itemCode')
      .addSelect('MAX(li.item_name)', 'itemName')
      .addSelect('COUNT(*)::int', 'occurrences')
      .addSelect('MAX(po.created_at)', 'lastSeenAt')
      .addSelect(
        `ARRAY_AGG(DISTINCT v.name) FILTER (WHERE v.name IS NOT NULL)`,
        'vendorNames',
      )
      .innerJoin('purchase_orders', 'po', 'po.id = li.purchase_order_id')
      .leftJoin('vendors', 'v', 'v.id = po.vendor_id')
      .where('li.sku_id IS NULL')
      .groupBy('li.item_code')
      .orderBy('"occurrences"', 'DESC')
      .getRawMany()) as UnmappedRow[];

    return rows.map((r) => ({
      itemCode: r.itemCode ?? '',
      itemName: r.itemName ?? null,
      occurrences: Number(r.occurrences) || 0,
      lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt) : null,
      sampleVendorNames: Array.isArray(r.vendorNames) ? r.vendorNames.slice(0, 5) : [],
    }));
  }

  async removeById(
    id: string,
  ): Promise<{ success: true; message: string; id: string }> {
    const po = await this.poRepo.findOne({
      where: { id },
      relations: ['deliveries', 'grns'],
    });

    if (!po) {
      throw new NotFoundException(`PO with id ${id} not found`);
    }

    // Cascade delete: GRN line items → GRNs → delivery line items → deliveries → PO line items → PO
    const grnIds = (po.grns ?? []).map((g) => g.id);
    if (grnIds.length > 0) {
      await this.grnLineItemRepo.delete({ grnId: In(grnIds) });
      await this.grnRepo.delete({ purchaseOrderId: id });
    }

    const deliveryIds = (po.deliveries ?? []).map((d) => d.id);
    if (deliveryIds.length > 0) {
      await this.deliveryLineItemRepo.delete({ deliveryId: In(deliveryIds) });
      await this.deliveryRepo.delete({ purchaseOrderId: id });
    }

    await this.lineItemRepo.delete({ purchaseOrderId: id });
    await this.poRepo.delete({ id });

    return {
      success: true,
      message: 'PO deleted successfully',
      id,
    };
  }

  async flushTestingData(): Promise<{
    success: true;
    message: string;
    deleted: {
      deliveryLineItems: number;
      deliveries: number;
      grnLineItems: number;
      grns: number;
      poLineItems: number;
      purchaseOrders: number;
    };
  }> {
    const [
      deliveryLineItems,
      deliveries,
      grnLineItems,
      grns,
      poLineItems,
      purchaseOrders,
    ] = await Promise.all([
      this.deliveryLineItemRepo.count(),
      this.deliveryRepo.count(),
      this.grnLineItemRepo.count(),
      this.grnRepo.count(),
      this.lineItemRepo.count(),
      this.poRepo.count(),
    ]);

    await this.deliveryLineItemRepo.createQueryBuilder().delete().execute();

    await this.grnLineItemRepo.createQueryBuilder().delete().execute();

    await this.deliveryRepo.createQueryBuilder().delete().execute();

    await this.grnRepo.createQueryBuilder().delete().execute();

    await this.lineItemRepo.createQueryBuilder().delete().execute();

    await this.poRepo.createQueryBuilder().delete().execute();

    return {
      success: true,
      message: 'Flushed all PO-related testing data',
      deleted: {
        deliveryLineItems,
        deliveries,
        grnLineItems,
        grns,
        poLineItems,
        purchaseOrders,
      },
    };
  }
}
