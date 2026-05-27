/**
 * Approved Twilio Content template purposes.
 * Each maps to an env var TWILIO_WHATSAPP_TEMPLATE_<NAME> (see whatsapp.config.ts).
 */
export type WhatsAppTemplatePurpose =
  | 'generic'
  | 'new_po'
  | 'daily_orders'
  | 'delivery_report';

export interface WhatsAppTemplateConfigStatus {
  purpose: WhatsAppTemplatePurpose;
  envKey: string;
  contentSid: string | null;
  configured: boolean;
}

export interface WhatsAppNotificationOptions {
  /** Which approved template to use when outside the 24h session (or when preferTemplate is true). */
  templatePurpose?: WhatsAppTemplatePurpose;
  /** Short text for template variable {{1}} (and {{2}} if provided). */
  templateSummary: string;
  /** Optional second variable for two-placeholder templates. */
  templateDetail?: string;
  /**
   * When true, send the approved template immediately (no free-form attempt).
   * Use for scheduled crons (6 AM / 7 PM / daily digest) so delivery works without 24h window.
   */
  preferTemplate?: boolean;
  mediaUrls?: string[];
}
