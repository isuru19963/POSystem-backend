import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PurchaseOrder,
  PurchaseOrderLineItem,
  LineItemValidationStatus,
  PoStatus,
  ShippingLocationMapping,
} from '../../../database/entities';
import { PricingService } from '../../pricing/services/pricing.service';
import { AlertsService } from '../../alerts/services/alerts.service';
import { AlertType } from '../../../database/entities';

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
    private readonly pricingService: PricingService,
    private readonly alertsService: AlertsService,
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
            `Line item ${lineItem.id} has no resolved SKU, skipping validation`,
          );
          allValid = false;
          continue;
        }

        const calculated = await this.pricingService.calculatePrice(
          po.vendorId,
          lineItem.sku,
          po.poDate,
          city,
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
        this.logger.error(
          `Failed to validate line item ${lineItem.id}: ${error}`,
        );
        allValid = false;
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
      await this.alertsService.createAlert({
        type: AlertType.PRICE_MISMATCH,
        subject: `Price mismatch on PO ${po.poNumber}`,
        message: this.formatMismatchMessage(po, mismatchItems),
        referenceId: po.id,
        referenceType: 'purchase_order',
      });
    }

    return { poId, isValid: allValid, lineResults };
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
}
