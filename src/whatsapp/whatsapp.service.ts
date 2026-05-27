import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';
import {
  formatWhatsAppSendError,
  isOutsideSessionWindow,
  WhatsAppSessionClosedError,
} from './whatsapp.errors';
import {
  buildTemplateVariables,
  purposeEnvKey,
  SUGGESTED_TEMPLATE_BODIES,
  truncateTemplateVar,
} from './whatsapp-template.helpers';
import type {
  WhatsAppNotificationOptions,
  WhatsAppTemplateConfigStatus,
  WhatsAppTemplatePurpose,
} from './whatsapp-template.types';

export type WhatsAppSendMode = 'session' | 'template' | 'skipped';

export interface WhatsAppSendResult {
  mode: WhatsAppSendMode;
  contentSid?: string;
  error?: string;
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly client: Twilio;
  private readonly from: string;

  constructor(private readonly configService: ConfigService) {
    this.client = new Twilio(
      this.configService.get<string>('whatsapp.accountSid') || '',
      this.configService.get<string>('whatsapp.authToken') || '',
    );
    const rawFrom = (this.configService.get<string>('whatsapp.from') || '').trim();
    this.from = rawFrom.replace(/^whatsapp:/i, '');
  }

  normalizeWhatsAppTo(to: string): string {
    let t = (to || '').trim();
    t = t.replace(/^whatsapp:/i, '');
    return t;
  }

  getTemplateSid(purpose: WhatsAppTemplatePurpose): string | null {
    const keyMap: Record<WhatsAppTemplatePurpose, string> = {
      generic: 'whatsapp.templateOutsideSession',
      new_po: 'whatsapp.templateNewPo',
      daily_orders: 'whatsapp.templateDailyOrders',
      delivery_report: 'whatsapp.templateDeliveryReport',
    };
    const specific = (this.configService.get<string>(keyMap[purpose]) || '').trim();
    if (specific) return specific;
    if (purpose !== 'generic') {
      return this.getTemplateSid('generic');
    }
    return null;
  }

  getTemplateConfigStatus(): {
    from: string | null;
    preferTemplateForScheduled: boolean;
    webhookPublicUrl: string | null;
    templates: WhatsAppTemplateConfigStatus[];
    suggestedBodies: typeof SUGGESTED_TEMPLATE_BODIES;
  } {
    const purposes: WhatsAppTemplatePurpose[] = [
      'generic',
      'new_po',
      'daily_orders',
      'delivery_report',
    ];
    return {
      from: this.from || null,
      preferTemplateForScheduled:
        this.configService.get<boolean>('whatsapp.preferTemplateForScheduled') ??
        true,
      webhookPublicUrl:
        this.configService.get<string>('whatsapp.webhookPublicUrl') || null,
      templates: purposes.map((purpose) => {
        const sid = this.getTemplateSid(purpose);
        return {
          purpose,
          envKey: purposeEnvKey(purpose),
          contentSid: sid,
          configured: !!sid,
        };
      }),
      suggestedBodies: SUGGESTED_TEMPLATE_BODIES,
    };
  }

  async handleInboundMessage(from: string, body: string): Promise<void> {
    this.logger.log(
      `WhatsApp inbound from ${from}${body ? `: ${body.slice(0, 80)}` : ''}`,
    );
    const reply =
      '✅ *Good Eggs POS*\n' +
      'Alerts are active for the next *24 hours* (free-form messages).\n' +
      'Scheduled reports also use approved templates when configured.\n\n' +
      '_If alerts stop, send any message here again._';
    try {
      await this.sendMessage(from, reply);
    } catch (err) {
      this.logger.warn(
        `Inbound auto-reply failed for ${from}: ${formatWhatsAppSendError(err)}`,
      );
    }
  }

  async sendTemplateMessage(
    to: string,
    contentSid: string,
    contentVariables?: Record<string, string>,
  ): Promise<void> {
    const toAddr = this.normalizeWhatsAppTo(to);
    if (!this.from) {
      throw new Error('TWILIO_WHATSAPP_FROM is not configured');
    }
    if (!contentSid?.trim()) {
      throw new Error('WhatsApp template content SID is empty');
    }
    this.logger.log(`Sending WhatsApp template ${contentSid} to ${toAddr}`);
    await this.client.messages.create({
      from: `whatsapp:${this.from}`,
      to: `whatsapp:${toAddr}`,
      contentSid: contentSid.trim(),
      ...(contentVariables && Object.keys(contentVariables).length
        ? { contentVariables: JSON.stringify(contentVariables) }
        : {}),
    });
  }

  async sendMessage(
    to: string,
    message: string,
    options: { mediaUrls?: string[] } = {},
  ): Promise<void> {
    const toAddr = this.normalizeWhatsAppTo(to);
    if (!this.from) {
      throw new Error('TWILIO_WHATSAPP_FROM is not configured');
    }
    if (!toAddr) {
      throw new Error('WhatsApp recipient number is empty');
    }
    if (toAddr === this.from) {
      this.logger.warn(
        `Skipping WhatsApp send: recipient (${toAddr}) is the Twilio sender`,
      );
      return;
    }

    const mediaUrls = (options.mediaUrls ?? []).filter(
      (u): u is string => typeof u === 'string' && u.trim().length > 0,
    );

    this.logger.log(
      `Sending WhatsApp message to ${toAddr}${mediaUrls.length ? ` with ${mediaUrls.length} media URL(s)` : ''}`,
    );
    try {
      await this.client.messages.create({
        from: `whatsapp:${this.from}`,
        to: `whatsapp:${toAddr}`,
        body: message,
        ...(mediaUrls.length ? { mediaUrl: mediaUrls } : {}),
      });
    } catch (err) {
      if (isOutsideSessionWindow(err)) {
        const code = (err as { code?: number }).code;
        throw new WhatsAppSessionClosedError(
          formatWhatsAppSendError(err),
          code,
        );
      }
      throw err;
    }
  }

  /**
   * Primary API for PO alerts, digests, and reports.
   * - preferTemplate: sends approved template first (scheduled jobs).
   * - otherwise: free-form (+ media), then template fallback on 24h errors.
   */
  async sendBusinessNotification(
    to: string,
    message: string,
    options: WhatsAppNotificationOptions,
  ): Promise<WhatsAppSendResult> {
    const purpose = options.templatePurpose ?? 'generic';
    const contentSid = this.getTemplateSid(purpose);
    const vars = buildTemplateVariables(
      options.templateSummary,
      options.templateDetail,
    );

    if (options.preferTemplate) {
      if (!contentSid) {
        return {
          mode: 'skipped',
          error:
            `No approved template configured for "${purpose}" (${purposeEnvKey(purpose)}). ` +
            'Create a utility template in Twilio and set the Content SID on the server.',
        };
      }
      try {
        await this.sendTemplateMessage(to, contentSid, vars);
        return { mode: 'template', contentSid };
      } catch (err) {
        return { mode: 'skipped', error: formatWhatsAppSendError(err) };
      }
    }

    try {
      await this.sendMessage(to, message, { mediaUrls: options.mediaUrls });
      return { mode: 'session' };
    } catch (err) {
      if (!isOutsideSessionWindow(err) && !(err instanceof WhatsAppSessionClosedError)) {
        return { mode: 'skipped', error: formatWhatsAppSendError(err) };
      }
      if (!contentSid) {
        return {
          mode: 'skipped',
          error: formatWhatsAppSendError(err),
        };
      }
      try {
        await this.sendTemplateMessage(to, contentSid, vars);
        this.logger.log(
          `Template fallback (${purpose}) → ${this.normalizeWhatsAppTo(to)}`,
        );
        return { mode: 'template', contentSid };
      } catch (templateErr) {
        return {
          mode: 'skipped',
          error: `${formatWhatsAppSendError(err)} Template fallback failed: ${formatWhatsAppSendError(templateErr)}`,
        };
      }
    }
  }

  /** Scheduled cron notifications — template-first when env allows. */
  async sendScheduledNotification(
    to: string,
    message: string,
    options: Omit<WhatsAppNotificationOptions, 'preferTemplate' | 'mediaUrls'>,
  ): Promise<WhatsAppSendResult> {
    const prefer =
      this.configService.get<boolean>('whatsapp.preferTemplateForScheduled') ??
      true;
    return this.sendBusinessNotification(to, message, {
      ...options,
      preferTemplate: prefer,
    });
  }

  /** @deprecated Use sendBusinessNotification */
  async sendMessageWithTemplateFallback(
    to: string,
    message: string,
    options: { mediaUrls?: string[]; templateSummary?: string } = {},
  ): Promise<WhatsAppSendResult> {
    return this.sendBusinessNotification(to, message, {
      templatePurpose: 'generic',
      templateSummary:
        options.templateSummary?.trim() || truncateTemplateVar(message),
      mediaUrls: options.mediaUrls,
    });
  }

  async sendGroupAlert(
    message: string,
    options: { mediaUrls?: string[] } = {},
  ): Promise<WhatsAppSendResult> {
    const groupId = this.normalizeWhatsAppTo(
      this.configService.get<string>('whatsapp.groupId') || '',
    );
    if (!groupId) {
      this.logger.warn('WhatsApp group ID not configured');
      return { mode: 'skipped', error: 'WHATSAPP_GROUP_ID not configured' };
    }
    if (groupId === this.from) {
      this.logger.warn(
        `WHATSAPP_GROUP_ID (${groupId}) equals TWILIO_WHATSAPP_FROM — skipping`,
      );
      return { mode: 'skipped' };
    }
    return this.sendBusinessNotification(groupId, message, {
      templatePurpose: 'new_po',
      templateSummary: 'New PO received — open Good Eggs POS for details.',
      mediaUrls: options.mediaUrls,
    });
  }

  async testTemplateSend(
    to: string,
    purpose: WhatsAppTemplatePurpose,
    summary?: string,
    detail?: string,
  ): Promise<WhatsAppSendResult> {
    const contentSid = this.getTemplateSid(purpose);
    if (!contentSid) {
      return {
        mode: 'skipped',
        error: `Template not configured. Set ${purposeEnvKey(purpose)} on the server.`,
      };
    }
    const vars = buildTemplateVariables(
      summary || `Test message from Good Eggs POS (${purpose})`,
      detail || new Date().toISOString(),
    );
    try {
      await this.sendTemplateMessage(to, contentSid, vars);
      return { mode: 'template', contentSid };
    } catch (err) {
      return { mode: 'skipped', error: formatWhatsAppSendError(err) };
    }
  }
}
