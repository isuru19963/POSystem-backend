import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as imapSimple from 'imap-simple';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface IncomingEmail {
  messageId: string;
  from: string;
  subject: string;
  body: string;
  date: Date;
  attachments: EmailAttachment[];
}

/** Supported PO attachment types */
const PO_ATTACHMENT_TYPES = [
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
  'text/csv',
  'application/csv',
];

const PO_FILE_EXTENSIONS = ['.pdf', '.xls', '.xlsx', '.csv'];

@Injectable()
export class ImapService {
  private readonly logger = new Logger(ImapService.name);

  constructor(private readonly configService: ConfigService) {}

  private getConfig(): imapSimple.ImapSimpleOptions {
    return {
      imap: {
        user: this.configService.get<string>('email.imap.user') || '',
        password: this.configService.get<string>('email.imap.password') || '',
        host: this.configService.get<string>('email.imap.host') || '',
        port: this.configService.get<number>('email.imap.port') || 993,
        tls: this.configService.get<boolean>('email.imap.tls') ?? true,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 30000,
        authTimeout: 30000,
      },
    };
  }

  async fetchUnreadEmails(): Promise<IncomingEmail[]> {
    this.logger.log('Connecting to IMAP server...');
    const connection = await imapSimple.connect(this.getConfig());
    await connection.openBox('INBOX');

    const searchCriteria = ['UNSEEN'];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT', ''],
      markSeen: true,
      struct: true,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    const emails = await this.parseMessages(connection, messages);

    connection.end();
    this.logger.log(
      `Found ${emails.length} emails with PO attachments`,
    );
    return emails;
  }

  /**
   * Fetch ALL emails (including already-read ones) for reprocessing
   */
  async fetchAllEmails(): Promise<IncomingEmail[]> {
    this.logger.log('Connecting to IMAP server (fetch all)...');
    const connection = await imapSimple.connect(this.getConfig());
    await connection.openBox('INBOX');

    const searchCriteria = ['ALL'];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT', ''],
      markSeen: true,
      struct: true,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    const emails = await this.parseMessages(connection, messages);

    connection.end();
    this.logger.log(
      `Found ${emails.length} total emails with PO attachments`,
    );
    return emails;
  }

  private async parseMessages(
    connection: imapSimple.ImapSimple,
    messages: imapSimple.Message[],
  ): Promise<IncomingEmail[]> {
    const emails: IncomingEmail[] = [];

    for (const message of messages) {
      const header = message.parts.find((p) => p.which === 'HEADER');
      if (!header) continue;

      const headerData = header.body as Record<string, string[]>;
      const attachments = await this.extractAttachments(connection, message);

      // Filter to PO-relevant attachments (PDF + XLS)
      const poAttachments = attachments.filter((a) => {
        const ext = a.filename.toLowerCase();
        return (
          PO_ATTACHMENT_TYPES.includes(a.contentType.toLowerCase()) ||
          PO_FILE_EXTENSIONS.some((e) => ext.endsWith(e))
        );
      });

      if (poAttachments.length > 0) {
        // Extract plain text body
        const textPart = message.parts.find((p) => p.which === 'TEXT');
        const body = textPart ? String(textPart.body || '') : '';

        emails.push({
          messageId: headerData['message-id']?.[0] || '',
          from: headerData['from']?.[0] || '',
          subject: headerData['subject']?.[0] || '',
          body,
          date: new Date(headerData['date']?.[0] || ''),
          attachments: poAttachments,
        });
      }
    }

    return emails;
  }

  private async extractAttachments(
    connection: imapSimple.ImapSimple,
    message: imapSimple.Message,
  ): Promise<EmailAttachment[]> {
    const parts = imapSimple.getParts(message.attributes.struct!);
    const attachments: EmailAttachment[] = [];

    for (const part of parts) {
      if (
        part.disposition &&
        part.disposition.type &&
        part.disposition.type.toUpperCase() === 'ATTACHMENT'
      ) {
        const partData = await connection.getPartData(message, part);
        attachments.push({
          filename: part.disposition.params?.filename || 'unknown',
          content: Buffer.isBuffer(partData)
            ? partData
            : Buffer.from(partData as string, 'utf-8'),
          contentType: `${part.type}/${part.subtype}`,
        });
      }
    }

    return attachments;
  }
}
