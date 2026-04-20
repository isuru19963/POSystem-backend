import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Grn,
  GrnLineItem,
  GrnStatus,
  PurchaseOrder,
  Delivery,
} from '../../../database/entities';
import { AlertsService } from '../../alerts/services/alerts.service';
import { AlertType } from '../../../database/entities';

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
  ) {}

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
        const current = deliveryTotals.get(li.skuId) || 0;
        deliveryTotals.set(li.skuId, current + li.deliveredQuantity);
      }
    }

    let allMatched = true;
    const items: ThreeWayMatchResult['items'] = [];

    for (const grnItem of grn.lineItems) {
      const poItem = po.lineItems.find((li) => li.skuId === grnItem.skuId);
      const deliveredQty = deliveryTotals.get(grnItem.skuId) || 0;

      const isMatch =
        poItem &&
        poItem.quantity === deliveredQty &&
        deliveredQty === grnItem.acceptedQuantity;

      if (!isMatch) allMatched = false;

      items.push({
        skuCode: grnItem.sku?.code || grnItem.skuId,
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

  async findAll(): Promise<Grn[]> {
    return this.grnRepo.find({
      relations: ['purchaseOrder', 'lineItems'],
      order: { createdAt: 'DESC' },
    });
  }
}
