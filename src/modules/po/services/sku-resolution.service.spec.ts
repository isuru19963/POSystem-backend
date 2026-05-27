import { SkuResolutionService } from './sku-resolution.service';

describe('SkuResolutionService (descriptor parsing)', () => {
  let svc: SkuResolutionService;

  beforeEach(() => {
    svc = new SkuResolutionService(null as never);
  });

  it('maps dr Good 12 Pieces line to dr_good_eggs + pack 12', () => {
    const parsed = svc.parseLineDescriptor(
      'BH-dr Good Nutrition Enriched Speciality Eggs (Mono Carton), 12 Pieces',
    );
    expect(parsed.brandFamily).toBe('dr_good_eggs');
    expect(parsed.packSize).toBe(12);
  });

  it('maps premium fresh 30 pack wording', () => {
    const parsed = svc.parseLineDescriptor(
      'Premium Fresh Brown Eggs 30 Pack Carton',
    );
    expect(parsed.brandFamily).toBe('premium_fresh');
    expect(parsed.packSize).toBe(30);
  });

  it('maps 6 pack premium line', () => {
    const parsed = svc.parseLineDescriptor('Premium Fresh Eggs 6 Pieces');
    expect(parsed.brandFamily).toBe('premium_fresh');
    expect(parsed.packSize).toBe(6);
  });

  it('does not treat premium substring inside unrelated text as dr good', () => {
    const parsed = svc.parseLineDescriptor(
      'Premium Fresh White Eggs 12 Pieces',
    );
    expect(parsed.brandFamily).toBe('premium_fresh');
    expect(parsed.brandFamily).not.toBe('dr_good_eggs');
  });

  it('infers dr good from good nutrition without premium', () => {
    const parsed = svc.parseLineDescriptor(
      'Good Nutrition Enriched Eggs 30 Pieces',
    );
    expect(parsed.brandFamily).toBe('dr_good_eggs');
    expect(parsed.packSize).toBe(30);
  });

  it('maps OCR "prem ium fresh" phrase to premium_fresh', () => {
    const parsed = svc.parseLineDescriptor(
      'dr GOOD EGGS Pr emium Fresh 6 P c 6.0 Pieces',
    );
    expect(parsed.brandFamily).toBe('premium_fresh');
    expect(parsed.packSize).toBe(6);
  });

  it('does not treat lone "premium" without "fresh" as Premium Fresh', () => {
    const parsed = svc.parseLineDescriptor('Brown Eggs Premium 12 Pieces');
    expect(parsed.brandFamily).toBe('dr_good_eggs');
    expect(parsed.packSize).toBe(12);
  });

  it('defaults unknown egg wording to dr_good_eggs when pack size known', () => {
    const parsed = svc.parseLineDescriptor(
      'BH-dr Good Nutrition Enriched Speciality Eggs, 30 Pieces',
    );
    expect(parsed.brandFamily).toBe('dr_good_eggs');
    expect(parsed.packSize).toBe(30);
  });

  it('handles OCR-broken 12.0 Piec es', () => {
    const parsed = svc.parseLineDescriptor(
      'dr GOOD EGGS Om ega-3 12.0 Piec es',
    );
    expect(parsed.packSize).toBe(12);
  });

  it('classifies catalogue SKU brands with the same phrase rule', () => {
    expect(svc.skuBrandFamily('Premium Fresh')).toBe('premium_fresh');
    expect(svc.skuBrandFamily('Premium')).toBe('dr_good_eggs');
    expect(svc.skuBrandFamily('Dr Good Eggs')).toBe('dr_good_eggs');
  });
});
