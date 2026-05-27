import type { WhatsAppTemplatePurpose } from './whatsapp-template.types';

/** Meta/Twilio template bodies are limited; keep variables safe. */
export const TEMPLATE_VAR_MAX_LEN = 900;

export function truncateTemplateVar(text: string, max = TEMPLATE_VAR_MAX_LEN): string {
  const oneLine = (text || '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 3)}...`;
}

/** Build Content API variables {{1}}, optional {{2}}. */
export function buildTemplateVariables(
  summary: string,
  detail?: string,
): Record<string, string> {
  const vars: Record<string, string> = {
    '1': truncateTemplateVar(summary),
  };
  if (detail?.trim()) {
    vars['2'] = truncateTemplateVar(detail);
  }
  return vars;
}

export function purposeEnvKey(purpose: WhatsAppTemplatePurpose): string {
  const map: Record<WhatsAppTemplatePurpose, string> = {
    generic: 'TWILIO_WHATSAPP_TEMPLATE_OUTSIDE_SESSION',
    new_po: 'TWILIO_WHATSAPP_TEMPLATE_NEW_PO',
    daily_orders: 'TWILIO_WHATSAPP_TEMPLATE_DAILY_ORDERS',
    delivery_report: 'TWILIO_WHATSAPP_TEMPLATE_DELIVERY_REPORT',
  };
  return map[purpose];
}

/**
 * Suggested template copy for Twilio Content Builder (Utility category).
 * Meta often rejects short bodies with 2 variables — use long static text and/or 1 variable.
 */
export const SUGGESTED_TEMPLATE_BODIES: Record<
  WhatsAppTemplatePurpose,
  { body: string; category: string; notes: string; samples: Record<string, string> }
> = {
  generic: {
    category: 'Utility',
    body:
      'This is an automated operations update from your order system. Details: {{1}} Thank you.',
    notes: 'Single variable fallback. Sample must look like a real ops message.',
    samples: {
      '1': 'Daily summary: 15 purchase orders scheduled for delivery on 19 May 2026.',
    },
  },
  new_po: {
    category: 'Utility',
    body:
      'This is an automated order notification for your business account. Purchase order {{1}} has been received and is ready for your team to review in the order portal.',
    notes:
      'Use ONE variable only. Business name must match Meta WhatsApp display name (omit "POS" if not verified).',
    samples: {
      '1': 'CPCAP27-PO-3217821',
    },
  },
  daily_orders: {
    category: 'Utility',
    body:
      'This is your scheduled order summary for {{1}}. Your operations team has {{2}} purchase orders to review in the order management system today.',
    notes: 'Two variables need long static text on both sides.',
    samples: {
      '1': '19 May 2026',
      '2': '15',
    },
  },
  delivery_report: {
    category: 'Utility',
    body:
      'This is your scheduled delivery quantity report for {{1}}. Summary for your logistics team: {{2}}',
    notes: '6 AM / 7 PM IST. {{2}} = short totals line.',
    samples: {
      '1': '19 May 2026 morning cut-off',
      '2': '15 orders, 11718 packs across 4 SKUs',
    },
  },
};
