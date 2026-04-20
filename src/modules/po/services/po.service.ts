import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, FindOptionsWhere } from 'typeorm';
import {
  PurchaseOrder,
  PoStatus,
  Vendor,
  PurchaseOrderLineItem,
  Sku,
} from '../../../database/entities';
import { QueryPoDto } from '../dto/query-po.dto';
import { ExtractedLineItem } from './pdf-extraction.service';

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
  ) {}

  async findAll(query: QueryPoDto): Promise<PurchaseOrder[]> {
    const where: FindOptionsWhere<PurchaseOrder> = {};

    if (query.status) where.status = query.status;
    if (query.vendorId) where.vendorId = query.vendorId;
    if (query.poNumber) where.poNumber = query.poNumber;
    if (query.fromDate && query.toDate) {
      where.poDate = Between(new Date(query.fromDate), new Date(query.toDate));
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
    return po;
  }

  /** Check for duplicate PO by poNumber + vendorId */
  async isDuplicate(poNumber: string, vendorId: string): Promise<boolean> {
    const existing = await this.poRepo.findOne({
      where: { poNumber, vendorId },
    });
    return !!existing;
  }

  /** Check for duplicate by email message ID */
  async isDuplicateEmail(emailMessageId: string): Promise<boolean> {
    const existing = await this.poRepo.findOne({
      where: { emailMessageId },
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
        // Try to resolve SKU by code
        const sku = await this.skuRepo.findOne({
          where: { code: item.skuCode },
        });

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

    return this.findById(savedPo.id);
  }

  async updateStatus(id: string, status: PoStatus): Promise<PurchaseOrder> {
    const po = await this.findById(id);
    po.status = status;
    return this.poRepo.save(po);
  }
}
