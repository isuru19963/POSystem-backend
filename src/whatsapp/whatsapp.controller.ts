import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { validateRequest } from 'twilio';
import { WhatsappService } from './whatsapp.service';

/**
 * Twilio WhatsApp inbound webhook.
 * Configure in Twilio Console → Messaging → WhatsApp sender →
 * "When a message comes in": POST {API_URL}/whatsapp/webhook/incoming
 */
@Controller('whatsapp')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly configService: ConfigService,
  ) {}

  @Post('webhook/incoming')
  @HttpCode(200)
  async incoming(
    @Body() body: Record<string, string>,
    @Headers('x-twilio-signature') signature: string | undefined,
    @Req() req: Request,
  ): Promise<string> {
    const authToken = this.configService.get<string>('whatsapp.authToken');
    if (authToken && signature) {
      const publicUrl =
        this.configService.get<string>('whatsapp.webhookPublicUrl') ||
        `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const valid = validateRequest(
        authToken,
        signature,
        publicUrl,
        body as Record<string, string>,
      );
      if (!valid) {
        this.logger.warn('Rejected WhatsApp webhook — invalid Twilio signature');
        return '';
      }
    }

    const from = (body.From || '').replace(/^whatsapp:/i, '').trim();
    const text = (body.Body || '').trim();
    if (from) {
      await this.whatsappService.handleInboundMessage(from, text);
    }
    return '';
  }
}
