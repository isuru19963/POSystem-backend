import { registerAs } from '@nestjs/config';

export default registerAs('whatsapp', () => ({
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  from: process.env.TWILIO_WHATSAPP_FROM,
  groupId: process.env.WHATSAPP_GROUP_ID,
  /** Generic fallback (HX...) — maps to purpose `generic` */
  templateOutsideSession: process.env.TWILIO_WHATSAPP_TEMPLATE_OUTSIDE_SESSION,
  templateNewPo: process.env.TWILIO_WHATSAPP_TEMPLATE_NEW_PO,
  templateDailyOrders: process.env.TWILIO_WHATSAPP_TEMPLATE_DAILY_ORDERS,
  templateDeliveryReport: process.env.TWILIO_WHATSAPP_TEMPLATE_DELIVERY_REPORT,
  /**
   * Scheduled jobs (daily digest, 6 AM / 7 PM SKU report) send approved templates
   * directly so they work without the 24h customer message window.
   */
  preferTemplateForScheduled:
    String(process.env.TWILIO_WHATSAPP_PREFER_TEMPLATE_FOR_SCHEDULED ?? 'true')
      .toLowerCase() !== 'false',
  webhookPublicUrl: process.env.TWILIO_WHATSAPP_WEBHOOK_URL,
}));
