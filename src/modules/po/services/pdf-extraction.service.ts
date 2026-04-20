import { Injectable, Logger } from '@nestjs/common';

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
}

/**
 * PDF Extraction Service
 * Parses Cloudstore Retail PO PDFs using pdf-parse v2 (PDFParse class)
 */
@Injectable()
export class PdfExtractionService {
  private readonly logger = new Logger(PdfExtractionService.name);

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

    const result = format === 'hyperpure'
      ? this.parseHyperpurePo(text)
      : this.parseCloudstorePo(text);
    result.rawText = text;

    this.logger.log(
      `Extracted PO ${result.poNumber} with ${result.lineItems.length} line items`,
    );
    return result;
  }

  private detectFormat(text: string): string {
    if (/hyperpure/i.test(text) && /Purchase Order Number/i.test(text)) {
      return 'hyperpure';
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

    const poNumber = getNextLineValue(/^Purchase Order Number$/i);
    const poDate = getNextLineValue(/^Purchase Order Date$/i);
    const expectedDeliveryDate = getNextLineValue(/^Expected Delivery Date$/i);

    // Vendor: "Bill From : VENDOR NAME"
    const billFromMatch = text.match(/Bill From\s*:\s*(.+?)(?:\s*Shipped|$)/im);
    const vendorName = billFromMatch ? billFromMatch[1].trim() : '';

    // GSTIN from Bill From section (first GSTIN in file)
    const gstinMatch = text.match(/GSTIN\s*:\s*(\S+)/i);
    const vendorGstin = gstinMatch ? gstinMatch[1] : undefined;

    // Vendor address
    const vendorAddrMatch = text.match(/Bill From[\s\S]*?Address\s*:\s*([\s\S]*?)(?:GSTIN|Phone)/i);
    const vendorAddress = vendorAddrMatch
      ? vendorAddrMatch[1].replace(/\n/g, ', ').replace(/\s+/g, ' ').trim()
      : undefined;

    // Shipped To: "Zomato Hyperpure Pvt Ltd (CPC-MUM5)" — extract location code
    // Bill To and Shipped To may be tab-separated on the same line
    const shippedToMatch = text.match(/Shipped To\s*:\s*\n?\s*(.+)/i);
    let shippedTo = shippedToMatch ? shippedToMatch[1].trim() : '';
    // If tab-separated (Bill To \t Shipped To), take last part
    if (shippedTo.includes('\t')) {
      shippedTo = shippedTo.split('\t').pop()?.trim() || shippedTo;
    }

    // Extract CPC code like CPC-MUM5, CPC-PUNE3, HYD3, etc.
    const cpcMatch = shippedTo.match(/\(([A-Z]+-[A-Z0-9]+|[A-Z]+\d+)\)/i);
    const shippingLocation = cpcMatch ? cpcMatch[1] : shippedTo;

    // Shipping address
    const shipAddrMatch = text.match(/Shipped To\s*:[\s\S]*?Address\s*:\s*([\s\S]*?)(?:State|Phone|GSTIN)/i);
    const shippingAddress = shipAddrMatch
      ? shipAddrMatch[1].replace(/\n/g, ', ').replace(/\s+/g, ' ').trim()
      : undefined;

    // Grand total: "Total\t1658\t185834.7" — last number on the Total line
    const totalMatch = text.match(/^Total\s+[\d,]+\s+([\d,.]+)/m);
    const grandTotal = totalMatch
      ? parseFloat(totalMatch[1].replace(/,/g, ''))
      : undefined;

    // Line items: "155482 BH-dr Good... 04071100 - - 241 175.5 Per piece 0 0 42295.5"
    const lineItems = this.extractHyperpureLineItems(text);

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

    // Vendor name is typically before the address block, after "Reference PO Code"
    const vendorName = this.extractVendorName(lines);
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
            !/^CLOUDSTORE/i.test(line)
          ) {
            return line;
          }
        }
      }
    }
    // Fallback: look for "Vendor Name :" pattern
    for (const line of lines) {
      const m = line.match(/Vendor\s*Name\s*:\s*(.+)/i);
      if (m) return m[1].trim();
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

    // Find the line items section between the table header and "Total Amount"
    // In the Cloudstore PDF, line items are between "Total (INR)" (last header) and "Total Amount (INR)"
    const sectionMatch = text.match(
      /Amt\s*\(INR\)\s*([\s\S]*?)(?:\d[\d,.]+\s+\d[\d,.]+\s+\d[\d,.]+\s+\d[\d,.]+\s+\d[\d,.]+\s+\d[\d,.]+\s+[\d,.]+\n\s*Total\s*Amount)/i,
    );

    const section = sectionMatch ? sectionMatch[1] : text;

    // Look for pattern: serial_number item_code description hsn_code qty mrp unit_cost taxable_value ...taxes... total
    // In the Cloudstore PDF text, each line item spans multiple lines and ends with
    // HSN code followed by numeric values on the same line
    const lineItemPattern =
      /(\d+)\s+(\d{4,6})\s+([\s\S]*?)(\d{8})\s+([\d]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g;

    let match: RegExpExecArray | null;
    while ((match = lineItemPattern.exec(section)) !== null) {
      // Clean description
      const desc = match[3]
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s*Colour:.*$/i, '')
        .trim();

      items.push({
        skuCode: match[2],
        skuName: desc,
        hsnCode: match[4],
        quantity: parseInt(match[5], 10),
        mrp: parseFloat(match[6]),
        price: parseFloat(match[7]),
        taxableValue: parseFloat(match[8]),
        cgstRate: parseFloat(match[9]),
        cgstAmount: parseFloat(match[10]),
        sgstRate: parseFloat(match[11]),
        sgstAmount: parseFloat(match[12]),
        igstRate: parseFloat(match[13]),
        igstAmount: parseFloat(match[14]),
        total: parseFloat(match[18]),
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
