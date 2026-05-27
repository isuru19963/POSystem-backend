import { DailyDeliveryConsolidationService } from './daily-delivery-consolidation.service';
import type { DailyDeliveryConsolidationReport } from './daily-delivery-consolidation.service';

describe('DailyDeliveryConsolidationService', () => {
  const service = new DailyDeliveryConsolidationService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  it('formats empty WhatsApp message', () => {
    const report: DailyDeliveryConsolidationReport = {
      deliveryDate: '2026-05-19',
      slot: 'morning',
      slotLabel: '6:00 AM',
      generatedAt: new Date().toISOString(),
      poCount: 0,
      posWithUnmappedLines: 0,
      rows: [],
      totalPacks: 0,
      totalEggs: 0,
      totalCrates: 0,
      byCity: [],
    };
    const msg = service.formatWhatsAppMessage(report);
    expect(msg).toContain("Today's Delivery");
    expect(msg).toContain('6:00 AM');
  });

  it('formats SKU lines and totals', () => {
    const report: DailyDeliveryConsolidationReport = {
      deliveryDate: '2026-05-19',
      slot: 'evening',
      slotLabel: '7:00 PM',
      generatedAt: new Date().toISOString(),
      poCount: 2,
      posWithUnmappedLines: 0,
      rows: [
        {
          skuCode: 'EGG-30',
          skuName: '30 Egg Tray',
          packSize: 30,
          totalPacks: 10,
          totalEggs: 300,
          requiredCrates: 2,
        },
      ],
      totalPacks: 10,
      totalEggs: 300,
      totalCrates: 2,
      byCity: [
        {
          city: 'Mumbai',
          poCount: 2,
          rows: [],
          totalPacks: 10,
          totalEggs: 300,
          totalCrates: 2,
        },
      ],
    };
    const msg = service.formatWhatsAppMessage(report);
    expect(msg).toContain('EGG-30');
    expect(msg).toContain('7:00 PM');
    expect(msg).toContain('Grand total');
  });
});
