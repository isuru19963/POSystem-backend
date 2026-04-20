import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';

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
    this.from = this.configService.get<string>('whatsapp.from') || '';
  }

  async sendMessage(to: string, message: string): Promise<void> {
    this.logger.log(`Sending WhatsApp message to ${to}`);
    await this.client.messages.create({
      from: `whatsapp:${this.from}`,
      to: `whatsapp:${to}`,
      body: message,
    });
  }

  async sendGroupAlert(message: string): Promise<void> {
    const groupId =
      this.configService.get<string>('whatsapp.groupId') || '';
    if (!groupId) {
      this.logger.warn('WhatsApp group ID not configured');
      return;
    }
    await this.sendMessage(groupId, message);
  }
}
