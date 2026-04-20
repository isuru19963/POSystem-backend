import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('email.smtp.host'),
      port: this.configService.get<number>('email.smtp.port'),
      secure: false,
      auth: {
        user: this.configService.get<string>('email.smtp.user'),
        pass: this.configService.get<string>('email.smtp.password'),
      },
    });
  }

  async sendEmail(
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    this.logger.log(`Sending email to ${to}: ${subject}`);
    await this.transporter.sendMail({
      from: this.configService.get<string>('email.smtp.user'),
      to,
      subject,
      html,
    });
  }

  async sendDraftResponse(
    to: string,
    subject: string,
    body: string,
  ): Promise<void> {
    this.logger.log(`Sending draft response to ${to}`);
    await this.sendEmail(to, subject, body);
  }
}
