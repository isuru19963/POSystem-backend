import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly client: Twilio;
  /** Twilio WhatsApp sender (E.164), without the `whatsapp:` prefix */
  private readonly from: string;

  constructor(private readonly configService: ConfigService) {
    this.client = new Twilio(
      this.configService.get<string>('whatsapp.accountSid') || '',
      this.configService.get<string>('whatsapp.authToken') || '',
    );
    const rawFrom = (this.configService.get<string>('whatsapp.from') || '').trim();
    this.from = rawFrom.replace(/^whatsapp:/i, '');
  }

  /** E.164 for Twilio; strips accidental `whatsapp:` prefix from DB values. */
  normalizeWhatsAppTo(to: string): string {
    let t = (to || '').trim();
    t = t.replace(/^whatsapp:/i, '');
    return t;
  }

  /**
   * Send a WhatsApp message. When `mediaUrls` are provided, Twilio fetches the
   * URLs and attaches them. Twilio WhatsApp media constraints (as of 2025):
   *  - Up to 10 media attachments per message
   *  - PDF max 16MB; images max 5MB; video/audio max 16MB
   *  - URLs must be publicly reachable HTTPS (no auth)
   */
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
      // Twilio rejects with error 63031 — "Channels message cannot have same
      // From and To" — and bills the attempt. Skip silently.
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
    await this.client.messages.create({
      from: `whatsapp:${this.from}`,
      to: `whatsapp:${toAddr}`,
      body: message,
      ...(mediaUrls.length ? { mediaUrl: mediaUrls } : {}),
    });
  }

  async sendGroupAlert(
    message: string,
    options: { mediaUrls?: string[] } = {},
  ): Promise<void> {
    const groupId = this.normalizeWhatsAppTo(
      this.configService.get<string>('whatsapp.groupId') || '',
    );
    if (!groupId) {
      this.logger.warn('WhatsApp group ID not configured');
      return;
    }
    if (groupId === this.from) {
      this.logger.warn(
        `WHATSAPP_GROUP_ID (${groupId}) equals TWILIO_WHATSAPP_FROM — skipping group alert`,
      );
      return;
    }
    await this.sendMessage(groupId, message, options);
  }
}
