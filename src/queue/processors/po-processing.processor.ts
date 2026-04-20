import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../../common/constants/app.constants';
import {
  ImapService,
  IncomingEmail,
  EmailAttachment,
} from '../../email/imap.service';
import { StorageService } from '../../storage/storage.service';
import { PoService } from '../../modules/po/services/po.service';
import { PdfExtractionService } from '../../modules/po/services/pdf-extraction.service';
import { XlsExtractionService } from '../../modules/po/services/xls-extraction.service';
import { PdfExtractionResult } from '../../modules/po/services/pdf-extraction.service';
import { v4 as uuidv4 } from 'uuid';

@Processor(QUEUE_NAMES.PO_PROCESSING)
export class PoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(PoProcessingProcessor.name);

  constructor(
    private readonly imapService: ImapService,
    private readonly storageService: StorageService,
    private readonly poService: PoService,
    private readonly pdfExtractionService: PdfExtractionService,
    private readonly xlsExtractionService: XlsExtractionService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing job ${job.name} (${job.id})`);

    switch (job.name) {
      case 'monitor-inbox':
        await this.monitorInbox();
        break;
      case 'reprocess-all':
        await this.reprocessAll();
        break;
      case 'process-po-email':
        await this.processPoEmail(job.data);
        break;
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }

  /**
   * Reprocess ALL emails in inbox (including already-read ones)
   */
  private async reprocessAll(): Promise<void> {
    this.logger.log('Reprocessing ALL emails in inbox...');
    try {
      const emails = await this.imapService.fetchAllEmails();
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

  /**
   * Monitor IMAP inbox for new PO emails
   * Downloads PDF/XLS attachments, uploads to S3, extracts data, and creates PO records
   */
  private async monitorInbox(): Promise<void> {
    this.logger.log('Monitoring inbox for new PO emails...');
    try {
      const emails = await this.imapService.fetchUnreadEmails();

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
      this.logger.error(`IMAP inbox monitoring failed: ${error}`);
      throw error;
    }
  }

  private async processEmail(email: IncomingEmail): Promise<void> {
    // Skip if we've already processed this email
    if (
      email.messageId &&
      (await this.poService.isDuplicateEmail(email.messageId))
    ) {
      this.logger.log(`Skipping duplicate email: ${email.messageId}`);
      return;
    }

    // Extract PO number from email subject/body or filename
    const poNumber = this.extractPoNumber(email);
    if (!poNumber) {
      this.logger.warn(
        `Could not extract PO number from email: ${email.subject}`,
      );
      return;
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
        return;
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
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? undefined : d;
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

    this.logger.log(
      `Created PO ${extracted.poNumber || poNumber} with ${extracted.lineItems.length} line items from email`,
    );
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
    // Hyperpure: "VENDOR NAME - Hyperpure PO Number ..."
    const hyperpureMatch = subject.match(/^(.+?)\s*-\s*Hyperpure\s+PO/i);
    if (hyperpureMatch) return 'Hyperpure';

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
    return {
      vendorName: xlsData.vendorName || pdfData.vendorName,
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
