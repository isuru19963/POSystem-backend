import { Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import {
  PdfExtractionResult,
  ExtractedLineItem,
} from './pdf-extraction.service';
import { isOwnCompanyName } from './own-company';
import { isGarbageCustomerLabel } from '../../../common/utils/customer-name.util';

/**
 * XLS Extraction Service
 * Parses PO spreadsheets from multiple vendors:
 * - Cloudstore (.xls): Header rows with PO metadata + line item table
 * - Hyperpure (.xlsx): Simple table with Sl No., Product Number, Product Name, etc.
 * - Swiggy/MOONSTONE (.xlsx): Table with #, Item Code, HSN Code, Product UPC, etc.
 * - Zepto (.csv): CSV with PoNumber, VendorName, SkuDesc, etc.
 */
@Injectable()
export class XlsExtractionService {
  private readonly logger = new Logger(XlsExtractionService.name);

  extract(buffer: Buffer, filename?: string): PdfExtractionResult {
    this.logger.log(`Starting XLS/CSV extraction... (${filename || 'unknown'})`);

    // Handle CSV files
    if (filename?.toLowerCase().endsWith('.csv')) {
      const csvText = buffer.toString('utf-8');
      return this.parseZeptoCsv(csvText);
    }

    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const rows: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(
      sheet,
      { header: 1, defval: '' },
    );

    // Auto-detect format from headers
    const format = this.detectFormat(rows);
    this.logger.log(`Detected format: ${format}`);

    let result: PdfExtractionResult;
    switch (format) {
      case 'hyperpure':
        result = this.parseHyperpureSheet(rows);
        break;
      case 'swiggy':
        result = this.parseSwiggySheet(rows);
        break;
      case 'cloudstore':
      default:
        result = this.parseCloudstoreSheet(rows);
        break;
    }

    if (result.vendorName && this.isGarbageVendorLabel(result.vendorName)) {
      result.vendorName = '';
    }
    if (!result.vendorName?.trim()) {
      const fromSheet = this.findCloudstoreBuyerInRows(rows);
      if (fromSheet) result.vendorName = fromSheet;
    }

    this.logger.log(
      `Extracted PO ${result.poNumber} with ${result.lineItems.length} line items from XLS`,
    );

    return result;
  }

  private isGarbageVendorLabel(name: string): boolean {
    return isGarbageCustomerLabel(name);
  }

  private findCloudstoreBuyerInRows(
    rows: (string | number | undefined)[][],
  ): string {
    for (const row of rows) {
      for (const cell of row) {
        const s = String(cell ?? '');
        if (/CLOUDSTORE\s+RETAIL\s+PRIVATE\s+LIMITED/i.test(s)) {
          return 'Cloudstore Retail Private Limited';
        }
      }
    }
    return '';
  }

  private detectFormat(rows: (string | number | undefined)[][]): string {
    // Check first few rows for distinctive headers
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const joined = rows[i].map(v => String(v ?? '').toLowerCase()).join(' ');
      if (joined.includes('sl no') && joined.includes('product number') && joined.includes('price per unit')) {
        return 'hyperpure';
      }
      if (joined.includes('product upc') && joined.includes('product description') && joined.includes('landing rate')) {
        return 'swiggy';
      }
    }
    return 'cloudstore';
  }

  // ==================== HYPERPURE ====================
  private parseHyperpureSheet(rows: (string | number | undefined)[][]): PdfExtractionResult {
    // Row 0: headers — Sl No., Product Number, Product Name, HSN code, Qty. Ord., MRP Margin, Margin%, Desc., Price Per Unit, UoM, GST Rate, Total Tax Amount, Total
    const headerRow = rows[0]?.map(v => String(v ?? '').trim()) || [];
    const colIdx = this.mapColumns(headerRow, {
      slNo: /sl\s*no/i,
      productNumber: /product\s*number/i,
      productName: /product\s*name/i,
      hsnCode: /hsn\s*code/i,
      qty: /qty.*ord/i,
      mrpMargin: /mrp\s*margin/i,
      pricePerUnit: /price\s*per\s*unit/i,
      gstRate: /gst\s*rate/i,
      totalTax: /total\s*tax/i,
      total: /^total$/i,
    });

    const lineItems: ExtractedLineItem[] = [];
    let grandTotal = 0;
    let totalTax = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const slNo = row[colIdx.slNo];

      // Skip total row
      if (String(slNo).toLowerCase() === 'total') {
        grandTotal = this.num(row[colIdx.total]);
        totalTax = this.num(row[colIdx.totalTax]);
        continue;
      }

      if (typeof slNo !== 'number' || slNo < 1) continue;

      lineItems.push({
        skuCode: String(row[colIdx.productNumber] ?? ''),
        skuName: String(row[colIdx.productName] ?? ''),
        hsnCode: String(row[colIdx.hsnCode] ?? ''),
        quantity: this.num(row[colIdx.qty]),
        price: this.num(row[colIdx.pricePerUnit]),
        mrp: this.num(row[colIdx.mrpMargin]) || undefined,
        total: this.num(row[colIdx.total]),
      });
    }

    return {
      vendorName: '',
      poNumber: '',
      poDate: '',
      shippingLocation: '',
      lineItems,
      grandTotal: grandTotal || undefined,
      totalTax: totalTax || undefined,
    };
  }

  // ==================== SWIGGY/MOONSTONE ====================
  private parseSwiggySheet(rows: (string | number | undefined)[][]): PdfExtractionResult {
    // Row 0: headers — #, Item Code, HSN Code, Product UPC, Product Description, Grammage, Basic Cost Price, CGST %, SGST %, IGST %, CESS %, Additional CES, Tax Amount, Landing Rate, Quantity, MRP, Margin %, Total Amount
    const headerRow = rows[0]?.map(v => String(v ?? '').trim()) || [];
    const colIdx = this.mapColumns(headerRow, {
      slNo: /^#$/,
      itemCode: /item\s*code/i,
      hsnCode: /hsn\s*code/i,
      productUpc: /product\s*upc/i,
      productDesc: /product\s*desc/i,
      grammage: /grammage/i,
      basicCost: /basic\s*cost/i,
      cgst: /cgst/i,
      sgst: /sgst/i,
      igst: /igst/i,
      taxAmount: /tax\s*amount/i,
      landingRate: /landing\s*rate/i,
      quantity: /quantity/i,
      mrp: /^mrp$/i,
      totalAmount: /total\s*amount/i,
    });

    const lineItems: ExtractedLineItem[] = [];
    let grandTotal = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const slNo = row[colIdx.slNo];

      // Summary rows (slNo is empty) — scan for Total Amount / Net amount
      if (slNo === null || slNo === undefined || slNo === '' || (typeof slNo === 'string' && !/^\d+$/.test(slNo))) {
        const cells = row.map(v => String(v ?? ''));
        for (let c = 0; c < cells.length; c++) {
          if (/Net\s*amount|Total\s*Amount/i.test(cells[c])) {
            // Next non-empty cell is the value
            for (let j = c + 1; j < cells.length; j++) {
              const val = this.num(cells[j]);
              if (val > 0) { grandTotal = val; break; }
            }
          }
        }
        continue;
      }

      if (typeof slNo !== 'number' || slNo < 1) continue;

      lineItems.push({
        skuCode: String(row[colIdx.itemCode] ?? ''),
        skuName: String(row[colIdx.productDesc] ?? ''),
        hsnCode: String(row[colIdx.hsnCode] ?? ''),
        quantity: this.num(row[colIdx.quantity]),
        price: this.num(row[colIdx.basicCost]),
        mrp: this.num(row[colIdx.mrp]) || undefined,
        taxableValue: this.num(row[colIdx.totalAmount]) || undefined,
        cgstRate: this.num(row[colIdx.cgst]) || undefined,
        sgstRate: this.num(row[colIdx.sgst]) || undefined,
        igstRate: this.num(row[colIdx.igst]) || undefined,
        total: this.num(row[colIdx.totalAmount]),
      });
    }

    return {
      vendorName: '',
      poNumber: '',
      poDate: '',
      shippingLocation: '',
      lineItems,
      grandTotal: grandTotal || undefined,
    };
  }

  // ==================== ZEPTO (CSV) ====================
  private parseZeptoCsv(csvText: string): PdfExtractionResult {
    const lines = csvText.split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      return { vendorName: '', poNumber: '', poDate: '', shippingLocation: '', lineItems: [] };
    }

    // Parse CSV headers - handle quoted fields
    const headers = this.parseCsvLine(lines[0]);
    const colIdx: Record<string, number> = {};
    headers.forEach((h, i) => { colIdx[h.trim()] = i; });

    const lineItems: ExtractedLineItem[] = [];
    let vendorName = '';
    let poNumber = '';
    let poDate = '';
    let deliveryLocation = '';
    let grandTotal = 0;

    for (let i = 1; i < lines.length; i++) {
      const fields = this.parseCsvLine(lines[i]);
      if (fields.length < 10) continue;

      const getField = (name: string) => fields[colIdx[name]] ?? '';

      if (!poNumber) poNumber = getField('PoNumber');
      if (!vendorName) vendorName = getField('VendorName');
      if (!poDate) poDate = getField('PoDate');
      if (!deliveryLocation) deliveryLocation = getField('DeliveryLocation');
      if (!grandTotal) grandTotal = parseFloat(getField('PoTotalAmount')) || 0;

      const qty = parseFloat(getField('Quantity')) || 0;
      if (qty <= 0) continue;

      lineItems.push({
        skuCode: getField('MaterialCode'),
        skuName: getField('SkuDesc'),
        hsnCode: getField('HSN'),
        quantity: qty,
        price: parseFloat(getField('UnitBaseCost')) || 0,
        mrp: parseFloat(getField('MRP')) || undefined,
        cgstRate: parseFloat(getField('CGSTPercentage')) || undefined,
        sgstRate: parseFloat(getField('SGSTPercentage')) || undefined,
        igstRate: parseFloat(getField('IGSTPercentage')) || undefined,
        total: parseFloat(getField('TotalAmount')) || undefined,
      });
    }

    // In Zepto CSVs, "VendorName" is OUR company (Deccan Agro = the seller).
    // The actual customer issuing the PO is Zepto, so override when our own
    // name accidentally appears as the vendor.
    const finalVendorName =
      vendorName && !isOwnCompanyName(vendorName) ? vendorName : 'Zepto';

    return {
      vendorName: finalVendorName,
      poNumber,
      poDate,
      shippingLocation: deliveryLocation,
      lineItems,
      grandTotal: grandTotal || undefined,
    };
  }

  private parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return fields;
  }

  private parseCloudstoreSheet(
    rows: (string | number | undefined)[][],
  ): PdfExtractionResult {
    const getString = (row: (string | number | undefined)[]): string[] =>
      row.map((v) => String(v ?? '').trim());

    // Parse header fields
    let poNumber = '';
    let poDate = '';
    let expectedDeliveryDate: string | undefined;
    let expiryDate: string | undefined;
    let paymentTerms: string | undefined;
    let vendorName = '';
    let vendorGstin: string | undefined;
    let shippingLocation = '';
    let billingAddress: string | undefined;
    let shippingAddress: string | undefined;

    let headerRowIdx = -1;
    let dataStartIdx = -1;

    for (let i = 0; i < rows.length; i++) {
      const cells = getString(rows[i]);
      const joined = cells.join(' ');

      // Check Billing/Shipping Address FIRST (before Vendor Name search) so company name gets priority
      if (cells.some((c) => /Billing\s*Address/i.test(c))) {
        // Next row has the addresses
        if (i + 1 < rows.length) {
          const addrCells = getString(rows[i + 1]);
          // Find the company names in billing/shipping addresses
          for (let c = 0; c < addrCells.length; c++) {
            if (addrCells[c].includes('CLOUDSTORE') || addrCells[c].includes('ENTERPRISE') || addrCells[c].includes('MOKSH')) {
              if (!billingAddress) {
                billingAddress = addrCells[c];
                // Extract company name from billing address (first line before newline or address details)
                const companyName = addrCells[c].split('\n')[0].trim();
                // Skip if billing address shows our own company (we are the seller, not the buyer)
                if (companyName && !isOwnCompanyName(companyName)) {
                  // ALWAYS use billing address company name - override supplier name
                  vendorName = companyName;
                }
              } else if (!shippingAddress) {
                shippingAddress = addrCells[c];
              }
            }
          }
          const addr = shippingAddress || billingAddress;
          if (addr) {
            shippingLocation = this.extractLocationFromAddress(addr);
          }
        }
      }

      // Search through all cells for key-value patterns
      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c];
        // Find the next non-empty cell as value
        const nextVal = this.findNextNonEmpty(cells, c + 1);

        // Only extract "Vendor Name:" if we haven't found vendor from billing address yet
        if (/Vendor\s*Name/i.test(cell) && nextVal && !vendorName) {
          if (!isOwnCompanyName(nextVal)) {
            vendorName = nextVal;
          }
        }

        if (/PO\s*No/i.test(cell) && nextVal) {
          // PO number may be a few cells away
          const poVal = this.findNextNonEmpty(cells, c + 1);
          if (poVal && /^CMP/i.test(poVal)) {
            poNumber = poVal;
          } else if (poVal) {
            poNumber = poVal;
          }
        }

        if (/^PO\s*Date/i.test(cell) && nextVal) {
          poDate = nextVal;
        }

        if (/Expected\s*Delivery/i.test(cell) && nextVal) {
          expectedDeliveryDate = this.excelDateToString(nextVal);
        }

        if (/PO\s*Expiry/i.test(cell) && nextVal) {
          expiryDate = nextVal;
        }

        if (/Payment\s*Terms/i.test(cell) && nextVal) {
          paymentTerms = nextVal;
        }
      }

      // Vendor info block (multi-line cell with GSTIN, not CLOUDSTORE) - fallback if vendorName not set
      if (!vendorName) {
        for (const cell of cells) {
          if (
            cell.includes('GSTIN') &&
            !cell.includes('CLOUDSTORE') &&
            cell.length > 50
          ) {
            const vendorLines = cell.split('\n').map((l) => l.trim());
            const candidate = vendorLines[0] || '';
            // Skip our own company; keep looking for the actual buyer.
            if (candidate && !isOwnCompanyName(candidate)) {
              const gstMatch = cell.match(/GSTIN\s*:(\S+)/i);
              if (gstMatch) vendorGstin = gstMatch[1];
              vendorName = candidate;
            }
          }
        }
      }

      // Detect header row (S. / S.No / Item Code)
      if (
        cells[0]?.match(/^S\.?$/i) &&
        joined.match(/Item\s*Code/i)
      ) {
        headerRowIdx = i;
      }

      // Data rows start after the header sub-row
      if (headerRowIdx >= 0 && i === headerRowIdx + 1) {
        if (cells[0]?.match(/^No$/i) || joined.match(/Rate/i)) {
          dataStartIdx = i + 1;
        } else {
          dataStartIdx = i;
        }
      }
    }

    // Parse line items using actual column positions
    const lineItems: ExtractedLineItem[] = [];

    if (dataStartIdx > 0) {
      // Detect column indices from the header row
      const colMap = this.detectColumnIndices(
        getString(rows[headerRowIdx]),
      );

      for (let i = dataStartIdx; i < rows.length; i++) {
        const cells = getString(rows[i]);

        // Stop at totals/empty rows
        if (!cells[0] || !/^\d+$/.test(cells[0])) {
          if (
            cells.some((c) => /Total\s*Amount|Grand\s*Total/i.test(c))
          ) {
            break;
          }
          if (cells.filter((c) => c).length < 3) continue;
          continue;
        }

        const item = this.parseLineItemRow(cells, colMap);
        if (item) lineItems.push(item);
      }
    }

    // Parse grand total
    let grandTotal: number | undefined;
    let totalTax: number | undefined;
    for (const row of rows) {
      const cells = getString(row);
      for (let c = 0; c < cells.length; c++) {
        if (/Grand\s*Total/i.test(cells[c])) {
          const val = this.findNextNonEmpty(cells, c + 1);
          if (val) grandTotal = parseFloat(val.replace(/,/g, ''));
        }
        if (/Total\s*Tax\s*\(INR\)/i.test(cells[c])) {
          const val = this.findNextNonEmpty(cells, c + 1);
          if (val) totalTax = parseFloat(val.replace(/,/g, ''));
        }
      }
    }

    return {
      vendorName,
      vendorGstin,
      poNumber,
      poDate,
      expectedDeliveryDate,
      expiryDate,
      paymentTerms,
      shippingLocation,
      billingAddress,
      shippingAddress,
      lineItems,
      grandTotal,
      totalTax,
    };
  }

  /** Find the next non-empty cell starting from index */
  private findNextNonEmpty(
    cells: string[],
    startIdx: number,
  ): string | undefined {
    for (let i = startIdx; i < cells.length; i++) {
      if (cells[i]) return cells[i];
    }
    return undefined;
  }

  /** Detect column indices from the header row */
  private detectColumnIndices(
    headerCells: string[],
  ): Record<string, number> {
    const map: Record<string, number> = {};
    for (let i = 0; i < headerCells.length; i++) {
      const cell = headerCells[i].toLowerCase();
      if (/^s\.?$/.test(cell)) map['sno'] = i;
      if (/item\s*code/i.test(cell)) map['itemCode'] = i;
      if (/item\s*desc/i.test(cell)) map['itemDesc'] = i;
      if (/hsn/i.test(cell)) map['hsnCode'] = i;
      if (/^qty$/i.test(cell)) map['qty'] = i;
      if (/^mrp$/i.test(cell)) map['mrp'] = i;
      if (/unit\s*base/i.test(cell)) map['unitCost'] = i;
      if (/taxable\s*value/i.test(cell)) map['taxableValue'] = i;
      if (/^cgst$/i.test(cell)) map['cgstRate'] = i;
      if (/sgst/i.test(cell)) map['sgstRate'] = i;
      if (/^igst$/i.test(cell)) map['igstRate'] = i;
      if (/^cess$/i.test(cell)) map['cessRate'] = i;
      if (/total\s*\(inr\)/i.test(cell)) map['total'] = i;
    }
    return map;
  }

  /**
   * Parse a single line item row using detected column positions
   * Column layout varies per spreadsheet, so we use the colMap from headers
   * Fallback: parse by sequential non-empty numeric cells
   */
  private parseLineItemRow(
    cells: string[],
    colMap: Record<string, number>,
  ): ExtractedLineItem | null {
    if (cells.length < 7) return null;

    // Use column map if available, otherwise use positional approach
    const itemCode =
      cells[colMap['itemCode']] || this.findByOffset(cells, 1);
    if (!itemCode) return null;

    const skuName = (cells[colMap['itemDesc']] || this.findByOffset(cells, 2))
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*Colour:.*$/i, '')
      .trim();

    // For quantity and price, find them from known positions or by scanning
    const qty = this.parseNum(
      cells[colMap['qty']] || this.findFirstNumber(cells, 4),
    );
    if (qty <= 0) return null;

    const mrp = this.parseNum(
      cells[colMap['mrp']] || this.findByOffset(cells, 6),
    );
    const unitCost = this.parseNum(
      cells[colMap['unitCost']] || this.findByOffset(cells, 7),
    );
    const taxableValue = this.parseNum(
      cells[colMap['taxableValue']] || this.findByOffset(cells, 9),
    );

    // Find total — it's the last significant number in the row
    const total = this.parseNum(
      cells[colMap['total']] || this.findLastNumber(cells),
    );

    // Tax rates — from colMap or sequential
    const cgstRate = this.parseNum(
      cells[colMap['cgstRate']] || '',
    );
    const sgstRate = this.parseNum(
      cells[colMap['sgstRate']] || '',
    );
    const igstRate = this.parseNum(
      cells[colMap['igstRate']] || '',
    );

    return {
      skuCode: itemCode,
      skuName,
      hsnCode: cells[colMap['hsnCode']] || this.findByOffset(cells, 3) || undefined,
      quantity: qty,
      mrp: mrp || undefined,
      price: unitCost,
      taxableValue: taxableValue || undefined,
      cgstRate: cgstRate || undefined,
      sgstRate: sgstRate || undefined,
      igstRate: igstRate || undefined,
      total: total || undefined,
    };
  }

  /** Find cell by offset index, skipping empties */
  private findByOffset(cells: string[], offset: number): string {
    return cells[offset] || '';
  }

  /** Find first numeric-looking cell starting from index */
  private findFirstNumber(
    cells: string[],
    startIdx: number,
  ): string {
    for (let i = startIdx; i < cells.length; i++) {
      if (cells[i] && /^[\d,.]+$/.test(cells[i])) return cells[i];
    }
    return '';
  }

  /** Find last numeric-looking cell in the row */
  private findLastNumber(cells: string[]): string {
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i] && /^[\d,.]+$/.test(cells[i])) return cells[i];
    }
    return '';
  }

  private parseNum(value: string | undefined): number {
    if (!value) return 0;
    const cleaned = value.replace(/,/g, '').trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  /** Convert Excel serial date number or ISO string to date string */
  private excelDateToString(dateStr: string): string {
    // Handle Excel serial date number (e.g., 46113)
    if (/^\d{4,5}$/.test(dateStr)) {
      const serial = parseInt(dateStr, 10);
      // Excel epoch: Jan 1, 1900
      const msPerDay = 24 * 60 * 60 * 1000;
      const excelEpoch = new Date(1899, 11, 30).getTime(); // Dec 30, 1899
      const date = new Date(excelEpoch + serial * msPerDay);
      return date.toISOString().split('T')[0];
    }
    // Handle ISO format: "2026-04-01T00:00:00.000"
    if (dateStr.includes('T')) {
      return dateStr.split('T')[0];
    }
    return dateStr;
  }

  private extractLocationFromAddress(address: string): string {
    // Extract warehouse code like "CLDST MUM FnV2"
    const whMatch = address.match(/CLDST\s+\S+\s+\S+/i);
    if (whMatch) return whMatch[0].trim();

    // Fallback: extract city/state from address
    const locMatch = address.match(/([A-Za-z]+),\s*[A-Za-z\s]+-\s*\d{6}/);
    if (locMatch) return locMatch[0].trim();

    return address.split('\n')[0] || '';
  }

  // ==================== HELPERS ====================
  private mapColumns(headerRow: string[], patterns: Record<string, RegExp>): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, pattern] of Object.entries(patterns)) {
      const idx = headerRow.findIndex(h => pattern.test(h));
      result[key] = idx >= 0 ? idx : -1;
    }
    return result;
  }

  private num(val: string | number | undefined): number {
    if (val === undefined || val === null || val === '') return 0;
    if (typeof val === 'number') return val;
    const cleaned = String(val).replace(/,/g, '').trim();
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n;
  }
}
