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

  async sendMessage(to: string, message: string): Promise<void> {
    const toAddr = this.normalizeWhatsAppTo(to);
    if (!this.from) {
      throw new Error('TWILIO_WHATSAPP_FROM is not configured');
    }
    if (!toAddr) {
      throw new Error('WhatsApp recipient number is empty');
    }
    this.logger.log(`Sending WhatsApp message to ${toAddr}`);
    await this.client.messages.create({
      from: `whatsapp:${this.from}`,
      to: `whatsapp:${toAddr}`,
      body: message,
    });
  }

  async sendGroupAlert(message: string): Promise<void> {
    const groupId = this.normalizeWhatsAppTo(
      this.configService.get<string>('whatsapp.groupId') || '',
    );
    if (!groupId) {
      this.logger.warn('WhatsApp group ID not configured');
      return;
    }
    await this.sendMessage(groupId, message);
  }
}
