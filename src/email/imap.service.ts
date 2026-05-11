import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as imapSimple from 'imap-simple';
import { decodeMimeWords } from './mime-word.util';
import { canonicalMessageId } from '../common/utils/email-message-id.util';

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

/** IMAP search hit counts plus merged message list */
export interface ImapFetchOutcome {
  emails: IncomingEmail[];
  /** Sum of raw SEARCH hits from last operation(s) feeding this outcome */
  imapMatchCount: number;
  unreadImapHits?: number;
  recentImapHits?: number;
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

  async fetchUnreadEmails(): Promise<ImapFetchOutcome> {
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
      `IMAP UNSEEN matched ${messages.length} message(s); ${emails.length} had doc attachments`,
    );
    return { emails, imapMatchCount: messages.length };
  }

  /**
   * Fetch ALL emails (including already-read ones) for reprocessing
   */
  async fetchAllEmails(): Promise<ImapFetchOutcome> {
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
      `IMAP ALL matched ${messages.length} message(s); ${emails.length} had doc attachments`,
    );
    return { emails, imapMatchCount: messages.length };
  }

  /**
   * Fetch read messages from the last N days that have PDF/XLS attachments.
   * Prefer this over {@link fetchAllEmails} for HTTP handlers — full inbox scans
   * routinely exceed reverse-proxy timeouts (504).
   */
  async fetchRecentEmailsWithAttachments(sinceDays: number = 21): Promise<ImapFetchOutcome> {
    const days = Math.min(Math.max(sinceDays, 1), 90);
    this.logger.log(`Connecting to IMAP (SINCE last ${days} days)...`);
    const connection = await imapSimple.connect(this.getConfig());
    await connection.openBox('INBOX');

    // node-imap requires a Date for SINCE (it formats as d-Mon-yyyy in local time)
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - days);

    const searchCriteria = [['SINCE', since]];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT', ''],
      markSeen: true,
      struct: true,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    const emails = await this.parseMessages(connection, messages);

    connection.end();
    this.logger.log(
      `IMAP SINCE matched ${messages.length} message(s); ${emails.length} had doc attachments`,
    );
    return { emails, imapMatchCount: messages.length };
  }

  /**
   * UNSEEN + SINCE(last N days), merged by Message-ID (unread copy wins).
   * Use for manual import / monitor so read mail is still picked up when it was never saved.
   */
  async fetchUnreadPlusRecentMerged(sinceDays: number = 21): Promise<ImapFetchOutcome> {
    const unread = await this.fetchUnreadEmails();
    const recent = await this.fetchRecentEmailsWithAttachments(sinceDays);
    const emails = this.mergePreferUnread(recent.emails, unread.emails);
    this.logger.log(
      `Merged inbox: UNSEEN ${unread.emails.length} + SINCE ${recent.emails.length} doc-mails → ${emails.length} unique`,
    );
    return {
      emails,
      imapMatchCount: unread.imapMatchCount + recent.imapMatchCount,
      unreadImapHits: unread.imapMatchCount,
      recentImapHits: recent.imapMatchCount,
    };
  }

  /** Same Message-ID only once; `unread` entries overwrite `recent` for the same key. */
  mergePreferUnread(recent: IncomingEmail[], unread: IncomingEmail[]): IncomingEmail[] {
    const map = new Map<string, IncomingEmail>();
    let anonSeq = 0;
    const keyOf = (e: IncomingEmail) => {
      const c = canonicalMessageId(e.messageId);
      return c || `__noid_${anonSeq++}`;
    };
    for (const e of recent) {
      map.set(keyOf(e), e);
    }
    for (const e of unread) {
      map.set(keyOf(e), e);
    }
    return [...map.values()];
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

      // Filter to PDF/XLS/CSV attachments (PO + GRN)
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
          messageId: (headerData['message-id']?.[0] || '').trim(),
          from: decodeMimeWords(headerData['from']?.[0] || ''),
          subject: decodeMimeWords(headerData['subject']?.[0] || ''),
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
    if (!message.attributes.struct) return [];

    const parts = imapSimple.getParts(message.attributes.struct);
    const attachments: EmailAttachment[] = [];

    for (const part of parts) {
      if (!part.partID) continue;

      const dispositionType = part.disposition?.type?.toUpperCase();
      const rawName =
        part.disposition?.params?.filename ||
        (part.disposition?.params as Record<string, string> | undefined)?.['filename*'] ||
        part.params?.name ||
        '';
      let filename = this.normalizeAttachmentFilename(rawName);
      const contentType = `${part.type}/${part.subtype}`.toLowerCase();

      const extOk = PO_FILE_EXTENSIONS.some((e) => filename.toLowerCase().endsWith(e));
      const mimeOk =
        PO_ATTACHMENT_TYPES.includes(contentType) ||
        contentType === 'application/pdf' ||
        contentType.includes('spreadsheet') ||
        contentType.includes('excel') ||
        contentType.includes('csv');

      const isAttachment = dispositionType === 'ATTACHMENT';
      const isInlineFile = dispositionType === 'INLINE' && !!filename;
      const isBareNamed =
        !dispositionType && !!filename && extOk && (mimeOk || contentType === 'application/octet-stream');
      const isBarePdf =
        !dispositionType && !filename && contentType === 'application/pdf';

      if (isBarePdf) {
        filename = `attachment-${part.partID}.pdf`;
      }

      if (!isAttachment && !isInlineFile && !isBareNamed && !isBarePdf) continue;

      if ((contentType === 'text/html' || contentType === 'text/plain') && !extOk) continue;

      if (!mimeOk && !extOk) continue;

      try {
        const partData = await connection.getPartData(message, part);
        const content = Buffer.isBuffer(partData)
          ? partData
          : Buffer.from(partData as string, 'utf-8');
        attachments.push({
          filename: filename || `part-${part.partID}`,
          content,
          contentType: `${part.type}/${part.subtype}`,
        });
      } catch (e) {
        this.logger.warn(`Skipping part ${part.partID}: ${e instanceof Error ? e.message : e}`);
      }
    }

    return attachments;
  }

  private normalizeAttachmentFilename(raw: string): string {
    let s = decodeMimeWords(raw || '').trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    }
    const star = /^([^']*)''(.+)$/i.exec(s);
    if (star) {
      try {
        s = decodeURIComponent(star[2]);
      } catch {
        s = star[2];
      }
    }
    return s.trim();
  }
}
