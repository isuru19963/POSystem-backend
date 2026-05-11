import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PurchaseOrder,
  PurchaseOrderLineItem,
  LineItemValidationStatus,
  PoStatus,
  ShippingLocationMapping,
  Delivery,
  DeliveryLineItem,
  DispatchStatus,
  Consolidation,
  Route,
} from '../../../database/entities';
import { PricingService } from '../../pricing/services/pricing.service';
import { AlertsService } from '../../alerts/services/alerts.service';
import { EmailService } from '../../../email/email.service';
import { AlertType } from '../../../database/entities';
import { EGGS_PER_CRATE } from '../../../common/constants/app.constants';

export interface ValidationResult {
  poId: string;
  isValid: boolean;
  lineResults: Array<{
    lineItemId: string;
    skuCode: string;
    poPrice: number;
    calculatedPrice: number;
    variance: number;
    status: LineItemValidationStatus;
  }>;
}

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepo: Repository<PurchaseOrder>,
    @InjectRepository(PurchaseOrderLineItem)
    private readonly lineItemRepo: Repository<PurchaseOrderLineItem>,
    @InjectRepository(ShippingLocationMapping)
    private readonly locationMappingRepo: Repository<ShippingLocationMapping>,
    @InjectRepository(Delivery)
    private readonly deliveryRepo: Repository<Delivery>,
    @InjectRepository(DeliveryLineItem)
    private readonly deliveryLineItemRepo: Repository<DeliveryLineItem>,
    @InjectRepository(Consolidation)
    private readonly consolidationRepo: Repository<Consolidation>,
    @InjectRepository(Route)
    private readonly routeRepo: Repository<Route>,
    private readonly pricingService: PricingService,
    private readonly alertsService: AlertsService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Validate all line items in a PO against calculated prices
   * If mismatch → trigger WhatsApp alert + email draft
   */
  async validatePo(poId: string): Promise<ValidationResult> {
    const po = await this.poRepo.findOne({
      where: { id: poId },
      relations: ['lineItems', 'lineItems.sku', 'vendor'],
    });

    if (!po) throw new Error(`PO ${poId} not found`);

    // Resolve NECC city from shipping location
    const locationMapping = await this.locationMappingRepo.findOne({
      where: { shippingLocation: po.shippingLocation },
    });
    const city = locationMapping?.neccCity || po.shippingLocation;

    const lineResults: ValidationResult['lineResults'] = [];
    let allValid = true;

    for (const lineItem of po.lineItems) {
      try {
        if (!lineItem.sku) {
          this.logger.warn(
            `Line item ${lineItem.id} has no resolved SKU — skipping (treating as valid)`,
          );
          lineItem.validationStatus = LineItemValidationStatus.VALID;
          await this.lineItemRepo.save(lineItem);
          lineResults.push({
            lineItemId: lineItem.id,
            skuCode: lineItem.itemCode || 'UNKNOWN',
            poPrice: Number(lineItem.poPrice),
            calculatedPrice: Number(lineItem.poPrice),
            variance: 0,
            status: LineItemValidationStatus.VALID,
          });
          continue;
        }

        const calculated = await this.pricingService.calculatePrice(
          po.vendorId,
          lineItem.sku,
          po.poDate,
          city,
          po.shippingLocation,
        );

        const variance = Number(lineItem.poPrice) - calculated.price;
        const isMatch = Math.abs(variance) < 0.01; // Allow ₹0.01 tolerance

        lineItem.calculatedPrice = calculated.price;
        lineItem.priceVariance = variance;
        lineItem.validationStatus = isMatch
          ? LineItemValidationStatus.VALID
          : LineItemValidationStatus.MISMATCH;

        await this.lineItemRepo.save(lineItem);

        if (!isMatch) allValid = false;

        lineResults.push({
          lineItemId: lineItem.id,
          skuCode: lineItem.sku.code,
          poPrice: Number(lineItem.poPrice),
          calculatedPrice: calculated.price,
          variance,
          status: lineItem.validationStatus,
        });
      } catch (error) {
        const msg = String(error);
        // If no pricing rule is configured yet, skip validation (treat as valid)
        if (msg.includes('No active pricing rule') || msg.includes('pricing rule not found')) {
          this.logger.warn(
            `No pricing rule for line item ${lineItem.id} — skipping (treating as valid)`,
          );
          lineItem.validationStatus = LineItemValidationStatus.VALID;
          await this.lineItemRepo.save(lineItem);
          lineResults.push({
            lineItemId: lineItem.id,
            skuCode: lineItem.sku?.code || lineItem.itemCode,
            poPrice: Number(lineItem.poPrice),
            calculatedPrice: Number(lineItem.poPrice),
            variance: 0,
            status: LineItemValidationStatus.VALID,
          });
        } else {
          this.logger.error(
            `Failed to validate line item ${lineItem.id}: ${error}`,
          );
          allValid = false;
        }
      }
    }

    // Update PO status
    po.status = allValid ? PoStatus.VALIDATED : PoStatus.PRICE_MISMATCH;
    await this.poRepo.save(po);

    // If there's a mismatch, trigger alerts
    if (!allValid) {
      const mismatchItems = lineResults.filter(
        (r) => r.status === LineItemValidationStatus.MISMATCH,
      );
      const alertMessage = this.formatMismatchMessage(po, mismatchItems);
      await this.alertsService.createAlert({
        type: AlertType.PRICE_MISMATCH,
        subject: `Price mismatch on PO ${po.poNumber}`,
        message: alertMessage,
        referenceId: po.id,
        referenceType: 'purchase_order',
      });

      // Send email to vendor
      const vendorEmail =
        po.vendor?.email ||
        (po.extractedData?.emailFrom as string | undefined);
      if (vendorEmail) {
        try {
          await this.emailService.sendEmail(
            vendorEmail,
            `[Action Required] Price mismatch on PO ${po.poNumber}`,
            this.buildMismatchEmailHtml(po, mismatchItems),
          );
          this.logger.log(`Mismatch email sent to ${vendorEmail} for PO ${po.poNumber}`);
        } catch (emailErr) {
          this.logger.warn(`Failed to send mismatch email (non-fatal): ${emailErr}`);
        }
      } else {
        this.logger.warn(`No vendor email found for PO ${po.poNumber}, skipping mismatch email`);
      }
    }

    // Auto-consolidate and auto-create delivery for validated POs
    if (allValid) {
      try {
        await this.autoConsolidateAndDispatch(po);
      } catch (err) {
        this.logger.error(
          `Auto-consolidation/dispatch failed for PO ${po.poNumber}: ${err}`,
        );
        // Don't fail the validation response — just log
      }
    }

    return { poId, isValid: allValid, lineResults };
  }

  /**
   * After successful validation:
   * 1. Upsert a Consolidation record for this PO's date+city
   * 2. Create a Delivery (dispatch plan) for this PO
   */
  private async autoConsolidateAndDispatch(po: PurchaseOrder): Promise<void> {
    const poDate = new Date(po.poDate);
    poDate.setHours(0, 0, 0, 0);

    // --- 1. CONSOLIDATION ---
    // Find or create consolidation for this date+city
    let consolidation = await this.consolidationRepo.findOne({
      where: { consolidationDate: poDate, city: po.shippingLocation },
    });

    // Reload line items with sku
    const lineItems = await this.lineItemRepo.find({
      where: { purchaseOrderId: po.id },
      relations: ['sku'],
    });

    // Build SKU aggregation
    const skuMap = new Map<
      string,
      { skuId: string; skuCode: string; skuName: string; totalPacks: number; packSize: number }
    >();
    for (const li of lineItems) {
      const key = li.skuId || li.itemCode;
      if (!skuMap.has(key)) {
        skuMap.set(key, {
          skuId: li.skuId || li.itemCode,
          skuCode: li.sku?.code || li.itemCode,
          skuName: li.sku?.name || li.itemName || '',
          totalPacks: 0,
          packSize: li.sku?.packSize || 1,
        });
      }
      skuMap.get(key)!.totalPacks += li.quantity;
    }

    const newItems = Array.from(skuMap.values()).map((s) => ({
      skuId: s.skuId,
      skuCode: s.skuCode,
      skuName: s.skuName,
      totalPacks: s.totalPacks,
      totalEggs: s.totalPacks * s.packSize,
      requiredCrates: Math.ceil((s.totalPacks * s.packSize) / EGGS_PER_CRATE),
    }));

    if (consolidation) {
      // Merge into existing consolidation
      const existingItems: typeof newItems = (consolidation.items as any) || [];
      for (const newItem of newItems) {
        const existing = existingItems.find((i) => i.skuId === newItem.skuId);
        if (existing) {
          existing.totalPacks += newItem.totalPacks;
          existing.totalEggs += newItem.totalEggs;
          existing.requiredCrates += newItem.requiredCrates;
        } else {
          existingItems.push(newItem);
        }
      }
      consolidation.items = existingItems;
      consolidation.totalPacks = existingItems.reduce((s, i) => s + i.totalPacks, 0);
      consolidation.totalEggs = existingItems.reduce((s, i) => s + i.totalEggs, 0);
      consolidation.totalCrates = existingItems.reduce((s, i) => s + i.requiredCrates, 0);
      const poIds: string[] = (consolidation.poIds as any) || [];
      if (!poIds.includes(po.id)) poIds.push(po.id);
      consolidation.poIds = poIds;
    } else {
      // Create new consolidation
      const totalPacks = newItems.reduce((s, i) => s + i.totalPacks, 0);
      const totalEggs = newItems.reduce((s, i) => s + i.totalEggs, 0);
      const totalCrates = newItems.reduce((s, i) => s + i.requiredCrates, 0);
      consolidation = this.consolidationRepo.create({
        consolidationDate: poDate,
        city: po.shippingLocation,
        items: newItems,
        totalPacks,
        totalEggs,
        totalCrates,
        poIds: [po.id],
      });
    }
    await this.consolidationRepo.save(consolidation);

    // --- 2. AUTO-CREATE DELIVERY (dispatch plan) ---
    // Only create if one doesn't exist for this PO yet
    const existingDelivery = await this.deliveryRepo.findOne({
      where: { purchaseOrderId: po.id },
    });

    if (!existingDelivery) {
      // Try to find a matching route whose stops include this shipping location
      const allRoutes = await this.routeRepo.find({ where: { isActive: true } });
      const route = allRoutes.find((r) =>
        Array.isArray(r.stops) && r.stops.some(
          (stop) => stop.toLowerCase() === po.shippingLocation.toLowerCase(),
        ),
      );

      // Include all line items; skuId is now nullable in the DB
      const deliveryLineItems = lineItems.map((li) =>
        this.deliveryLineItemRepo.create({
          skuId: li.skuId || undefined,
          itemCode: li.itemCode || undefined,
          itemName: li.itemName || undefined,
          orderedQuantity: li.quantity,
          deliveredQuantity: 0,
          shortage: 0,
        }),
      );

      if (lineItems.every((li) => !li.skuId)) {
        this.logger.warn(`PO ${po.poNumber} has no SKU-linked line items — delivery created with item codes only`);
      }

      const delivery = this.deliveryRepo.create({
        purchaseOrderId: po.id,
        routeId: route?.id || undefined,
        dispatchDate: poDate,
        status: DispatchStatus.PLANNED,
        lineItems: deliveryLineItems,
      });

      await this.deliveryRepo.save(delivery);
      this.logger.log(`Auto-created delivery for PO ${po.poNumber}`);
    }

    // Update PO to CONSOLIDATED
    await this.poRepo.update(po.id, { status: PoStatus.CONSOLIDATED });
    this.logger.log(`PO ${po.poNumber} auto-consolidated and dispatched`);
  }

  private formatMismatchMessage(
    po: PurchaseOrder,
    mismatches: ValidationResult['lineResults'],
  ): string {
    const lines = mismatches
      .map(
        (m) =>
          `SKU: ${m.skuCode} | PO Price: ₹${m.poPrice} | Expected: ₹${m.calculatedPrice} | Diff: ₹${m.variance.toFixed(2)}`,
      )
      .join('\n');
    return `⚠️ Price Mismatch Alert\nPO: ${po.poNumber}\nVendor: ${po.vendor?.name}\n\n${lines}`;
  }

  private buildMismatchEmailHtml(
    po: PurchaseOrder,
    mismatches: ValidationResult['lineResults'],
  ): string {
    const rows = mismatches
      .map(
        (m) => `<tr>
          <td style="padding:6px 12px;border:1px solid #ddd">${m.skuCode}</td>
          <td style="padding:6px 12px;border:1px solid #ddd;text-align:right">₹${m.poPrice.toFixed(2)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd;text-align:right">₹${m.calculatedPrice.toFixed(2)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd;text-align:right;color:${m.variance > 0 ? '#c00' : '#080'}">₹${m.variance.toFixed(2)}</td>
        </tr>`,
      )
      .join('');

    return `
      <p>Dear ${po.vendor?.name || 'Vendor'},</p>
      <p>We have reviewed Purchase Order <strong>${po.poNumber}</strong> and found price discrepancies against our current NECC-based rates. Please review and resubmit with corrected pricing.</p>
      <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:6px 12px;border:1px solid #ddd">SKU</th>
            <th style="padding:6px 12px;border:1px solid #ddd">PO Price</th>
            <th style="padding:6px 12px;border:1px solid #ddd">Expected Price</th>
            <th style="padding:6px 12px;border:1px solid #ddd">Difference</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p>If you have any questions, please contact us at <a href="mailto:goodoriginspo@gmail.com">goodoriginspo@gmail.com</a>.</p>
      <p>Regards,<br/>Good Eggs Procurement Team</p>
    `;
  }
}
