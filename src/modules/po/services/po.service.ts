import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, FindOptionsWhere, In, ILike } from 'typeorm';
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
import { ValidationService } from '../../validation/services/validation.service';
import { messageIdSearchVariants } from '../../../common/utils/email-message-id.util';

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
    private readonly validationService: ValidationService,
  ) {}

  async findAll(query: QueryPoDto): Promise<PurchaseOrder[]> {
    const baseWhere: FindOptionsWhere<PurchaseOrder> = {};

    if (query.status) baseWhere.status = query.status;
    if (query.vendorId) baseWhere.vendorId = query.vendorId;
    if (query.poNumber) baseWhere.poNumber = query.poNumber;
    if (query.fromDate && query.toDate) {
      baseWhere.poDate = Between(new Date(query.fromDate), new Date(query.toDate));
    }

    const search = query.search?.trim();
    let where: FindOptionsWhere<PurchaseOrder> | FindOptionsWhere<PurchaseOrder>[] = baseWhere;
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
    return po;
  }

  /** Check for duplicate PO by poNumber + vendorId */
  async isDuplicate(poNumber: string, vendorId: string): Promise<boolean> {
    const existing = await this.poRepo.findOne({
      where: { poNumber, vendorId },
    });
    return !!existing;
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
    // Defensive guard: if extraction accidentally returned our own company as
    // the customer/vendor, fall back to a placeholder so we never persist
    // ourselves as the buyer. This complements the per-extractor filters.
    if (isOwnCompanyName(data.vendorName)) {
      this.logger.warn(
        `Vendor name "${data.vendorName}" matched our own company; saving as "Unknown Customer".`,
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

    // Auto-validate against pricing rules as soon as PO is created.
    // Keep PO creation resilient even if validation fails.
    try {
      await this.validationService.validatePo(savedPo.id);
    } catch (err) {
      this.logger.error(
        `Auto-validation failed for PO ${savedPo.poNumber}: ${(err as Error)?.message}`,
      );
    }

    const fullPo = await this.findById(savedPo.id);
    // Fire-and-forget — don't block PO creation on WhatsApp send
    void this.sendPoWhatsAppNotification(fullPo);
    return fullPo;
  }

  private async sendPoWhatsAppNotification(po: PurchaseOrder): Promise<void> {
    try {
      const contacts = await this.notifContactRepo.find({ where: { isActive: true } });
      if (!contacts.length) return;

      const dateStr = po.poDate
        ? new Date(po.poDate).toLocaleDateString('en-IN')
        : '';
      const totalStr = po.totalAmount != null
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

      await Promise.all(
        contacts.map((c) =>
          this.whatsappService.sendMessage(c.phone, message).catch((err) => {
            this.logger.warn(`WhatsApp notify failed for ${c.phone}: ${err?.message}`);
          }),
        ),
      );
    } catch (err) {
      this.logger.warn(`WhatsApp PO notification error: ${(err as Error)?.message}`);
    }
  }

  async updateStatus(id: string, status: PoStatus): Promise<PurchaseOrder> {
    const po = await this.findById(id);
    po.status = status;
    return this.poRepo.save(po);
  }

  async removeById(id: string): Promise<{ success: true; message: string; id: string }> {
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
    const [deliveryLineItems, deliveries, grnLineItems, grns, poLineItems, purchaseOrders] = await Promise.all([
      this.deliveryLineItemRepo.count(),
      this.deliveryRepo.count(),
      this.grnLineItemRepo.count(),
      this.grnRepo.count(),
      this.lineItemRepo.count(),
      this.poRepo.count(),
    ]);

    await this.deliveryLineItemRepo
      .createQueryBuilder()
      .delete()
      .execute();

    await this.grnLineItemRepo
      .createQueryBuilder()
      .delete()
      .execute();

    await this.deliveryRepo
      .createQueryBuilder()
      .delete()
      .execute();

    await this.grnRepo
      .createQueryBuilder()
      .delete()
      .execute();

    await this.lineItemRepo
      .createQueryBuilder()
      .delete()
      .execute();

    await this.poRepo
      .createQueryBuilder()
      .delete()
      .execute();

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
