import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Delivery,
  DeliveryLineItem,
  DispatchStatus,
  Route,
  PurchaseOrder,
  PoStatus,
} from '../../../database/entities';
import { CreateDispatchDto } from '../dto/create-dispatch.dto';
import { EGGS_PER_CRATE } from '../../../common/constants/app.constants';

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    @InjectRepository(Delivery)
    private readonly deliveryRepo: Repository<Delivery>,
    @InjectRepository(DeliveryLineItem)
    private readonly lineItemRepo: Repository<DeliveryLineItem>,
    @InjectRepository(Route)
    private readonly routeRepo: Repository<Route>,
    @InjectRepository(PurchaseOrder)
    private readonly poRepo: Repository<PurchaseOrder>,
  ) {}

  async createDispatch(dto: CreateDispatchDto): Promise<Delivery> {
    const po = await this.poRepo.findOne({
      where: { id: dto.purchaseOrderId },
    });
    if (!po)
      throw new NotFoundException(`PO ${dto.purchaseOrderId} not found`);

    const delivery = this.deliveryRepo.create({
      purchaseOrderId: dto.purchaseOrderId,
      routeId: dto.routeId,
      vehicleNumber: dto.vehicleNumber,
      driverName: dto.driverName,
      driverPhone: dto.driverPhone,
      dispatchDate: new Date(dto.dispatchDate),
      status: DispatchStatus.PLANNED,
      lineItems: dto.lineItems.map((li) =>
        this.lineItemRepo.create({
          skuId: li.skuId,
          orderedQuantity: li.orderedQuantity,
          deliveredQuantity: 0,
          shortage: 0,
        }),
      ),
    });

    const saved = await this.deliveryRepo.save(delivery);

    // Update PO status
    po.status = PoStatus.DISPATCHED;
    await this.poRepo.save(po);

    return saved;
  }

  /** Generate packing summary for a dispatch date */
  async generatePackingSummary(
    date: Date,
  ): Promise<Record<string, unknown>> {
    const deliveries = await this.deliveryRepo.find({
      where: { dispatchDate: date },
      relations: ['lineItems', 'lineItems.sku', 'route', 'purchaseOrder'],
    });

    const summary: Record<string, unknown> = {};
    for (const delivery of deliveries) {
      const routeName = delivery.route?.name || 'Unassigned';
      const items = delivery.lineItems.map((li) => ({
        sku: li.sku?.code,
        packs: li.orderedQuantity,
        eggs: li.orderedQuantity * (li.sku?.packSize || 0),
        crates: Math.ceil(
          (li.orderedQuantity * (li.sku?.packSize || 0)) / EGGS_PER_CRATE,
        ),
      }));
      summary[routeName] = {
        vehicle: delivery.vehicleNumber,
        driver: delivery.driverName,
        items,
      };
    }
    return summary;
  }

  /** Record delivery quantities (manual entry) */
  async recordDelivery(
    deliveryId: string,
    lineItems: Array<{ lineItemId: string; deliveredQuantity: number }>,
  ): Promise<Delivery> {
    const delivery = await this.deliveryRepo.findOne({
      where: { id: deliveryId },
      relations: ['lineItems'],
    });
    if (!delivery)
      throw new NotFoundException(`Delivery ${deliveryId} not found`);

    for (const update of lineItems) {
      const li = delivery.lineItems.find((l) => l.id === update.lineItemId);
      if (li) {
        li.deliveredQuantity = update.deliveredQuantity;
        li.shortage = li.orderedQuantity - update.deliveredQuantity;
        await this.lineItemRepo.save(li);
      }
    }

    // Check if all items delivered fully
    const hasShortage = delivery.lineItems.some((li) => li.shortage > 0);
    delivery.status = hasShortage
      ? DispatchStatus.PARTIAL
      : DispatchStatus.DELIVERED;

    return this.deliveryRepo.save(delivery);
  }

  async getRoutes(): Promise<Route[]> {
    return this.routeRepo.find({ where: { isActive: true } });
  }
}
