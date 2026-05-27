import {
  buildTemplateVariables,
  truncateTemplateVar,
} from './whatsapp-template.helpers';

describe('whatsapp-template.helpers', () => {
  it('truncates long template variables', () => {
    const long = 'a'.repeat(1000);
    expect(truncateTemplateVar(long).length).toBeLessThanOrEqual(900);
  });

  it('builds numeric content variables for Twilio', () => {
    expect(buildTemplateVariables('2026-05-19', '15 POs')).toEqual({
      '1': '2026-05-19',
      '2': '15 POs',
    });
  });
});
