import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JOB_NAMES, QUEUE_NAMES } from '../../common/constants/app.constants';
import {
  ImapService,
  IncomingEmail,
  EmailAttachment,
} from '../../email/imap.service';
import { StorageService } from '../../storage/storage.service';
import { WhatsappService } from '../../whatsapp/whatsapp.service';
import { PoService } from '../../modules/po/services/po.service';
import { PdfExtractionService } from '../../modules/po/services/pdf-extraction.service';
import { XlsExtractionService } from '../../modules/po/services/xls-extraction.service';
import { PdfExtractionResult } from '../../modules/po/services/pdf-extraction.service';
import { GrnService } from '../../modules/grn/services/grn.service';
import { isGrnInboundEmail, pickPrimaryGrnPdf } from '../../email/grn-email.util';
import { v4 as uuidv4 } from 'uuid';

/** Summary returned by inbox monitor jobs so controllers can surface progress. */
export interface MonitorInboxSummary {
  imapHits: number;
  emailsWithDocs: number;
  poCreated: number;
  grnCreated: number;
  skippedDuplicates: number;
  errors: string[];
  durationMs: number;
}

@Processor(QUEUE_NAMES.PO_PROCESSING, {
  // IMAP attachment downloads against Gmail throttle to ~3 s per FETCH even at
  // 8-way concurrency; a 200-mail SINCE 21d scan therefore runs ~60–90 min
  // wall-clock. We need a lock that survives the full parse window so BullMQ
  // doesn’t reclaim the job and the cron stays single-flight.
  lockDuration: 2 * 60 * 60_000,   // 2 hours
  lockRenewTime: 10 * 60_000,      // renew every 10 min
  stalledInterval: 2 * 60 * 60_000,
  maxStalledCount: 0,
})
export class PoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(PoProcessingProcessor.name);

  constructor(
    private readonly imapService: ImapService,
    private readonly storageService: StorageService,
    private readonly whatsappService: WhatsappService,
    private readonly poService: PoService,
    private readonly pdfExtractionService: PdfExtractionService,
    private readonly xlsExtractionService: XlsExtractionService,
    private readonly grnService: GrnService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log(`Processing job ${job.name} (${job.id})`);

    switch (job.name) {
      case JOB_NAMES.MONITOR_INBOX:
        return await this.monitorInboxFull();
      case JOB_NAMES.MONITOR_INBOX_PO:
        return await this.monitorInboxManual('po');
      case JOB_NAMES.MONITOR_INBOX_GRN:
        return await this.monitorInboxManual('grn');
      case 'reprocess-all':
        await this.reprocessAll();
        return;
      case 'process-po-email':
        await this.processPoEmail(job.data);
        return;
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
        return;
    }
  }

  /**
   * Reprocess ALL emails in inbox (including already-read ones)
   */
  private async reprocessAll(): Promise<void> {
    this.logger.log('Reprocessing ALL emails in inbox...');
    try {
      const { emails } = await this.imapService.fetchAllEmails();
      this.logger.log(`Found ${emails.length} emails to reprocess`);

      for (const email of emails) {
        try {
          await this.processEmail(email);
        } catch (error) {
          this.logger.error(
            `Failed to process email ${email.messageId}: ${error}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Reprocess all failed: ${error}`);
      throw error;
    }
  }

  private async monitorInboxFull(): Promise<MonitorInboxSummary> {
    this.logger.log('Monitoring inbox for new PO/GRN emails (full scan, 21 days)...');
    return this.runInboxMonitor('full', 21);
  }

  /**
   * Manual button: scan the entire INBOX (read or unread) so any PO/GRN that
   * exists in the mailbox but isn't in the system lands in the DB. The
   * per-message-ID dedup in PoService / GrnService keeps reruns cheap — only
   * brand-new mail does extraction + S3 upload + insert.
   */
  private async monitorInboxManual(
    mode: 'po' | 'grn',
  ): Promise<MonitorInboxSummary> {
    const label = mode === 'po' ? 'PO (manual)' : 'GRN (manual)';
    this.logger.log(
      `${label}: scanning ALL inbox mail (GRN-like ${
        mode === 'po' ? 'skipped' : 'only'
      }); already-imported messages are deduped via Message-ID`,
    );
    return this.runInboxMonitor(mode);
  }

  private async runInboxMonitor(
    mode: 'full' | 'po' | 'grn',
    sinceDays?: number,
  ): Promise<MonitorInboxSummary> {
    const startedAt = Date.now();
    const summary: MonitorInboxSummary = {
      imapHits: 0,
      emailsWithDocs: 0,
      poCreated: 0,
      grnCreated: 0,
      skippedDuplicates: 0,
      errors: [],
      durationMs: 0,
    };

    try {
      // Manual buttons → full inbox (sinceDays undefined). Cron → merged UNSEEN + SINCE window.
      const fetched =
        sinceDays === undefined
          ? await this.imapService.fetchAllEmails()
          : await this.imapService.fetchUnreadPlusRecentMerged(sinceDays);
      summary.imapHits = fetched.imapMatchCount;
      const candidates = fetched.emails.filter((email) => {
        const grnLike = isGrnInboundEmail(email.subject, email.attachments);
        if (mode === 'po' && grnLike) return false;
        if (mode === 'grn' && !grnLike) return false;
        return true;
      });
      summary.emailsWithDocs = candidates.length;
      this.logger.log(
        `Inbox scan (${mode}, ${
          sinceDays === undefined ? 'ALL' : `${sinceDays}d`
        }): ${fetched.emails.length} doc-mails → ${candidates.length} to process`,
      );

      for (const email of candidates) {
        try {
          const outcome = await this.processEmail(email);
          if (outcome === 'po') summary.poCreated++;
          else if (outcome === 'grn') summary.grnCreated++;
          else if (outcome === 'duplicate') summary.skippedDuplicates++;
        } catch (error) {
          const msg = `Failed to process email ${email.messageId}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          this.logger.error(msg);
          summary.errors.push(msg);
        }
      }
    } catch (error) {
      this.logger.error(`IMAP inbox monitoring failed: ${error}`);
      throw error;
    }

    summary.durationMs = Date.now() - startedAt;
    this.logger.log(
      `Inbox monitor (${mode}) done in ${summary.durationMs}ms: +${summary.poCreated} PO, +${summary.grnCreated} GRN, ${summary.skippedDuplicates} dup, ${summary.errors.length} errors`,
    );
    return summary;
  }

  /** Returns the kind of record that was created (or null if nothing was created). */
  private async processEmail(
    email: IncomingEmail,
  ): Promise<'po' | 'grn' | 'duplicate' | null> {
    // GRN emails: subject/filename signals, PO number comes from the PDF
    if (isGrnInboundEmail(email.subject, email.attachments)) {
      const grnPdf = pickPrimaryGrnPdf(email.subject, email.attachments);
      if (!grnPdf) {
        this.logger.warn(`GRN-like email has no PDF attachment: ${email.subject}`);
        return null;
      }
      if (email.messageId) {
        const existing = await this.grnService.findByEmailMessageId(email.messageId);
        if (existing) {
          this.logger.log(`Skipping duplicate GRN email: ${email.messageId}`);
          return 'duplicate';
        }
      }
      const batchId = uuidv4();
      const grnKey = `grn-files/${batchId}/${grnPdf.filename}`;
      await this.storageService.uploadFile(grnKey, grnPdf.content, grnPdf.contentType);
      try {
        const grn = await this.grnService.createFromEmailPdf({
          emailMessageId: email.messageId,
          rawFileKey: grnKey,
          pdfBuffer: grnPdf.content,
        });
        if (grn) {
          this.logger.log(`Created GRN ${grn.grnNumber} from email "${email.subject}"`);
          try {
            const grnUrl = await this.storageService.getSignedUrl(grnKey, 24 * 60 * 60);
            await this.whatsappService.sendGroupAlert(
              `📋 *GRN from email*\nGRN#: ${grn.grnNumber}\nFile: ${grnPdf.filename}\nReceived: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
              { mediaUrls: grnUrl ? [grnUrl] : [] },
            );
          } catch (waErr) {
            this.logger.warn(`WhatsApp notification failed (non-fatal): ${waErr}`);
          }
          return 'grn';
        }
      } catch (err) {
        this.logger.error(
          `GRN email processing failed (${email.subject}): ${err instanceof Error ? err.message : err}`,
        );
        throw err;
      }
      return null;
    }

    // Skip if we've already processed this email as a PO
    if (
      email.messageId &&
      (await this.poService.isDuplicateEmail(email.messageId))
    ) {
      this.logger.log(`Skipping duplicate email: ${email.messageId}`);
      return 'duplicate';
    }

    // Extract PO number from email subject/body or filename
    const poNumber = this.extractPoNumber(email);
    if (!poNumber) {
      this.logger.warn(
        `Could not extract PO number from email: ${email.subject}`,
      );
      return null;
    }

    // Separate attachments by type
    const pdfAttachment = email.attachments.find(
      (a) =>
        a.contentType === 'application/pdf' ||
        a.filename.toLowerCase().endsWith('.pdf'),
    );
    const xlsAttachment = email.attachments.find(
      (a) =>
        a.filename.toLowerCase().endsWith('.xls') ||
        a.filename.toLowerCase().endsWith('.xlsx') ||
        a.filename.toLowerCase().endsWith('.csv') ||
        a.contentType.includes('spreadsheet') ||
        a.contentType.includes('excel') ||
        a.contentType.includes('csv'),
    );

    // Upload attachments to S3
    const batchId = uuidv4();
    let pdfFileKey: string | undefined;
    let xlsFileKey: string | undefined;

    if (pdfAttachment) {
      pdfFileKey = `po-files/${batchId}/${pdfAttachment.filename}`;
      await this.storageService.uploadFile(
        pdfFileKey,
        pdfAttachment.content,
        pdfAttachment.contentType,
      );
    }

    if (xlsAttachment) {
      xlsFileKey = `po-files/${batchId}/${xlsAttachment.filename}`;
      await this.storageService.uploadFile(
        xlsFileKey,
        xlsAttachment.content,
        xlsAttachment.contentType,
      );
    }

    // Extract data — prefer XLS for line items, but also extract PDF for metadata
    let extracted: PdfExtractionResult;
    try {
      if (xlsAttachment) {
        this.logger.log(`Extracting PO data from XLS: ${xlsAttachment.filename}`);
        extracted = this.xlsExtractionService.extract(xlsAttachment.content, xlsAttachment.filename);

        // Also extract from PDF to get metadata (vendor, dates, addresses) that XLS may lack
        if (pdfAttachment) {
          try {
            this.logger.log(`Also extracting metadata from PDF: ${pdfAttachment.filename}`);
            const pdfExtracted = await this.pdfExtractionService.extract(pdfAttachment.content);
            extracted = this.mergeExtractions(extracted, pdfExtracted);
          } catch (pdfErr) {
            this.logger.warn(`PDF metadata extraction failed (non-fatal): ${pdfErr}`);
          }
        }
      } else if (pdfAttachment) {
        this.logger.log(`Extracting PO data from PDF: ${pdfAttachment.filename}`);
        extracted = await this.pdfExtractionService.extract(pdfAttachment.content);
      } else {
        this.logger.warn('No usable attachment found');
        return null;
      }
    } catch (extractionError) {
      this.logger.error(`Extraction failed: ${extractionError}`);
      // If XLS failed, try PDF as fallback
      if (xlsAttachment && pdfAttachment) {
        this.logger.log('XLS extraction failed, falling back to PDF...');
        extracted = await this.pdfExtractionService.extract(pdfAttachment.content);
      } else {
        throw extractionError;
      }
    }

    // Fill vendor name from email subject if not found in the file
    if (!extracted.vendorName) {
      extracted.vendorName = this.extractVendorFromSubject(email.subject, email.from);
    }

    // Also extract vendor code from filename pattern: CRPL-{VendorCode}-{PONumber}
    const vendorCode = this.extractVendorCodeFromFilename(
      pdfAttachment?.filename || xlsAttachment?.filename || '',
    );

    // Parse dates safely
    const parseDate = (dateStr?: string): Date | undefined => {
      if (!dateStr) return undefined;

      const raw = String(dateStr).trim();
      if (!raw || /^0+$/.test(raw)) return undefined;

      if (/^\d{10,13}$/.test(raw)) {
        const n = Number(raw);
        const ms = raw.length === 10 ? n * 1000 : n;
        const tsDate = new Date(ms);
        if (!isNaN(tsDate.getTime()) && tsDate.getUTCFullYear() >= 2000) {
          return tsDate;
        }
        return undefined;
      }

      const dmy = raw.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
      if (dmy) {
        const [, d, m, y] = dmy;
        const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        const parsed = new Date(iso);
        if (!isNaN(parsed.getTime()) && parsed.getUTCFullYear() >= 2000) {
          return parsed;
        }
        return undefined;
      }

      const normalized = raw.replace(/\b([ap])\.?m\.?\b/gi, '$1m');
      const parsed = new Date(normalized);
      if (isNaN(parsed.getTime()) || parsed.getUTCFullYear() < 2000) return undefined;
      return parsed;
    };

    // Create PO record with line items
    await this.poService.createFromEmail({
      poNumber: extracted.poNumber || poNumber,
      poDate: parseDate(extracted.poDate) || email.date,
      vendorName: extracted.vendorName,
      shippingLocation: extracted.shippingLocation || '',
      rawFileKey: pdfFileKey,
      rawXlsFileKey: xlsFileKey,
      emailMessageId: email.messageId,
      expectedDeliveryDate: parseDate(extracted.expectedDeliveryDate),
      expiryDate: parseDate(extracted.expiryDate),
      paymentTerms: extracted.paymentTerms,
      totalAmount: extracted.grandTotal,
      lineItems: extracted.lineItems,
      extractedData: {
        ...extracted,
        vendorCode,
        emailFrom: email.from,
        emailSubject: email.subject,
        emailDate: email.date.toISOString(),
      } as unknown as Record<string, unknown>,
    });

    const finalPoNumber = extracted.poNumber || poNumber;
    this.logger.log(
      `Created PO ${finalPoNumber} with ${extracted.lineItems.length} line items from email`,
    );

    // Notify via WhatsApp — attach the original PO PDF (preferred) or XLS so
    // receivers can open the source document from the chat directly.
    try {
      const vendorDisplay = extracted.vendorName || 'Unknown vendor';
      const itemCount = extracted.lineItems.length;
      const location = extracted.shippingLocation || 'unknown location';
      const mediaKey = pdfFileKey || xlsFileKey;
      const mediaUrl = mediaKey
        ? await this.storageService.getSignedUrl(mediaKey, 24 * 60 * 60)
        : null;
      await this.whatsappService.sendGroupAlert(
        `📦 *New PO Received*\nPO#: ${finalPoNumber}\nVendor: ${vendorDisplay}\nItems: ${itemCount}\nShip to: ${location}\nReceived: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
        { mediaUrls: mediaUrl ? [mediaUrl] : [] },
      );
    } catch (waErr) {
      this.logger.warn(`WhatsApp notification failed (non-fatal): ${waErr}`);
    }

    return 'po';
  }

  /**
   * Extract PO number from email subject, body, or attachment filename
   * Supports: CMPPO81293, CFFPO76844, CPCAP27-PO-3217821, P4069272, 49336910000615
   */
  private extractPoNumber(email: IncomingEmail): string | null {
    const subject = email.subject;

    // Pattern 1: Cloudstore PO — CMPPO81293, CFFPO76844
    const cloudstoreMatch = subject.match(/(C[A-Z]*PO\d+)/i);
    if (cloudstoreMatch) return cloudstoreMatch[1];

    // Pattern 2: Hyperpure PO — CPCAP27-PO-3217821
    const hyperpureMatch = subject.match(/PO\s*(?:Number|No\.?)\s*([A-Z0-9]+-PO-\d+)/i);
    if (hyperpureMatch) return hyperpureMatch[1];

    // Pattern 3: Zepto/BigBasket — P4069272
    const zeptoMatch = subject.match(/\b(P\d{6,})\b/);
    if (zeptoMatch) return zeptoMatch[1];

    // Pattern 4: MOONSTONE/Swiggy — long numeric code in subject like 49336910000615
    const moonstoneMatch = subject.match(/(\d{10,})/);
    if (moonstoneMatch) return moonstoneMatch[1];

    // Try email body
    const bodyMatch = email.body.match(
      /Purchase\s*order\s*(?:No\.?|Number)?\s*[:\s]*(\S+)/i,
    );
    if (bodyMatch) return bodyMatch[1];

    // Try attachment filenames
    for (const att of email.attachments) {
      // CVPL-1N60003666-CFFPO76844.pdf
      const fileMatch = att.filename.match(/([A-Z]*PO\d+)/i);
      if (fileMatch) return fileMatch[1];
      // purchase_order-3217821.pdf
      const numMatch = att.filename.match(/(?:purchase_order|po)[_-](\d+)/i);
      if (numMatch) return numMatch[1];
      // 49336910000615_20260411_045623.pdf
      const longNumMatch = att.filename.match(/(\d{10,})/);
      if (longNumMatch) return longNumMatch[1];
    }

    return null;
  }

  /**
   * Extract vendor code from attachment filename
   * Pattern: CRPL-{VendorCode}-{PONumber}.ext
   */
  private extractVendorCodeFromFilename(
    filename: string,
  ): string | undefined {
    const match = filename.match(/^[A-Z]+-(\w+)-\w+\./i);
    return match ? match[1] : undefined;
  }

  /**
   * Extract vendor name from email subject/sender when the file doesn't contain it
   * E.g., "DECCAN AGRO FARM PRIVATE LIMITED - Hyperpure PO Number CPCMH27-PO-3217961"
   * E.g., "Purchase Order P4069272 | GOOD ORIGINS FOOD PRIVATE LIMITED | ..." (Zepto — vendor is sender)
   * E.g., "MOONSTONE - 49336910000615_20260411_045623" (sender = Swiggy/MOONSTONE)
   */
  private extractVendorFromSubject(subject: string, from: string): string {
    // Hyperpure: "ZOMATO HYPERPURE PVT LTD - Hyperpure PO Number CPCTG27-PO-…"
    // Use the supplier segment before " - Hyperpure", not the platform name.
    const hyperpureMatch = subject.match(/^(.+?)\s*-\s*Hyperpure\s+PO/i);
    if (hyperpureMatch) {
      const fromSubject = hyperpureMatch[1].trim();
      if (fromSubject.length > 0) return fromSubject;
    }

    // Zepto: "Purchase Order P#### | VENDOR NAME | ..."
    if (/Purchase\s*Order\s*P\d+/i.test(subject)) return 'Zepto';

    // Swiggy/MOONSTONE
    if (/MOONSTONE/i.test(subject) || /swiggy/i.test(from)) return 'Swiggy';

    // Cloudstore
    if (/cloudstore/i.test(subject) || /cloudstore/i.test(from)) return 'Cloudstore';

    // Fallback: use sender's name portion
    const nameMatch = from.match(/^"?([^"<]+)/);
    return nameMatch ? nameMatch[1].trim() : from;
  }

  /**
   * Merge XLS extraction (good line items) with PDF extraction (good metadata).
   * XLS values take priority for line items; PDF fills in missing metadata.
   */
  private mergeExtractions(
    xlsData: PdfExtractionResult,
    pdfData: PdfExtractionResult,
  ): PdfExtractionResult {
    const xlsVendor = xlsData.vendorName?.trim();
    const pdfVendor = pdfData.vendorName?.trim();
    // XLS often labels the buyer as "Hyperpure" while the PDF has the legal entity name.
    const xlsVendorIsImprecise =
      !xlsVendor ||
      /^hyperpure$/i.test(xlsVendor) ||
      /^(buyer|customer|vendor)$/i.test(xlsVendor);
    const vendorName = xlsVendorIsImprecise
      ? pdfVendor || xlsVendor || ''
      : xlsVendor || pdfVendor || '';

    return {
      vendorName,
      vendorCode: xlsData.vendorCode || pdfData.vendorCode,
      vendorGstin: xlsData.vendorGstin || pdfData.vendorGstin,
      vendorAddress: xlsData.vendorAddress || pdfData.vendorAddress,
      poNumber: xlsData.poNumber || pdfData.poNumber,
      poDate: xlsData.poDate || pdfData.poDate,
      expectedDeliveryDate: xlsData.expectedDeliveryDate || pdfData.expectedDeliveryDate,
      expiryDate: xlsData.expiryDate || pdfData.expiryDate,
      paymentTerms: xlsData.paymentTerms || pdfData.paymentTerms,
      shippingLocation: xlsData.shippingLocation || pdfData.shippingLocation,
      billingAddress: xlsData.billingAddress || pdfData.billingAddress,
      shippingAddress: xlsData.shippingAddress || pdfData.shippingAddress,
      // Prefer XLS line items (structured), fall back to PDF
      lineItems: xlsData.lineItems.length > 0 ? xlsData.lineItems : pdfData.lineItems,
      grandTotal: xlsData.grandTotal || pdfData.grandTotal,
      totalTax: xlsData.totalTax || pdfData.totalTax,
    };
  }

  private async processPoEmail(data: {
    emailMessageId: string;
    fileKey: string;
    fileType?: string;
  }): Promise<void> {
    const fileBuffer = await this.storageService.getFile(data.fileKey);

    let extracted: PdfExtractionResult;
    if (data.fileType === 'xls' || data.fileKey.endsWith('.xls') || data.fileKey.endsWith('.xlsx') || data.fileKey.endsWith('.csv')) {
      extracted = this.xlsExtractionService.extract(fileBuffer, data.fileKey);
    } else {
      extracted = await this.pdfExtractionService.extract(fileBuffer);
    }

    await this.poService.createFromEmail({
      poNumber: extracted.poNumber,
      poDate: new Date(extracted.poDate),
      vendorName: extracted.vendorName,
      shippingLocation: extracted.shippingLocation,
      rawFileKey: data.fileKey,
      emailMessageId: data.emailMessageId,
      totalAmount: extracted.grandTotal,
      lineItems: extracted.lineItems,
      extractedData: extracted as unknown as Record<string, unknown>,
    });
  }
}
