import { Injectable, Logger } from '@nestjs/common';
import { AiPoExtractionService, AiPoExtractionResult } from './ai-po-extraction.service';
import { OWN_COMPANY_PATTERNS } from './own-company';

/** Extracted line item from a PO PDF/XLS */
export interface ExtractedLineItem {
  skuCode: string;
  skuName: string;
  hsnCode?: string;
  quantity: number;
  price: number;
  mrp?: number;
  taxableValue?: number;
  cgstRate?: number;
  cgstAmount?: number;
  sgstRate?: number;
  sgstAmount?: number;
  igstRate?: number;
  igstAmount?: number;
  total?: number;
}

/** Result of PDF/XLS extraction */
export interface PdfExtractionResult {
  vendorName: string;
  vendorCode?: string;
  vendorGstin?: string;
  vendorAddress?: string;
  poNumber: string;
  poDate: string;
  expectedDeliveryDate?: string;
  expiryDate?: string;
  paymentTerms?: string;
  shippingLocation: string;
  billingAddress?: string;
  shippingAddress?: string;
  lineItems: ExtractedLineItem[];
  grandTotal?: number;
  totalTax?: number;
  rawText?: string;
  confidence?: number;
  extractionMethod?: 'rule' | 'hybrid' | 'ai';
}

/**
 * PDF Extraction Service
 * Parses Cloudstore Retail PO PDFs using pdf-parse v2 (PDFParse class)
 */
@Injectable()
export class PdfExtractionService {
  private readonly logger = new Logger(PdfExtractionService.name);
  private readonly ownCompanyPatterns = OWN_COMPANY_PATTERNS;

  constructor(
    private readonly aiPoExtractionService: AiPoExtractionService,
  ) {}

  async extract(pdfBuffer: Buffer): Promise<PdfExtractionResult> {
    this.logger.log('Starting PDF extraction...');

    // Dynamic require to avoid ESM/CJS issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PDFParse } = require('pdf-parse');
    const uint8 = new Uint8Array(pdfBuffer);
    const parser = new PDFParse(uint8);
    await parser.load();

    const textResult = await parser.getText();
    const text = textResult.pages
      .map((p: { text: string }) => p.text)
      .join('\n');

    parser.destroy();

    const format = this.detectFormat(text);
    this.logger.log(`Detected PDF format: ${format}`);

    let result: PdfExtractionResult;
    if (format === 'hyperpure') {
      result = this.parseHyperpurePo(text);
    } else if (format === 'vendor_billing') {
      result = this.parseVendorBillingPo(text);
    } else if (format === 'moonstone') {
      result = this.parseMoonstonePo(text);
    } else {
      result = this.parseCloudstorePo(text);
    }
    result.rawText = text;

    result.confidence = this.computeConfidence(result);
    result.extractionMethod = 'rule';

    // Hybrid fallback: if rule-based confidence is weak, try free-tier Gemini extraction.
    if (this.shouldUseAiFallback(result)) {
      this.logger.warn(
        `Low extraction confidence (${result.confidence?.toFixed(2)}) for PO ${result.poNumber || '[unknown]'}, trying AI fallback`,
      );
      const aiResult = await this.aiPoExtractionService.extractFromText(text);
      if (aiResult) {
        result = this.mergeWithAiResult(result, aiResult);
      }
    }

    if (this.isGarbageVendorLabel(result.vendorName)) {
      this.logger.warn(
        `Discarding garbage vendor name after extraction: ${JSON.stringify(result.vendorName)}`,
      );
      result.vendorName = '';
      result.confidence = this.computeConfidence(result);
    }

    this.logger.log(
      `Extracted PO ${result.poNumber} with ${result.lineItems.length} line items (confidence=${result.confidence?.toFixed(2)}, method=${result.extractionMethod})`,
    );
    return result;
  }

  private shouldUseAiFallback(result: PdfExtractionResult): boolean {
    if (!this.aiPoExtractionService.isEnabled()) return false;
    if (!result.poNumber || !result.poDate || !result.vendorName) return true;
    if (this.isGarbageVendorLabel(result.vendorName)) return true;
    if (!result.shippingLocation) return true;
    if (!result.lineItems || result.lineItems.length === 0) return true;
    return (result.confidence || 0) < 0.72;
  }

  private computeConfidence(result: PdfExtractionResult): number {
    let score = 0;
    if (result.poNumber) score += 0.25;
    if (result.poDate) score += 0.15;
    if (
      result.vendorName &&
      !this.isGarbageVendorLabel(result.vendorName)
    ) {
      score += 0.15;
    }
    if (result.shippingLocation) score += 0.10;
    if (result.lineItems?.length) {
      score += result.lineItems.length >= 2 ? 0.25 : 0.15;
    }
    if (typeof result.grandTotal === 'number' && result.grandTotal > 0) score += 0.10;
    return Math.min(1, score);
  }

  private mergeWithAiResult(
    ruleResult: PdfExtractionResult,
    aiResult: AiPoExtractionResult,
  ): PdfExtractionResult {
    const ruleCount = ruleResult.lineItems?.length ?? 0;
    const aiLines = aiResult.lineItems || [];
    const aiCount = aiLines.length;

    const useAiLineItems =
      aiCount > 0 &&
      (ruleCount === 0 ||
        aiCount > ruleCount ||
        (ruleCount > 0 &&
          (ruleResult.lineItems ?? []).every(
            (li) => (Number(li.price) || 0) === 0 && (Number(li.total) || 0) === 0,
          )));

    const mergedLineItems = useAiLineItems
      ? aiLines.map((li) => ({
          skuCode: li.skuCode,
          skuName: li.skuName,
          hsnCode: li.hsnCode,
          quantity: li.quantity,
          price: li.price,
          mrp: li.mrp,
          total: li.total,
        }))
      : ruleResult.lineItems?.length
        ? ruleResult.lineItems
        : aiLines.map((li) => ({
            skuCode: li.skuCode,
            skuName: li.skuName,
            hsnCode: li.hsnCode,
            quantity: li.quantity,
            price: li.price,
            mrp: li.mrp,
            total: li.total,
          }));

    const merged: PdfExtractionResult = {
      ...ruleResult,
      // Prefer a usable AI buyer name over a truthy but junk rule label (e.g. "PO No : …").
      vendorName:
        this.pickCounterpartyName(aiResult.vendorName, ruleResult.vendorName) ||
        '',
      vendorCode: ruleResult.vendorCode || aiResult.vendorCode,
      vendorGstin: ruleResult.vendorGstin || aiResult.vendorGstin,
      poNumber: ruleResult.poNumber || aiResult.poNumber || '',
      poDate: ruleResult.poDate || aiResult.poDate || '',
      expectedDeliveryDate: ruleResult.expectedDeliveryDate || aiResult.expectedDeliveryDate,
      expiryDate: ruleResult.expiryDate || aiResult.expiryDate,
      paymentTerms: ruleResult.paymentTerms || aiResult.paymentTerms,
      shippingLocation: ruleResult.shippingLocation || aiResult.shippingLocation || '',
      grandTotal: ruleResult.grandTotal ?? aiResult.grandTotal,
      lineItems: mergedLineItems,
      extractionMethod: 'hybrid',
    };

    merged.confidence = this.computeConfidence(merged);
    return merged;
  }

  private detectFormat(text: string): string {
    // Classic Hyperpure PO uses "Purchase Order Number" on its own line; PO SCHEDULE
    // PDFs use "Purchase Order No :" / "PO SCHEDULE" and delivery as "Scheduled Date".
    if (
      /hyperpure/i.test(text) &&
      (/Purchase Order Number/i.test(text) ||
        /Purchase Order No/i.test(text) ||
        /PO\s*SCHEDULE/i.test(text))
    ) {
      return 'hyperpure';
    }
    if (/P\.?O\.?\s*Number/i.test(text) && /Shipping\s*Spoc\s*Details/i.test(text)) {
      return 'moonstone';
    }
    // Format where left column = Vendor Details (our company) and right = PO Details,
    // and the counterparty (buyer) appears in the Billing Address section.
    if (/Vendor\s*Details/i.test(text) && /Billing\s*Address/i.test(text) && /PO\s*No/i.test(text)) {
      return 'vendor_billing';
    }
    return 'cloudstore';
  }

  private parseHyperpurePo(text: string): PdfExtractionResult {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    // In Hyperpure PDFs, labels and values are on separate lines:
    //   "Purchase Order Number"
    //   "CPCMH27-PO-3218173"
    const getNextLineValue = (label: RegExp): string => {
      for (let i = 0; i < lines.length; i++) {
        if (label.test(lines[i]) && i + 1 < lines.length) {
          return lines[i + 1].trim();
        }
      }
      return '';
    };

    const poNumber =
      getNextLineValue(/^Purchase Order Number$/i) ||
      getNextLineValue(/^Purchase Order No\s*:?$/i) ||
      this.extractField(lines, /Purchase Order No\s*:\s*(\S+)/i) ||
      '';

    // Label is often "Purchase Order Date :" on its own line; avoid extractField()
    // join fallback — greedy (.+) would swallow the rest of the document.
    const poDate =
      getNextLineValue(/^Purchase Order Date$/i) ||
      getNextLineValue(/^Purchase Order Date\s*:?$/i) ||
      this.extractField(
        lines,
        /Purchase Order Date\s*:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i,
      ) ||
      '';

    // Full PO: label "Expected Delivery Date" on one line, value on the next.
    // PO SCHEDULE: uses "Scheduled Date" (same semantics as delivery) — inline or next line.
    const scheduledDate =
      getNextLineValue(/^Scheduled Date\s*:?$/i) ||
      this.extractField(
        lines,
        /Scheduled Date\s*:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i,
      );

    const expectedDeliveryDate =
      getNextLineValue(/^Expected Delivery Date$/i) ||
      scheduledDate ||
      this.extractField(lines, /Expected\s*Delivery\s*Date\s*:\s*(.+)/i);

    // Customer = "Bill To" company — label and value are on separate lines:
    // Line N:   "Bill To :       Shipped To :"
    // Line N+1: "Zomato Hyperpure Pvt Ltd (CPC-MUM5)     Zomato Hyperpure Pvt Ltd ..."
    let vendorName = '';
    /** Hub / DC code from Bill To line, e.g. "(HYD3)" — PO SCHEDULE uses "Ship To" not "Shipped To". */
    let billToHubCode = '';
    for (let i = 0; i < lines.length; i++) {
      if (/Bill\s*To\s*:/i.test(lines[i])) {
        // Next non-empty line has the company name; take the left-column part (before tab)
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const raw = lines[j].split('\t')[0].trim();
          const hub = raw.match(/\(([A-Z]+-[A-Z0-9]+|[A-Z]{2,}\d+[A-Z]?)\)/i);
          if (hub) billToHubCode = hub[1];
          // Strip trailing location code like "(CPC-MUM5)" / "(HYD3)"
          const name = raw.replace(/\s*\([^)]+\)\s*$/, '').trim();
          if (name && name.length > 2) {
            vendorName = name;
            break;
          }
        }
        break;
      }
    }

    // GSTIN from Bill To section (second GSTIN after Bill To)
    const billToIdx = text.search(/Bill To\s*:/i);
    const afterBillTo = billToIdx >= 0 ? text.substring(billToIdx) : text;
    const gstinMatch = afterBillTo.match(/GSTIN\s*:\s*(\S+)/i);
    const vendorGstin = gstinMatch ? gstinMatch[1] : undefined;

    // Vendor address (Bill To address)
    const vendorAddrMatch = text.match(/Bill To[\s\S]*?Address\s*:\s*([\s\S]*?)(?:GSTIN|Phone|State)/i);
    const vendorAddress = vendorAddrMatch
      ? vendorAddrMatch[1].replace(/\n/g, ', ').replace(/\s+/g, ' ').trim()
      : undefined;

    // Shipped To / Ship To — use first line only; PDF text order can make greedy (.+) span the whole file.
    const shipToLineMatch = text.match(
      /(?:Shipped To|Ship To)\s*:\s*([^\n\r]+)/im,
    );
    let shippedTo = shipToLineMatch ? shipToLineMatch[1].trim() : '';
    if (shippedTo.includes('\t')) {
      shippedTo = shippedTo.split('\t').pop()?.trim() || shippedTo;
    }

    // Extract hub code like CPC-MUM5, HYD3 from parentheses
    const cpcMatch = shippedTo.match(/\(([A-Z]+-[A-Z0-9]+|[A-Z]{2,}\d+[A-Z]?)\)/i);
    const shippingLocation =
      billToHubCode || (cpcMatch ? cpcMatch[1] : shippedTo);

    // Shipping address
    const shipAddrMatch = text.match(
      /(?:Shipped To|Ship To)\s*:[\s\S]*?Address\s*:\s*([\s\S]*?)(?:State|Phone|GSTIN)/i,
    );
    const shippingAddress = shipAddrMatch
      ? shipAddrMatch[1].replace(/\n/g, ', ').replace(/\s+/g, ' ').trim()
      : undefined;

    // Grand total: "Total\t1658\t185834.7" — last number on the Total line
    const totalMatch = text.match(/^Total\s+[\d,]+\s+([\d,.]+)/m);
    const grandTotal = totalMatch
      ? parseFloat(totalMatch[1].replace(/,/g, ''))
      : undefined;

    // Full PO vs PO SCHEDULE: schedule rows are Product No | Name | HSN | Scheduled Qty (no prices).
    const lineItems = this.isHyperpurePoSchedule(text)
      ? this.extractHyperpureScheduleLineItems(text)
      : this.extractHyperpureLineItems(text);

    return {
      vendorName,
      vendorGstin,
      vendorAddress,
      poNumber,
      poDate,
      expectedDeliveryDate,
      shippingLocation,
      shippingAddress,
      lineItems,
      grandTotal,
    };
  }

  private extractHyperpureLineItems(text: string): ExtractedLineItem[] {
    const items: ExtractedLineItem[] = [];
    const lines = text.split('\n');

    // Find lines starting with a product number (5-6 digit code)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const startMatch = line.match(/^(\d{5,6})\s+(.+)/);
      if (!startMatch) continue;

      // Collect multi-line item text until we hit a numeric pattern with Total
      let block = startMatch[2];
      let j = i + 1;
      while (j < lines.length && j < i + 5) {
        const nextLine = lines[j].trim();
        if (/^\d{5,6}\s/.test(nextLine) || /^Delivery Charge/i.test(nextLine) || /^Total\s/i.test(nextLine)) break;
        block += ' ' + nextLine;
        j++;
      }

      // Pattern: ... HSN(8-digit) - - QTY PRICE UoM GST_RATE TAX_AMT TOTAL
      const itemMatch = block.match(
        /(.+?)\s+(\d{8})\s+[\-\d.]+\s+[\-\d.]+\s+(\d+)\s+([\d.]+)\s+\w[\w\s]*?\s+[\d.]+\s+[\d.]+\s+([\d.]+)$/,
      );
      if (itemMatch) {
        items.push({
          skuCode: startMatch[1],
          skuName: itemMatch[1].replace(/\s+/g, ' ').trim(),
          hsnCode: itemMatch[2],
          quantity: parseInt(itemMatch[3], 10),
          price: parseFloat(itemMatch[4]),
          total: parseFloat(itemMatch[5]),
        });
      }
    }

    return items;
  }

  /** Hyperpure "PO SCHEDULE" attachment: tabular scheduled qty only (no unit prices in body). */
  private isHyperpurePoSchedule(text: string): boolean {
    return /PO\s*SCHEDULE/i.test(text) && /Scheduled\s*Qty/i.test(text);
  }

  /**
   * Line items from PO SCHEDULE table: Product No., ProductName, HSN, Scheduled Qty.
   * Prices are absent — set to 0 so validation/pricing can fill from NECC rules.
   */
  private extractHyperpureScheduleLineItems(text: string): ExtractedLineItem[] {
    const items: ExtractedLineItem[] = [];
    const lines = text.split('\n');
    let inTable = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (/Product\s*No\.?\b/i.test(line) && /Scheduled\s*Qty/i.test(line)) {
        inTable = true;
        continue;
      }
      if (!inTable) continue;

      if (
        /^Vendor\s+Id\b/i.test(line) ||
        /^ZOMATO\s+HYPERPURE/i.test(line) ||
        /^Registered\s+Address/i.test(line)
      ) {
        break;
      }

      const parts = line.split(/\t+/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 4) {
        const qtyStr = parts[parts.length - 1].replace(/,/g, '');
        const hsn = parts[parts.length - 2];
        const code = parts[0];
        const name = parts.slice(1, parts.length - 2).join(' ').trim();
        const qty = parseInt(qtyStr, 10);
        if (!/^\d{5,6}$/.test(code) || !/^\d{8}$/.test(hsn) || !Number.isFinite(qty) || qty < 0) {
          continue;
        }
        items.push({
          skuCode: code,
          skuName: name,
          hsnCode: hsn,
          quantity: qty,
          price: 0,
          total: 0,
        });
        continue;
      }

      // Fallback: single-space-separated row (rare after pdf-parse)
      const m = line.match(/^(\d{5,6})\s+(.+?)\s+(\d{8})\s+([\d,]+)\s*$/);
      if (m) {
        const qty = parseInt(m[4].replace(/,/g, ''), 10);
        items.push({
          skuCode: m[1],
          skuName: m[2].replace(/\s+/g, ' ').trim(),
          hsnCode: m[3],
          quantity: qty,
          price: 0,
          total: 0,
        });
      }
    }

    return items;
  }

  /**
   * Parser for PO format where:
   *   - "Vendor Details" = the user's own company (supplier) — we SKIP this
   *   - "Billing Address" = the counterparty/buyer — this is our vendorName
   */
  private parseVendorBillingPo(text: string): PdfExtractionResult {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    const poNumber = this.extractField(lines, /PO\s*No\s*:\s*(\S+)/i) || '';
    const poDate = this.extractField(lines, /PO\s*Date\s*:\s*(.+)/i) || '';
    const expectedDeliveryDate = this.extractField(lines, /Expected\s*Delivery\s*Date\s*:\s*(.+)/i);
    const expiryDate = this.extractField(lines, /PO\s*Expiry\s*Date\s*:\s*(.+)/i);
    // Only keep paymentTerms if it looks like a short payment term (not T&C text)
    const rawPaymentTerms = this.extractField(lines, /Payment\s*Terms\s*:\s*(.+)/i);
    const paymentTerms = rawPaymentTerms && rawPaymentTerms.length <= 80 ? rawPaymentTerms : undefined;

    // Extract the counterparty name from Billing Address section. If billing
    // shows the seller (us) instead of the buyer, fall back to other candidates.
    const vendorName = this.pickCounterpartyName(
      this.extractBillingAddressCompany(text),
      this.extractShippingAddressCompany(text),
      this.extractVendorName(lines),
    );

    // GSTIN from Billing Address (second GSTIN after the Billing Address header)
    const vendorGstin = this.extractBillingAddressGstin(text);

    // Shipping location from the Shipping Address section
    const shippingLocation = this.extractShippingLocationFromBillingFormat(text);

    // Line items and totals — use dedicated extractor for this format (UUID-based SKU)
    const lineItems = this.extractVendorBillingLineItems(text);

    const grandTotalMatch = text.match(/Grand\s*Total\s*(?:Amount\s*)?\(INR\)\s*([\d,.]+)/i);
    const grandTotal = grandTotalMatch
      ? parseFloat(grandTotalMatch[1].replace(/,/g, ''))
      : undefined;

    const totalTaxMatch = text.match(/Total\s*Tax\s*\(INR\)\s*([\d,.]+)/i);
    const totalTax = totalTaxMatch
      ? parseFloat(totalTaxMatch[1].replace(/,/g, ''))
      : undefined;

    return {
      vendorName,
      vendorGstin,
      poNumber,
      poDate,
      expectedDeliveryDate,
      expiryDate,
      paymentTerms,
      shippingLocation,
      lineItems,
      grandTotal,
      totalTax,
    };
  }

  /**
   * Extract line items from the vendor_billing PDF format.
   * This format has: Sr | Material Code | Item Description | SKU Code (UUID) | HSN Code | EAN No | Qty | MRP | Unit Cost | Taxable Value | [taxes] | Total
   */
  private extractVendorBillingLineItems(text: string): ExtractedLineItem[] {
    const items: ExtractedLineItem[] = [];
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Match lines starting with serial number + material code (5-6 digit numeric)
      const startMatch = line.match(/^(\d+)\s+(\d{5,6})\s+(.+)/);
      if (!startMatch) continue;

      const materialCode = startMatch[2];
      // Collect up to 15 continuation lines
      let block = startMatch[3];
      let j = i + 1;
      while (j < lines.length && j < i + 15) {
        const next = lines[j].trim();
        if (/^\d+\s+\d{5,6}\s+/.test(next)) break; // next serial number row
        block += ' ' + next;
        j++;
      }

      // Normalize: UUIDs may be split across lines with a space at the hyphen boundary.
      // e.g. "dbbe1122-2957-44c4- bcd1-dad32ad193ad" → remove spaces after/before UUID segments
      block = block.replace(/([0-9a-f]{4,8}-)\s+([0-9a-f])/gi, '$1$2');

      // Now match the full UUID
      const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const uuidMatch = block.match(uuidPattern);
      if (!uuidMatch) continue;

      const afterUuid = block.substring(block.indexOf(uuidMatch[0]) + uuidMatch[0].length).trim();
      // After UUID: HSN(8) EAN(12-13) Qty MRP UnitCost TaxableValue ... Total
      const numMatch = afterUuid.match(
        /(\d{8})\s+(\d{12,13})\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/,
      );
      if (!numMatch) continue;

      // Description is everything before the UUID
      const desc = block
        .substring(0, block.indexOf(uuidMatch[0]))
        .replace(/\s+/g, ' ')
        .trim();

      // Total: last number in afterUuid
      const allNums = afterUuid.match(/[\d.]+/g) || [];
      const total = allNums.length > 0 ? parseFloat(allNums[allNums.length - 1]) : undefined;

      items.push({
        skuCode: materialCode,
        skuName: desc,
        hsnCode: numMatch[1],
        quantity: parseInt(numMatch[3], 10),
        mrp: parseFloat(numMatch[4]),
        price: parseFloat(numMatch[5]),
        taxableValue: parseFloat(numMatch[6]),
        total,
      });
    }

    return items;
  }

  /** Extract the first company name from the Billing Address block */
  private extractBillingAddressCompany(text: string): string {
    const tryLine = (raw: string): string | undefined => {
      const t = raw.trim();
      if (!t || this.isGarbageVendorLabel(t)) return undefined;
      const inline = t.match(/^Address\s*:\s*(.+)$/i);
      const body = (inline?.[1] ?? t).trim();
      if (!body || this.isGarbageVendorLabel(body)) return undefined;
      return body;
    };

    // Text after "Billing Address" up to the next major section
    const billingMatch = text.match(/Billing\s*Address[\s\S]*?Address\s*:\s*([^\n]+)/i);
    if (billingMatch) {
      const hit = tryLine(billingMatch[1]);
      if (hit) return hit;
    }

    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (!/Billing\s*Address/i.test(lines[i])) continue;
      for (let j = i + 1; j < Math.min(i + 22, lines.length); j++) {
        const raw = lines[j];
        if (!raw || /^Shipping\s*Address/i.test(raw)) break;

        if (/^Address\s*:/i.test(raw)) {
          const fromSame = tryLine(raw);
          if (fromSame) return fromSame;
          // "Address :" alone — company name is often on the next line (Cloudstore PDFs).
          if (j + 1 < lines.length) {
            const nextHit = tryLine(lines[j + 1]);
            if (nextHit) return nextHit;
          }
          continue;
        }

        if (
          /^GSTIN\s*:/i.test(raw) ||
          /^PAN\s*:/i.test(raw) ||
          /^Phone\s*:/i.test(raw) ||
          /^Email\s*:/i.test(raw)
        ) {
          continue;
        }

        const hit = tryLine(raw);
        if (hit && hit.length > 4) return hit;
      }
    }
    return '';
  }

  /** Extract GSTIN from the Billing Address section (not the Vendor Details section) */
  private extractBillingAddressGstin(text: string): string | undefined {
    // Find the section after "Billing Address"
    const billingIdx = text.search(/Billing\s*Address/i);
    if (billingIdx === -1) return undefined;
    const afterBilling = text.substring(billingIdx);
    const gstinMatch = afterBilling.match(/GSTIN\s*:\s*(\S+)/i);
    return gstinMatch ? gstinMatch[1] : undefined;
  }

  /** Extract the company / counterparty name from the Shipping Address section. */
  private extractShippingAddressCompany(text: string): string {
    const tryLine = (raw: string): string | undefined => {
      const t = raw.trim();
      if (!t || this.isGarbageVendorLabel(t)) return undefined;
      const inline = t.match(/^Address\s*:\s*(.+)$/i);
      const body = (inline?.[1] ?? t).trim();
      if (!body || this.isGarbageVendorLabel(body)) return undefined;
      return body;
    };

    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (!/Shipping\s*Address/i.test(lines[i])) continue;
      for (let j = i + 1; j < Math.min(i + 22, lines.length); j++) {
        const raw = lines[j];
        if (!raw || /^Billing\s*Address/i.test(raw)) break;

        if (/^Address\s*:/i.test(raw)) {
          const fromSame = tryLine(raw);
          if (fromSame) return fromSame;
          if (j + 1 < lines.length) {
            const nextHit = tryLine(lines[j + 1]);
            if (nextHit) return nextHit;
          }
          continue;
        }

        if (
          /^GSTIN\s*:/i.test(raw) ||
          /^PAN\s*:/i.test(raw) ||
          /^Phone\s*:/i.test(raw) ||
          /^Email\s*:/i.test(raw)
        ) {
          continue;
        }

        const hit = tryLine(raw);
        if (hit && hit.length > 4) return hit;
      }
    }
    return '';
  }

  /** Extract shipping location from Shipping Address section in vendor_billing format */
  private extractShippingLocationFromBillingFormat(text: string): string {
    const shippingIdx = text.search(/Shipping\s*Address/i);
    if (shippingIdx === -1) return '';
    const afterShipping = text.substring(shippingIdx);
    // Look for a warehouse/location code in parentheses e.g. (HYD003M)
    const codeMatch = afterShipping.match(/\(([A-Z0-9]+)\)/i);
    if (codeMatch) return codeMatch[1];
    // Fallback: first company-like line after "Address:"
    const addrMatch = afterShipping.match(/Address\s*:\s*([^\n]+)/i);
    if (addrMatch) return addrMatch[1].trim();
    return '';
  }

  private parseCloudstorePo(text: string): PdfExtractionResult {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    const poNumber = this.extractField(lines, /PO\s*No\s*:\s*(\S+)/i) || '';
    const poDate = this.extractField(lines, /PO\s*Date\s*:\s*(.+)/i) || '';
    const expectedDeliveryDate = this.extractField(
      lines,
      /Expected\s*Delivery\s*Date\s*:\s*(.+)/i,
    );
    const expiryDate = this.extractField(
      lines,
      /PO\s*Expiry\s*Date\s*:\s*(.+)/i,
    );
    const paymentTerms = this.extractField(
      lines,
      /Payment\s*Terms\s*:\s*(.+)/i,
    );

    const vendorName = this.pickCounterpartyName(
      this.extractBillingAddressCompany(text),
      this.extractShippingAddressCompany(text),
      this.extractVendorName(lines),
    );
    const vendorGstin = this.extractField(lines, /GSTIN\s*:(\S+)/i);

    // Shipping location from the shipping address block
    const shippingLocation = this.extractShippingLocation(text);

    // Line items
    const lineItems = this.extractLineItems(text);

    // Grand total
    const grandTotalMatch = text.match(
      /Grand\s*Total\s*\(INR\)\s*([\d,.]+)/i,
    );
    const grandTotal = grandTotalMatch
      ? parseFloat(grandTotalMatch[1].replace(/,/g, ''))
      : undefined;

    const totalTaxMatch = text.match(
      /Total\s*Tax\s*\(INR\)\s*([\d,.]+)/i,
    );
    const totalTax = totalTaxMatch
      ? parseFloat(totalTaxMatch[1].replace(/,/g, ''))
      : undefined;

    return {
      vendorName,
      vendorGstin,
      poNumber,
      poDate,
      expectedDeliveryDate,
      expiryDate,
      paymentTerms,
      shippingLocation,
      lineItems,
      grandTotal,
      totalTax,
    };
  }

  /**
   * Parser for Moonstone-style PO format (sample "Purchase Order.pdf") where labels are:
   * - P.O. Number
   * - Date
   * - PO delivery date / PO expiry date
   * and line items are wrapped heavily across lines.
   */
  private parseMoonstonePo(text: string): PdfExtractionResult {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    const poNumber =
      this.extractField(lines, /P\.?O\.?\s*Number\s*:\s*(\S+)/i) ||
      this.extractField(lines, /PO\s*No\s*:\s*(\S+)/i) ||
      '';

    const poDate =
      this.extractField(lines, /^Date\s*:\s*(.+)$/i) ||
      this.extractField(lines, /PO\s*Date\s*:\s*(.+)/i) ||
      '';

    const expectedDeliveryDate =
      this.extractField(lines, /PO\s*delivery\s*date\s*:\s*(.+)/i) ||
      this.extractField(lines, /Expected\s*Delivery\s*Date\s*:\s*(.+)/i);

    const expiryDate =
      this.extractField(lines, /PO\s*expiry\s*date\s*:\s*(.+)/i) ||
      this.extractField(lines, /PO\s*Expiry\s*Date\s*:\s*(.+)/i);

    const paymentTerms = this.extractField(lines, /Payment\s*Terms\s*:\s*(.+)/i);

    const vendorName = this.extractMoonstoneCounterpartyName(text, lines);

    const vendorGstin =
      this.extractField(lines, /GST\s*No\.?\s*:\s*(\S+)/i) ||
      this.extractField(lines, /GSTIN\s*:\s*(\S+)/i);

    const shippingLocation = this.extractMoonstoneShippingLocation(text);

    const lineItems = this.extractMoonstoneLineItems(text);

    const grandTotalMatch =
      text.match(/Net\s*amount\s*([\d,.]+)/i) ||
      text.match(/Total\s*Amount\s*([\d,.]+)/i);
    const grandTotal = grandTotalMatch
      ? parseFloat(grandTotalMatch[1].replace(/,/g, ''))
      : undefined;

    return {
      vendorName,
      vendorGstin,
      poNumber,
      poDate,
      expectedDeliveryDate,
      expiryDate,
      paymentTerms,
      shippingLocation,
      lineItems,
      grandTotal,
    };
  }

  private isOwnCompanyName(name?: string): boolean {
    if (!name) return false;
    return this.ownCompanyPatterns.some((p) => p.test(name));
  }

  /** Labels and junk that pdf-parse sometimes puts where a company name should be. */
  private isGarbageVendorLabel(name: string): boolean {
    const t = name
      .trim()
      .replace(/\uFF1A/g, ':')
      .replace(/\u00A0/g, ' ');
    if (t.length < 2) return true;
    if (/^PO\s*No\.?\s*:/i.test(t)) return true;
    if (/^PO\s*Number\s*:?\s*$/i.test(t)) return true;
    if (/^P\.?O\.?\s*No\.?\s*:?\s*$/i.test(t)) return true;
    if (/^Purchase\s*Order\s*No\.?\s*:?\s*$/i.test(t)) return true;
    if (/^PO\s*Date\s*:?\s*$/i.test(t)) return true;
    if (/^Expected\s*Delivery/i.test(t)) return true;
    if (/^GSTIN\s*:?\s*$/i.test(t)) return true;
    if (/^PAN\s*:?\s*$/i.test(t)) return true;
    if (/^Address\s*:?\s*$/i.test(t)) return true;
    if (/^Vendor\s*Name\s*:?\s*$/i.test(t)) return true;
    if (/^Billing\s*Address\s*:?\s*$/i.test(t)) return true;
    if (/^Ship(?:ping)?\s*(?:To|From)\s*:?\s*$/i.test(t)) return true;
    if (/^(buyer|customer|vendor|consignee|bill\s*to)\s*:\s*$/i.test(t)) return true;
    return false;
  }

  private pickCounterpartyName(...candidates: Array<string | undefined>): string {
    for (const candidate of candidates) {
      if (!candidate) continue;
      const c = candidate.trim();
      if (!c || this.isGarbageVendorLabel(c)) continue;
      if (!this.isOwnCompanyName(c)) return c;
    }
    for (const candidate of candidates) {
      if (!candidate) continue;
      const c = candidate.trim();
      if (!c || this.isGarbageVendorLabel(c)) continue;
      return c;
    }
    return '';
  }

  private extractMoonstoneCounterpartyName(text: string, lines: string[]): string {
    const headerCandidates: string[] = [];

    // In Moonstone PO, the issuer is usually in the top block before PAN/CIN labels.
    for (const line of lines.slice(0, 40)) {
      if (!line) continue;
      if (/^purchase\s*order$/i.test(line)) continue;
      if (/^(pan|cin|contact|phone|address|vendor|delivered|shipping|payment|p\.?o\.?\s*number|date)\b/i.test(line)) {
        continue;
      }
      if (/\b(llp|pvt\.?\s*ltd|private\s+limited|ltd|limited|inc|corp|ventures)\b/i.test(line)) {
        headerCandidates.push(line);
      }
    }

    const explicitVendor =
      this.extractField(lines, /Vendor\s*:\s*(.+)/i) ||
      this.extractVendorName(lines);

    return this.pickCounterpartyName(
      ...headerCandidates,
      explicitVendor,
      this.extractBillingAddressCompany(text),
    );
  }

  private extractMoonstoneShippingLocation(text: string): string {
    // Prefer city+pincode chunks from shipping section (e.g. Hyderabad 500094)
    const cityPinMatches = text.match(/[A-Za-z]+\s+\d{6}/g);
    if (cityPinMatches && cityPinMatches.length > 0) {
      return cityPinMatches[cityPinMatches.length - 1];
    }
    return '';
  }

  private extractMoonstoneLineItems(text: string): ExtractedLineItem[] {
    const items: ExtractedLineItem[] = [];
    const lines = text.split('\n').map((l) => l.trim());

    const startIdx = lines.findIndex((l) => /^#\s*Item/i.test(l));
    if (startIdx === -1) return items;

    const isRowStart = (line: string) => /^\d{1,3}\s+\d{5,8}/.test(line);

    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (/^Total\s*Quantity/i.test(line)) break;
      if (!isRowStart(line)) continue;

      const startMatch = line.match(/^(\d{1,3})\s+(\d{5,8})(.*)$/);
      if (!startMatch) continue;

      let block = `${startMatch[2]} ${startMatch[3] || ''}`.trim();
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (!next) {
          j++;
          continue;
        }
        if (isRowStart(next) || /^Total\s*Quantity/i.test(next)) break;
        block += ` ${next}`;
        j++;
      }
      i = j - 1;

      block = block.replace(/\s+/g, ' ').trim();

      // Head: item code fragments + HSN (often split as 0407 1100)
      const headMatch = block.match(/^(\d{5,8})(?:\s+(\d{1,3}))?\s+(\d{4})\s*(\d{4})\s+([\s\S]+)$/);
      if (!headMatch) continue;

      const itemCode = `${headMatch[1]}${headMatch[2] || ''}`;
      const hsnCode = `${headMatch[3]}${headMatch[4]}`;
      let tail = headMatch[5].trim();

      // Strip UPC-ish leading numeric chunks before description.
      tail = tail.replace(/^(?:\d{4,13}\s+){1,4}/, '');

      const firstDecimalIdx = tail.search(/\d+\.\d{1,2}/);
      if (firstDecimalIdx === -1) continue;

      const skuName = tail.substring(0, firstDecimalIdx).replace(/\s+/g, ' ').trim();
      const numPart = tail.substring(firstDecimalIdx);
      const nums = (numPart.match(/\d+\.\d{1,2}|\d+/g) || []).map((n) => parseFloat(n));
      if (nums.length < 4) continue;

      // In this format, tail usually ends with: Qty, MRP, Margin%, Total
      const quantity = nums.length >= 4 ? nums[nums.length - 4] : 0;
      const mrp = nums.length >= 3 ? nums[nums.length - 3] : undefined;
      const total = nums.length >= 1 ? nums[nums.length - 1] : undefined;
      const price = nums[0]; // Basic cost price

      items.push({
        skuCode: itemCode,
        skuName,
        hsnCode,
        quantity,
        price,
        mrp,
        total,
      });
    }

    return items;
  }

  private extractField(
    lines: string[],
    pattern: RegExp,
  ): string | undefined {
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) return match[1].trim();
    }
    // Also try joining consecutive lines
    const fullText = lines.join(' ');
    const match = fullText.match(pattern);
    return match ? match[1].trim() : undefined;
  }

  private extractVendorName(lines: string[]): string {
    // Vendor name appears after "Reference PO Code:" line
    for (let i = 0; i < lines.length; i++) {
      if (/Reference\s*PO\s*Code/i.test(lines[i])) {
        // The next non-empty line(s) contain vendor name
        for (let j = i + 1; j < lines.length && j < i + 3; j++) {
          const line = lines[j];
          if (
            line &&
            !line.startsWith('Billing') &&
            !line.startsWith('Shipping') &&
            !/^CLOUDSTORE/i.test(line) &&
            !this.isGarbageVendorLabel(line)
          ) {
            return line;
          }
        }
      }
    }
    // Fallback: look for "Vendor Name :" pattern
    for (const line of lines) {
      const m = line.match(/Vendor\s*Name\s*:\s*(.+)/i);
      if (m) {
        const v = m[1].trim();
        if (!this.isGarbageVendorLabel(v)) return v;
      }
    }
    return '';
  }

  private extractShippingLocation(text: string): string {
    // Extract shipping address block after "Shipping Address"
    const match = text.match(
      /Shipping\s*Address[\s\S]*?CLOUDSTORE[\s\S]*?([A-Za-z]+,\s*[A-Za-z\s]+-\s*\d{6})/i,
    );
    if (match) return match[1].trim();

    // Fallback: look for warehouse name pattern "CLDST MUM FnV2" etc.
    const whMatch = text.match(/CLDST\s+(\S+\s+\S+)/i);
    if (whMatch) return whMatch[0].trim();

    return '';
  }

  private extractLineItems(text: string): ExtractedLineItem[] {
    const items: ExtractedLineItem[] = [];
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Match a line starting with a serial number followed by a 4-6 digit item code
      const startMatch = line.match(/^(\d+)\s+(\d{4,6})\s+(.*)/);
      if (!startMatch) continue;

      const serialNo = parseInt(startMatch[1], 10);
      const itemCode = startMatch[2];
      if (serialNo < 1 || serialNo > 999) continue;

      // Strip colour/size/brand metadata from the description part first
      const rawDesc = startMatch[3].replace(/\s*Colour:.*$/i, '').trim();

      // Collect continuation lines until the next item or a totals row
      let block = rawDesc;
      let j = i + 1;
      while (j < lines.length && j < i + 20) {
        const next = lines[j].trim();
        if (/^\d+\s+\d{4,6}\s+/.test(next)) break; // next item row
        if (/Total\s*Amount|Grand\s*Total/i.test(next)) break;
        // Strip colour metadata from continuation lines too
        const cleaned = next.replace(/\s*Colour:.*$/i, '').trim();
        block += ' ' + cleaned;
        j++;
      }

      block = block.replace(/\s+/g, ' ').trim();

      // Find 8-digit HSN code
      const hsnMatch = block.match(/\b(\d{8})\b/);
      if (!hsnMatch) continue;

      const hsnIdx = block.indexOf(hsnMatch[0]);
      const desc = block.substring(0, hsnIdx).replace(/\s+/g, ' ').trim();
      const afterHsn = block.substring(hsnIdx + 8).trim();

      // Parse numbers after HSN: Qty, MRP, UnitCost, TaxableValue, ...taxes..., Total
      const nums = afterHsn.match(/[\d,]+\.?\d*/g);
      if (!nums || nums.length < 4) continue;

      const parseNum = (s: string) => parseFloat(s.replace(/,/g, ''));

      items.push({
        skuCode: itemCode,
        skuName: desc,
        hsnCode: hsnMatch[0],
        quantity: parseNum(nums[0]),
        mrp: parseNum(nums[1]),
        price: parseNum(nums[2]),
        taxableValue: parseNum(nums[3]),
        cgstRate: nums[4] ? parseNum(nums[4]) : undefined,
        cgstAmount: nums[5] ? parseNum(nums[5]) : undefined,
        sgstRate: nums[6] ? parseNum(nums[6]) : undefined,
        sgstAmount: nums[7] ? parseNum(nums[7]) : undefined,
        igstRate: nums[8] ? parseNum(nums[8]) : undefined,
        igstAmount: nums[9] ? parseNum(nums[9]) : undefined,
        total: nums.length > 0 ? parseNum(nums[nums.length - 1]) : undefined,
      });
    }

    // Fallback: simpler approach if the detailed regex failed
    if (items.length === 0) {
      const simpleItems = this.extractLineItemsSimple(text);
      items.push(...simpleItems);
    }

    return items;
  }

  private extractLineItemsSimple(text: string): ExtractedLineItem[] {
    const items: ExtractedLineItem[] = [];

    // Find section between header markers and "Total Amount"
    const lines = text.split('\n');
    let inItemSection = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Start after the last header row (contains "Amt (INR)")
      if (/Rate\s+Amt/i.test(line) && /INR/i.test(line)) {
        inItemSection = true;
        continue;
      }

      // Stop at totals
      if (/Total\s*Amount\s*\(INR\)/i.test(line)) {
        break;
      }

      if (!inItemSection) continue;

      // Match a line starting with a serial number then item code
      const lineMatch = line.match(/^(\d+)\s+(\d{4,6})\s+(.+)/);
      if (lineMatch) {
        const skuCode = lineMatch[2];
        // Gather the full item text including continuation lines until we find HSN+numbers
        let fullBlock = lineMatch[3];
        let j = i + 1;
        while (j < lines.length && j < i + 10) {
          fullBlock += ' ' + lines[j].trim();
          // Check if we've collected the HSN code and numeric values
          if (/\d{8}\s+\d+\s+[\d.]+\s+[\d.]+\s+[\d.]+/.test(fullBlock)) {
            break;
          }
          j++;
        }

        // Parse: description HSN qty mrp unitCost taxableValue ...
        const dataMatch = fullBlock.match(
          /([\s\S]*?)(\d{8})\s+([\d]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/,
        );
        if (dataMatch) {
          const desc = dataMatch[1]
            .replace(/\n/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/\s*Colour:.*$/i, '')
            .trim();

          // Find total (last number in remaining text)
          const remainingNumbers = fullBlock
            .substring(fullBlock.indexOf(dataMatch[6]) + dataMatch[6].length)
            .match(/[\d.]+/g);
          const total =
            remainingNumbers && remainingNumbers.length > 0
              ? parseFloat(remainingNumbers[remainingNumbers.length - 1])
              : parseFloat(dataMatch[6]);

          items.push({
            skuCode,
            skuName: desc,
            hsnCode: dataMatch[2],
            quantity: parseInt(dataMatch[3], 10),
            mrp: parseFloat(dataMatch[4]),
            price: parseFloat(dataMatch[5]),
            taxableValue: parseFloat(dataMatch[6]),
            total,
          });
        }
      }
    }

    return items;
  }
}
