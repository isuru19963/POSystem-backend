import { Injectable, Logger } from '@nestjs/common';
import { AiGrnExtractionResult, AiGrnExtractionService } from './ai-grn-extraction.service';

export interface GrnExtractedLineItem {
  itemCode: string;
  itemName: string;
  hsnCode?: string;
  orderedQty: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason?: string;
}

export interface GrnExtractionResult {
  grnNumber: string;
  poNumber: string;
  supplierName: string;
  grnDate: string;
  lineItems: GrnExtractedLineItem[];
  rawText?: string;
  confidence?: number;
  extractionMethod?: 'rule' | 'hybrid' | 'ai';
}

/** Email subject often has the only reliable PO number (Hyperpure GRN mails). */
export interface GrnExtractionHints {
  emailSubject?: string;
}

/**
 * Extracts GRN data from PDF documents.
 *
 * Handles common GRN PDF formats:
 *  - Standard tabular GRN (GRN No, PO No, Date, item table with ordered/received/accepted/rejected)
 *  - Vendor delivery challans referencing a PO
 */
@Injectable()
export class GrnPdfExtractionService {
  private readonly logger = new Logger(GrnPdfExtractionService.name);

  constructor(private readonly aiGrnExtractionService: AiGrnExtractionService) {}

  /**
   * Fast check: does this PDF look like a goods-receipt / GRN document?
   * Used when the email subject/filename are generic (common for Hyperpure).
   */
  async looksLikeGrnDocument(pdfBuffer: Buffer): Promise<boolean> {
    try {
      const text = await this.extractPlainText(pdfBuffer);
      if (!text || text.length < 40) return false;
      const hasGrnSignal =
        /goods\s*received|goods\s*receipt|grn\s*no|grn\s*number|receipt\s*note|delivery\s*challan|received\s*qty|accepted\s*qty/i.test(
          text,
        );
      const hasPoSignal =
        /\bPO\s*No\b|purchase\s*order|\b(?:CFF|CMP|CVPL)PO\d+/i.test(text);
      return hasGrnSignal && hasPoSignal;
    } catch {
      return false;
    }
  }

  private async extractPlainText(pdfBuffer: Buffer): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PDFParse } = require('pdf-parse');
    const uint8 = new Uint8Array(pdfBuffer);
    const parser = new PDFParse(uint8);
    await parser.load();
    const textResult = await parser.getText();
    const text = textResult.pages.map((p: { text: string }) => p.text).join('\n');
    parser.destroy();
    return text;
  }

  async extract(
    pdfBuffer: Buffer,
    hints?: GrnExtractionHints,
  ): Promise<GrnExtractionResult> {
    this.logger.log('Extracting GRN PDF...');

    const text = await this.extractPlainText(pdfBuffer);
    this.logger.log(`Extracted text length: ${text.length}`);

    let result = this.parseGrn(text, hints);
    result.rawText = text;
    result.confidence = this.computeConfidence(result);
    result.extractionMethod = 'rule';

    if (this.shouldUseAiFallback(result)) {
      this.logger.warn(
        `Low GRN extraction confidence (${result.confidence?.toFixed(2)}) for ${result.grnNumber || '[unknown]'}, trying AI fallback`,
      );
      const aiResult = await this.aiGrnExtractionService.extractFromText(text);
      if (aiResult) {
        result = this.mergeWithAiResult(result, aiResult);
      }
    }

    this.logger.log(
      `Parsed GRN "${result.grnNumber}" (PO: ${result.poNumber}) with ${result.lineItems.length} items (confidence=${result.confidence?.toFixed(2)}, method=${result.extractionMethod})`,
    );

    return result;
  }

  private shouldUseAiFallback(result: GrnExtractionResult): boolean {
    if (!this.aiGrnExtractionService.isEnabled()) return false;
    if (!result.grnNumber || !result.poNumber || !result.supplierName) return true;
    if (!result.lineItems || result.lineItems.length === 0) return true;
    return (result.confidence || 0) < 0.72;
  }

  private computeConfidence(result: GrnExtractionResult): number {
    let score = 0;
    if (result.grnNumber) score += 0.25;
    if (result.poNumber) score += 0.20;
    if (result.supplierName) score += 0.15;
    if (result.grnDate) score += 0.10;
    if (result.lineItems?.length) {
      score += result.lineItems.length >= 2 ? 0.30 : 0.20;
    }
    return Math.min(1, score);
  }

  private mergeWithAiResult(
    ruleResult: GrnExtractionResult,
    aiResult: AiGrnExtractionResult,
  ): GrnExtractionResult {
    const merged: GrnExtractionResult = {
      ...ruleResult,
      grnNumber: ruleResult.grnNumber || aiResult.grnNumber || '',
      poNumber: ruleResult.poNumber || aiResult.poNumber || '',
      supplierName: ruleResult.supplierName || aiResult.supplierName || '',
      grnDate: this.normalizeDate(ruleResult.grnDate || aiResult.grnDate || ''),
      lineItems: ruleResult.lineItems?.length
        ? ruleResult.lineItems
        : (aiResult.lineItems || []).map((li) => ({
            itemCode: li.itemCode,
            itemName: li.itemName,
            hsnCode: li.hsnCode,
            orderedQty: li.orderedQty,
            receivedQty: li.receivedQty,
            acceptedQty: li.acceptedQty,
            rejectedQty: li.rejectedQty,
            rejectionReason: li.rejectionReason,
          })),
      extractionMethod: 'hybrid',
    };

    merged.confidence = this.computeConfidence(merged);
    return merged;
  }

  private parseGrn(text: string, hints?: GrnExtractionHints): GrnExtractionResult {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const subject = hints?.emailSubject ?? '';

    const poFromSubject = this.extractPoNumberFromSubject(subject);
    const poFromText =
      text.match(/\b((?:CFF|CMP|CVPL|CVP|HP)PO\d{4,}[A-Z0-9-]*)\b/i)?.[1] ||
      text.match(/\b([A-Z]{2,}\d*-PO-\d+)\b/i)?.[1];

    const poNumber =
      poFromSubject ||
      poFromText ||
      this.extractField(lines, [
        /PO\s*(?:No|Number|#)\s*[:\-]?\s*(\S+)/i,
        /Purchase\s*Order\s*(?:No|Number)\s*[:\-]?\s*(\S+)/i,
        /Reference\s*PO\s*[:\-]?\s*(\S+)/i,
        /Ref\s*PO\s*[:\-]?\s*(\S+)/i,
        /Order\s*(?:No|Number)\s*[:\-]?\s*(\S+)/i,
      ]) ||
      this.extractLabelOnNextLine(lines, ['PO No', 'PO Number', 'Purchase Order No']) ||
      '';

    const grnFromSubject = subject.match(
      /\bGRN\s*(?:No\.?|Number|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]{3,})/i,
    )?.[1];
    const grnFromPdf =
      this.extractField(lines, [
        /GRN\s*(?:No|Number|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i,
        /Goods\s*Receipt\s*(?:Note|No)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i,
        /Receipt\s*No\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i,
      ]) ||
      this.extractLabelOnNextLine(lines, ['GRN No', 'GRN Number', 'Goods Receipt Note']);
    const grnNumber =
      (grnFromPdf && !/^PO$/i.test(grnFromPdf) && this.isMeaningfulFieldValue(grnFromPdf)
        ? grnFromPdf
        : undefined) ||
      grnFromSubject ||
      (poNumber ? `GRN-${poNumber}` : `GRN-${Date.now()}`);

    const supplierName =
      this.extractField(lines, [
        /Supplier\s*(?:Name)?\s*[:\-]?\s*(.+)/i,
        /Vendor\s*(?:Name)?\s*[:\-]?\s*(.+)/i,
        /From\s*[:\-]?\s*(.+)/i,
      ]) ||
      this.extractSupplierFromSubject(subject) ||
      '';

    const grnDate = this.extractField(lines, [
      /GRN\s*Date\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      /Receipt\s*Date\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      /Date\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
    ]) || new Date().toISOString().slice(0, 10);

    let lineItems = this.extractLineItems(text, lines);
    if (!lineItems.length) {
      lineItems = this.extractHyperpureGrnLineItems(text, lines);
    }
    if (!lineItems.length) {
      lineItems = this.extractLineItemsFromBlob(text);
    }
    if (!lineItems.length) {
      lineItems = this.extractHyperpureTableItems(lines);
    }

    return {
      grnNumber,
      poNumber,
      supplierName,
      grnDate: this.normalizeDate(grnDate),
      lineItems,
    };
  }

  private extractPoNumberFromSubject(subject: string): string {
    if (!subject) return '';
    const hp = subject.match(
      /(?:PO\s*Number|against\s*PO)\s*([A-Z0-9]+-PO-\d+)/i,
    )?.[1];
    if (hp) return hp.toUpperCase();
    const cloud =
      subject.match(/(?:^|[^A-Z0-9])((?:CFF|CMP)PO\d{4,}[A-Z0-9-]*)/i)?.[1] ||
      subject.match(/_((?:CFF|CMP)PO\d{4,}[A-Z0-9-]*)/i)?.[1];
    if (cloud) return cloud.toUpperCase();
    const blr = subject.match(/\b(BLRPO\d+)\b/i)?.[1];
    if (blr) return blr.toUpperCase();
    const mbf =
      subject.match(/_((?:MBF)PO\d{4,}[A-Z0-9-]*)/i)?.[1] ||
      subject.match(/\b(MBFPO\d+)\b/i)?.[1];
    if (mbf) return mbf.toUpperCase();
    return '';
  }

  /**
   * When rule parsers find no rows, match PO catalogue item codes inside the PDF
   * text and read the quantity integers that follow each code.
   */
  extractLineItemsFromPoCatalog(
    text: string,
    poLineItems: Array<{ itemCode?: string; itemName?: string }>,
  ): GrnExtractedLineItem[] {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const items: GrnExtractedLineItem[] = [];

    for (const poLi of poLineItems) {
      const code = poLi.itemCode?.trim();
      if (!code || code.length < 3) continue;

      const idx = lines.findIndex(
        (l) => l === code || l.startsWith(`${code} `) || l.includes(` ${code} `),
      );
      if (idx < 0) continue;

      const nums: number[] = [];
      for (let j = idx + 1; j < Math.min(lines.length, idx + 18); j++) {
        const ln = lines[j];
        if (/^\d{1,3}$/.test(ln) && nums.length === 0) continue; // skip row serial
        if (/^\d{8}$/.test(ln)) continue; // HSN
        if (/^\d+$/.test(ln)) {
          const n = parseInt(ln, 10);
          if (n <= 100_000) nums.push(n);
        } else if (nums.length > 0 && !/^\d/.test(ln)) {
          break;
        }
        if (nums.length >= 4) break;
      }
      if (!nums.length) continue;

      const [orderedQty = nums[0], receivedQty = nums[1] ?? nums[0], acceptedQty = nums[2] ?? nums[1] ?? nums[0], rejectedQty = nums[3] ?? 0] = nums;
      items.push({
        itemCode: code,
        itemName: poLi.itemName?.trim() || code,
        orderedQty,
        receivedQty,
        acceptedQty,
        rejectedQty,
      });
    }

    if (items.length) return items;

    return this.sniffLineItemsFromPoCatalog(text, poLineItems);
  }

  /**
   * Scan flattened PDF text for each PO item code and the quantity integers that follow.
   */
  /**
   * When PDF parsers find nothing, still create a GRN shell from the PO so the
   * record exists; quantities can be corrected in the UI.
   */
  buildFallbackLineItemsFromPo(
    poLineItems: Array<{
      itemCode?: string;
      itemName?: string;
      quantity?: number;
    }>,
  ): GrnExtractedLineItem[] {
    return poLineItems
      .filter((li) => li.itemCode?.trim())
      .map((li) => ({
        itemCode: li.itemCode!.trim(),
        itemName: li.itemName?.trim() || li.itemCode!.trim(),
        orderedQty: li.quantity ?? 0,
        receivedQty: 0,
        acceptedQty: 0,
        rejectedQty: 0,
      }));
  }

  sniffLineItemsFromPoCatalog(
    text: string,
    poLineItems: Array<{ itemCode?: string; itemName?: string }>,
  ): GrnExtractedLineItem[] {
    const items: GrnExtractedLineItem[] = [];
    const flat = text.replace(/\s+/g, ' ');

    for (const poLi of poLineItems) {
      const code = poLi.itemCode?.trim();
      if (!code || code.length < 3) continue;

      const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lineMatch = flat.match(
        new RegExp(
          `\\b${esc}\\b\\s+(.{3,100}?)\\s+(?:\\d{8}\\s+)?((?:\\d+\\s+){2,4})`,
          'i',
        ),
      );
      if (!lineMatch) continue;

      const nums = lineMatch[2]
        .trim()
        .split(/\s+/)
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isFinite(n) && n <= 100_000);
      if (nums.length < 2) continue;

      const [
        orderedQty = nums[0],
        receivedQty = nums[1] ?? nums[0],
        acceptedQty = nums[2] ?? nums[1] ?? nums[0],
        rejectedQty = nums[3] ?? 0,
      ] = nums;

      items.push({
        itemCode: code,
        itemName: poLi.itemName?.trim() || lineMatch[1].trim() || code,
        orderedQty,
        receivedQty,
        acceptedQty: acceptedQty > 0 ? acceptedQty : receivedQty,
        rejectedQty,
      });
    }

    return items;
  }

  /**
   * Hyperpure GRN PDFs list products as 5–6 digit codes (same as PO PDFs).
   */
  private extractHyperpureGrnLineItems(
    text: string,
    lines: string[],
  ): GrnExtractedLineItem[] {
    const items: GrnExtractedLineItem[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const startMatch = line.match(/^(\d{5,6})\s+(.+)/);
      if (!startMatch) continue;

      const itemCode = startMatch[1];
      let block = startMatch[2];
      let j = i + 1;
      while (j < lines.length && j < i + 10) {
        const nextLine = lines[j].trim();
        if (/^\d{5,6}\s/.test(nextLine)) break;
        if (/^Total\b/i.test(nextLine) || /^Grand\b/i.test(nextLine)) break;
        block += ' ' + nextLine;
        j++;
      }

      const patterns = [
        /(.+?)\s+(\d{8})\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/,
        /(.+?)\s+(\d{8})\s+(\d+)\s+(\d+)\s+(\d+)\s*$/,
        /(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/,
        /(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/,
      ];

      for (const re of patterns) {
        const m = block.match(re);
        if (!m) continue;
        const name = m[1].replace(/\s+/g, ' ').trim();
        const hsn = m[2]?.length === 8 ? m[2] : undefined;
        const qtyStart = hsn ? 3 : 2;
        const orderedQty = parseInt(m[qtyStart], 10);
        const receivedQty = parseInt(m[qtyStart + 1] ?? m[qtyStart], 10);
        const acceptedQty = parseInt(m[qtyStart + 2] ?? m[qtyStart + 1], 10);
        const rejectedQty = parseInt(m[qtyStart + 3] ?? '0', 10);
        items.push({
          itemCode,
          itemName: name || itemCode,
          hsnCode: hsn,
          orderedQty: Number.isFinite(orderedQty) ? orderedQty : acceptedQty,
          receivedQty: Number.isFinite(receivedQty) ? receivedQty : acceptedQty,
          acceptedQty: Number.isFinite(acceptedQty) ? acceptedQty : receivedQty,
          rejectedQty: Number.isFinite(rejectedQty) ? rejectedQty : 0,
        });
        break;
      }
    }

    if (items.length) return items;

    // Full-text row: productNo name hsn ordered received accepted rejected
    const blobRe =
      /(?:^|\n)\s*(\d{5,6})\s+(.{2,120}?)\s+(\d{8})\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/gim;
    for (const m of text.matchAll(blobRe)) {
      items.push({
        itemCode: m[1],
        itemName: m[2].replace(/\s+/g, ' ').trim(),
        hsnCode: m[3],
        orderedQty: parseInt(m[4], 10),
        receivedQty: parseInt(m[5], 10),
        acceptedQty: parseInt(m[6], 10),
        rejectedQty: parseInt(m[7], 10),
      });
    }

    return items;
  }

  private extractSupplierFromSubject(subject: string): string {
    const m = subject.match(/^(.+?)\s*-\s*Hyperpure\s+GRN/i);
    return m?.[1]?.trim() ?? '';
  }

  /**
   * Try each pattern in order; return first match group 1.
   */
  private extractField(lines: string[], patterns: RegExp[]): string | undefined {
    for (const pattern of patterns) {
      for (const line of lines) {
        const m = line.match(pattern);
        const v = m?.[1]?.trim();
        if (this.isMeaningfulFieldValue(v)) return v;
      }
      const full = lines.join(' ');
      const m = full.match(pattern);
      const v = m?.[1]?.trim();
      if (this.isMeaningfulFieldValue(v)) return v;
    }
    return undefined;
  }

  private isMeaningfulFieldValue(v?: string): boolean {
    if (!v || v.length < 2) return false;
    if (/^:+$/.test(v)) return false;
    if (/^[-–—]+$/.test(v)) return false;
    if (/^(?:GRN|PO|Purchase Order|Receipt)\s*(?:No|Number)?\s*:?\s*$/i.test(v)) {
      return false;
    }
    if (/^against$/i.test(v)) return false;
    return true;
  }

  /** Hyperpure PDFs often put labels and values on separate lines (`GRN No :` then `ABC123`). */
  private extractLabelOnNextLine(
    lines: string[],
    labels: string[],
  ): string | undefined {
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      for (const label of labels) {
        if (!new RegExp(`^${label}\\s*:?\\s*$`, 'i').test(line)) continue;
        const next = lines[i + 1]?.trim();
        if (this.isMeaningfulFieldValue(next)) return next;
      }
      for (const label of labels) {
        const inline = line.match(
          new RegExp(`^${label}\\s*:\\s*(.+)$`, 'i'),
        );
        const v = inline?.[1]?.trim();
        if (this.isMeaningfulFieldValue(v)) return v;
      }
    }
    return undefined;
  }

  /**
   * Hyperpure GRNs often break table rows across many lines in pdf-parse output.
   * Scan for runs: serial, SKU/item code, then 3–4 quantity integers.
   */
  private extractHyperpureTableItems(lines: string[]): GrnExtractedLineItem[] {
    const items: GrnExtractedLineItem[] = [];
    const qtyRe = /^\d+$/;
    for (let i = 0; i < lines.length - 4; i++) {
      if (!/^\d{1,3}$/.test(lines[i])) continue;
      const code = lines[i + 1];
      if (
        !/^[A-Z0-9][A-Z0-9\-/_]{2,}$/i.test(code) &&
        !/^\d{5,6}$/.test(code)
      ) {
        continue;
      }
      const nameParts: string[] = [];
      let j = i + 2;
      while (j < lines.length && !qtyRe.test(lines[j]) && nameParts.length < 6) {
        if (!/^(?:total|subtotal|grand|hsn|gst|cgst|sgst)$/i.test(lines[j])) {
          nameParts.push(lines[j]);
        }
        j++;
      }
      const nums: number[] = [];
      while (j < lines.length && nums.length < 4 && qtyRe.test(lines[j])) {
        nums.push(parseInt(lines[j], 10));
        j++;
      }
      if (nums.length < 2) continue;
      const [orderedQty = nums[0], receivedQty = nums[1], acceptedQty = nums[2] ?? nums[1], rejectedQty = nums[3] ?? 0] = nums;
      items.push({
        itemCode: code,
        itemName: nameParts.join(' ').trim() || code,
        orderedQty,
        receivedQty,
        acceptedQty,
        rejectedQty,
      });
      i = j - 1;
    }
    return items;
  }

  /** Full-text row regex when each table row is on one line in the PDF text. */
  private extractLineItemsFromBlob(text: string): GrnExtractedLineItem[] {
    const items: GrnExtractedLineItem[] = [];
    const patterns = [
      /(?:^|\n)\s*(\d{1,3})\s+([A-Z0-9][A-Z0-9\-/_]{2,})\s+(.{3,80}?)\s+(\d{4,8})?\s*(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?/gim,
      /(?:^|\n)\s*(\d{1,3})\s+([A-Z0-9][A-Z0-9\-/_]{2,})\s+(.{3,80}?)\s+(\d+)\s+(\d+)(?:\s+[\d.]+)?(?:\s+[\d.]+)?/gim,
    ];
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const itemCode = m[2]?.trim();
        if (!itemCode) continue;
        const orderedQty = parseInt(m[5] ?? m[4], 10);
        const receivedQty = parseInt(m[6] ?? m[5] ?? m[4], 10);
        const acceptedQty = parseInt(m[7] ?? m[6] ?? m[5] ?? m[4], 10);
        const rejectedQty = parseInt(m[8] ?? '0', 10);
        items.push({
          itemCode,
          itemName: m[3]?.trim() || itemCode,
          hsnCode: m[4]?.trim(),
          orderedQty: Number.isFinite(orderedQty) ? orderedQty : 0,
          receivedQty: Number.isFinite(receivedQty) ? receivedQty : acceptedQty,
          acceptedQty: Number.isFinite(acceptedQty) ? acceptedQty : receivedQty,
          rejectedQty: Number.isFinite(rejectedQty) ? rejectedQty : 0,
        });
      }
      if (items.length) break;
    }
    return items;
  }

  /**
   * Extract GRN line items from the PDF table.
   *
   * Supports two table formats:
   *
   * Format A (full):
   *   Sr | Item Code | Description | HSN | Ordered Qty | Received Qty | Accepted Qty | Rejected Qty | Remarks
   *
   * Format B (minimal - delivery challan style):
   *   Sr | Item Code | Description | HSN | Qty | Rate | Amount
   *   (In this case received = ordered, accepted = ordered, rejected = 0)
   */
  private extractLineItems(text: string, lines: string[]): GrnExtractedLineItem[] {
    // Detect which format by checking header keywords
    const hasReceivedCol = /received\s*qty|received\s*quantity/i.test(text);

    if (hasReceivedCol) {
      return this.extractFullFormatItems(lines);
    }
    return this.extractMinimalFormatItems(lines);
  }

  /**
   * Full GRN format: rows start with a serial number and contain 4+ quantity columns.
   * Pattern: SR  ITEM_CODE  DESCRIPTION  [HSN]  ORDERED  RECEIVED  ACCEPTED  REJECTED  [REASON]
   */
  private extractFullFormatItems(lines: string[]): GrnExtractedLineItem[] {
    const items: GrnExtractedLineItem[] = [];
    // Find table header row to anchor the item rows
    const headerIdx = lines.findIndex((l) =>
      /item\s*code/i.test(l) && /received/i.test(l),
    );
    const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];

      // Row pattern: Sr(1-3digits) ItemCode Description [HSN] Ordered Received Accepted Rejected [Reason]
      // Try to match: starts with number, then alphanumeric code, then at least 4 integers
      const rowMatch = line.match(
        /^(\d{1,3})\s+([A-Z0-9\-\/]+)\s+(.*?)\s+(\d{6,8})?\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(.*))?$/i,
      );
      if (rowMatch) {
        const [, , itemCode, rawName, hsnCode, orderedQty, receivedQty, acceptedQty, rejectedQty, reason] = rowMatch;
        items.push({
          itemCode: itemCode.trim(),
          itemName: rawName.trim(),
          hsnCode: hsnCode?.trim(),
          orderedQty: parseInt(orderedQty, 10),
          receivedQty: parseInt(receivedQty, 10),
          acceptedQty: parseInt(acceptedQty, 10),
          rejectedQty: parseInt(rejectedQty, 10),
          rejectionReason: reason?.trim() || undefined,
        });
        continue;
      }

      // Simpler fallback: numeric row with at least 4 trailing numbers
      const simpleMatch = line.match(
        /^(\d{1,3})\s+([A-Z0-9\-\/]+)\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/i,
      );
      if (simpleMatch) {
        const [, , itemCode, rawName, orderedQty, receivedQty, acceptedQty, rejectedQty, reason] = simpleMatch;
        items.push({
          itemCode: itemCode.trim(),
          itemName: rawName.trim(),
          orderedQty: parseInt(orderedQty, 10),
          receivedQty: parseInt(receivedQty, 10),
          acceptedQty: parseInt(acceptedQty, 10),
          rejectedQty: parseInt(rejectedQty, 10),
          rejectionReason: reason?.trim() || undefined,
        });
      }
    }

    return items;
  }

  /**
   * Minimal / delivery challan format — no separate accepted/rejected columns.
   * Row: SR  ITEM_CODE  DESCRIPTION  [HSN]  QTY  [RATE  AMOUNT]
   * Assumes received = ordered, accepted = ordered, rejected = 0.
   */
  private extractMinimalFormatItems(lines: string[]): GrnExtractedLineItem[] {
    const items: GrnExtractedLineItem[] = [];
    const headerIdx = lines.findIndex((l) =>
      /item\s*(?:code|no)/i.test(l) && /(?:qty|quantity|amount)/i.test(l),
    );
    const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];

      // Row starting with serial number
      const rowMatch = line.match(
        /^(\d{1,3})\s+([A-Z0-9\-\/]+)\s+(.*?)\s+(\d{6,8})?\s*(\d+)(?:\s+[\d.]+)?(?:\s+[\d.]+)?\s*$/i,
      );
      if (rowMatch) {
        const [, , itemCode, rawName, hsnCode, qty] = rowMatch;
        const quantity = parseInt(qty, 10);
        items.push({
          itemCode: itemCode.trim(),
          itemName: rawName.trim(),
          hsnCode: hsnCode?.trim(),
          orderedQty: quantity,
          receivedQty: quantity,
          acceptedQty: quantity,
          rejectedQty: 0,
        });
      }
    }

    return items;
  }

  /** Normalize common date formats (dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy) → ISO YYYY-MM-DD */
  private normalizeDate(raw: string): string {
    const m = raw.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    if (m) {
      const [, d, mo, y] = m;
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    // Try ISO or already normalized
    const iso = new Date(raw);
    if (!isNaN(iso.getTime())) return iso.toISOString().slice(0, 10);
    return new Date().toISOString().slice(0, 10);
  }
}
