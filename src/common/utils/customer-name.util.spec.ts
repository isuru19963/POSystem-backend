import {
  isGarbageCustomerLabel,
  looksLikeMisimportedVendorName,
  sanitizeVendorNameForImport,
  stripCustomerNameLabel,
} from './customer-name.util';

describe('customer-name.util', () => {
  it('flags PO No label as garbage', () => {
    expect(isGarbageCustomerLabel('PO No :')).toBe(true);
    expect(looksLikeMisimportedVendorName('PO No :')).toBe(true);
  });

  it('strips Buyer Name prefix', () => {
    expect(
      stripCustomerNameLabel('Buyer Name: Firstclub Technology PVT. LTD'),
    ).toBe('Firstclub Technology PVT. LTD');
    expect(
      sanitizeVendorNameForImport('Buyer Name: Firstclub Technology PVT. LTD'),
    ).toBe('Firstclub Technology PVT. LTD');
  });

  it('keeps real company names', () => {
    expect(sanitizeVendorNameForImport('CLOUDKART VENTURES PRIVATE LIMITED')).toBe(
      'CLOUDKART VENTURES PRIVATE LIMITED',
    );
  });

  it('treats Buyer Name prefix rows as misimports', () => {
    expect(
      looksLikeMisimportedVendorName('Buyer Name: Firstclub Technology PVT. LTD'),
    ).toBe(true);
  });
});
