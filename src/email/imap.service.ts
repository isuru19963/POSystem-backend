import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as imapSimple from 'imap-simple';
import { decodeMimeWords } from './mime-word.util';
import {
  canonicalMessageId,
  messageIdSearchVariants,
} from '../common/utils/email-message-id.util';

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

/**
 * Wrap a promise with a timeout. On expiry the original promise continues
 * in the background (to avoid resource leaks we don't cancel it), but the
 * caller receives a rejection immediately so it can move on.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err)   => { clearTimeout(timer); reject(err); },
    );
  });
}

// ── Timeouts ─────────────────────────────────────────────────────────────────
const IMAP_CONNECT_TIMEOUT_MS = 120_000;  // 2 min — Gmail can be slow to authenticate
const IMAP_SEARCH_TIMEOUT_MS  = 3 * 60_000; // 3 min — per SEARCH + FETCH (header+struct)
/**
 * Gmail throttles IMAP FETCH on bulk mailboxes to ~3 seconds per attachment
 * download even at 8-way concurrency. 220 messages observed at ~22 s/message
 * wall-clock (~80 min total). Set the parse cap generously so a single big
 * mailbox scan can finish in one job rather than aborting mid-batch and
 * leaving the IMAP socket in a half-closed state.
 */
const IMAP_PARSE_TIMEOUT_MS   = 90 * 60_000; // 90 min — getPartData downloads for all candidates
/** Idle connection kept open to skip the 90-s reconnect on the next job. */
const IMAP_CONN_IDLE_MS       = 9 * 60_000; // close after 9 min without use

// ── Supported attachment filters ──────────────────────────────────────────────
/** Supported PO attachment MIME types — images excluded (every business email
 *  has a logo; including image/* causes hundreds of irrelevant downloads). */
const PO_ATTACHMENT_TYPES = [
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream',
  'text/csv',
  'application/csv',
];

const PO_FILE_EXTENSIONS = ['.pdf', '.xls', '.xlsx', '.csv', '.doc', '.docx'];

// ── Gmail search query for doc attachments (server-side, no body download) ───
const GMAIL_DOC_QUERY =
  'has:attachment (filename:pdf OR filename:xls OR filename:xlsx OR filename:csv OR filename:doc OR filename:docx)';

@Injectable()
export class ImapService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImapService.name);

  /**
   * Persistent connection pool (size 1).
   *
   * Connecting to Gmail IMAP takes 70–90 s (TCP handshake + auth + SELECT
   * INBOX). By keeping the connection alive between jobs we eliminate this
   * cost for every job after the first — a scan that previously took 6+
   * minutes now takes < 30 s.
   */
  private poolConn: imapSimple.ImapSimple | null = null;
  private poolPromise: Promise<imapSimple.ImapSimple> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    // Warm the connection in the background so the first job doesn't pay the
    // full connect cost. Ignore warm-up failures — the job will retry.
    void this.acquireConn().catch((err) =>
      this.logger.warn(
        `IMAP warm-up failed (will retry on first job): ${err instanceof Error ? err.message : err}`,
      ),
    );
  }

  onModuleDestroy(): void {
    this.evictPool();
  }

  // ── Connection pool helpers ─────────────────────────────────────────────────

  private getConfig(): imapSimple.ImapSimpleOptions {
    return {
      imap: {
        user:     this.configService.get<string>('email.imap.user') || '',
        password: this.configService.get<string>('email.imap.password') || '',
        host:     this.configService.get<string>('email.imap.host') || '',
        port:     this.configService.get<number>('email.imap.port') || 993,
        tls:      this.configService.get<boolean>('email.imap.tls') !== false,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 60_000,
        authTimeout: 60_000,
      },
    };
  }

  /** Gmail / Google Mail IMAP supports X-GM-RAW; other hosts need RFC SEARCH. */
  private useGmailXRawSearch(): boolean {
    if (this.configService.get<boolean>('email.imap.forceStandardSearch')) {
      return false;
    }
    const host = (this.configService.get<string>('email.imap.host') || '').toLowerCase();
    return host.includes('gmail') || host.includes('googlemail');
  }

  /** IMAP SEARCH SINCE date string (e.g. 12-May-2026). */
  private toImapSinceDate(d: Date): string {
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
  }

  private evictPool(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.poolConn) {
      try { this.poolConn.end(); } catch { /* ignore */ }
      this.poolConn = null;
    }
    this.poolPromise = null;
  }

  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.logger.debug('IMAP pool idle — closing connection');
      this.evictPool();
    }, IMAP_CONN_IDLE_MS);
  }

  /**
   * Return the pooled IMAP connection, establishing a new one if needed.
   * Only one connect attempt runs at a time (subsequent callers await the
   * same promise). On disconnect, the pool clears so the next caller
   * triggers a fresh connection.
   */
  private async acquireConn(): Promise<imapSimple.ImapSimple> {
    if (this.poolConn) {
      this.touchIdleTimer();
      return this.poolConn;
    }

    if (this.poolPromise) return this.poolPromise;

    this.poolPromise = (async () => {
      this.logger.log('Establishing persistent IMAP connection...');
      const conn = await withTimeout(
        imapSimple.connect(this.getConfig()),
        IMAP_CONNECT_TIMEOUT_MS,
        'IMAP connect',
      );
      await withTimeout(conn.openBox('INBOX'), 60_000, 'IMAP openBox');

      // Evict pool on unexpected close / error
      const raw = (conn as unknown as { imap: NodeJS.EventEmitter }).imap;
      const evict = (reason: string) => () => {
        this.logger.warn(`IMAP pool evicted (${reason}) — will reconnect on next use`);
        this.poolConn = null;
        this.poolPromise = null;
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      };
      raw.once('close', evict('close'));
      raw.once('error', evict('error'));
      raw.once('end',   evict('end'));

      this.poolConn    = conn;
      this.poolPromise = null;
      this.touchIdleTimer();
      this.logger.log('Persistent IMAP connection ready');
      return conn;
    })().catch((err) => {
      this.poolPromise = null;
      throw err;
    });

    return this.poolPromise;
  }

  /** Count of in-flight `withConn` calls. While > 0, suppress idle eviction. */
  private inflight = 0;

  private pauseIdleTimer(): void {
    this.inflight += 1;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  private resumeIdleTimer(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.inflight === 0 && this.poolConn) {
      this.touchIdleTimer();
    }
  }

  /**
   * Run `fn(conn)` with automatic retry on pool eviction.
   *
   * Long IMAP parse loops (220+ attachment downloads can take 15+ min) used to
   * trip the 9-min idle timer mid-fetch, closing the connection while it was
   * still actively being used. The retry then restarted the full SEARCH from
   * zero, so the same eviction kept recurring and the scan never finished.
   *
   * We now pause the idle timer for the entire duration of every `withConn`
   * call and re-arm it only after the operation returns.
   */
  private async withConn<T>(
    fn: (conn: imapSimple.ImapSimple) => Promise<T>,
  ): Promise<T> {
    const conn = await this.acquireConn();
    this.pauseIdleTimer();
    try {
      return await fn(conn);
    } catch (err) {
      // If the pool was evicted (close/error handler fired), try once more
      if (!this.poolConn && !this.poolPromise) {
        this.logger.warn('Pool was evicted mid-operation — reconnecting and retrying once');
        const fresh = await this.acquireConn();
        return await fn(fresh);
      }
      // Timeouts leave the IMAP socket mid-FETCH; subsequent SEARCH calls on
      // the same connection silently returned 0 hits. Force a clean session.
      const msg = err instanceof Error ? err.message : String(err);
      if (/timed out/i.test(msg)) {
        this.logger.warn(
          `IMAP op timed out — evicting pool so the next call starts fresh: ${msg}`,
        );
        this.evictPool();
      }
      throw err;
    } finally {
      this.resumeIdleTimer();
    }
  }

  // ── Public fetch methods ────────────────────────────────────────────────────

  async fetchUnreadEmails(): Promise<ImapFetchOutcome> {
    return this.withConn(async (conn) => {
      const messages = await withTimeout(
        conn.search(['UNSEEN'], {
          bodies: ['HEADER'],
          markSeen: true,
          struct: true,
        }),
        IMAP_SEARCH_TIMEOUT_MS,
        'IMAP UNSEEN search',
      );
      const emails = await withTimeout(
        this.parseMessages(conn, messages),
        IMAP_PARSE_TIMEOUT_MS,
        'IMAP UNSEEN parse',
      );
      this.logger.log(
        `IMAP UNSEEN: ${messages.length} message(s), ${emails.length} had doc attachments`,
      );
      return { emails, imapMatchCount: messages.length };
    });
  }

  /**
   * Scan the inbox for PO/GRN emails.
   *
   * On Gmail (`imap.gmail.com` / `imap.googlemail.com`), uses `X-GM-RAW` so the
   * server pre-filters messages that have doc-like attachments — fast.
   *
   * On other IMAP servers (Outlook, Zoho, etc.), uses RFC `SEARCH SINCE` or
   * `SEARCH ALL` and filters attachments in this process — required because
   * `X-GM-RAW` is Gmail-only; without this branch those hosts returned no mail.
   *
   * Set `IMAP_FORCE_STANDARD_SEARCH=true` to use the RFC path even on Gmail.
   */
  /**
   * Scan effectively the full inbox, but bound the Gmail X-GM-RAW query to a
   * wide window. Unbounded `X-GM-RAW` queries against this mailbox observed
   * returning zero results (no error) on every invocation — Gmail appears to
   * silently drop overly broad searches once the result set crosses a server
   * threshold. A 5-year `after:` clause still covers every historical PO/GRN
   * and reliably returns the doc-attached set.
   */
  async fetchAllEmails(): Promise<ImapFetchOutcome> {
    return this.fetchRecentEmailsWithAttachments(365 * 5);
  }

  /**
   * Fetch one mailbox message by RFC Message-ID (re-download PO attachments).
   * Tries Gmail `rfc822msgid:` or standard `HEADER Message-ID` search.
   */
  async fetchEmailByMessageId(messageId: string): Promise<IncomingEmail | null> {
    const variants = messageIdSearchVariants(messageId);
    if (!variants.length) return null;

    const target = canonicalMessageId(messageId);
    this.logger.log(`IMAP lookup by Message-ID (${variants.length} variant(s))`);

    return this.withConn(async (conn) => {
      let messages: imapSimple.Message[] = [];

      if (this.useGmailXRawSearch()) {
        for (const id of variants) {
          const inner = id.replace(/^<|>$/g, '').trim();
          if (!inner) continue;
          const found = await withTimeout(
            conn.search([['X-GM-RAW', `rfc822msgid:${inner}`]], {
              bodies: ['HEADER'],
              markSeen: false,
              struct: true,
            }),
            IMAP_SEARCH_TIMEOUT_MS,
            `Gmail rfc822msgid lookup`,
          );
          if (found.length) {
            messages = found;
            break;
          }
        }
      } else {
        for (const id of variants) {
          const inner = id.replace(/^<|>$/g, '').trim();
          if (!inner) continue;
          const found = await withTimeout(
            conn.search([['HEADER', 'Message-ID', inner]], {
              bodies: ['HEADER'],
              markSeen: false,
              struct: true,
            }),
            IMAP_SEARCH_TIMEOUT_MS,
            `HEADER Message-ID lookup`,
          );
          if (found.length) {
            messages = found;
            break;
          }
        }
      }

      if (!messages.length) {
        this.logger.warn(`No IMAP message found for Message-ID ${messageId}`);
        return null;
      }

      const emails = await withTimeout(
        this.parseMessages(conn, messages),
        IMAP_PARSE_TIMEOUT_MS,
        'IMAP parse single message',
      );

      return (
        emails.find((e) => canonicalMessageId(e.messageId) === target) ??
        emails[0] ??
        null
      );
    });
  }

  async fetchRecentEmailsWithAttachments(sinceDays: number = 21): Promise<ImapFetchOutcome> {
    const label = sinceDays > 0 ? `last ${sinceDays}d` : 'all time';
    return this.withConn(async (conn) => {
      const useGmailRaw = this.useGmailXRawSearch();
      let messages: imapSimple.Message[];

      if (useGmailRaw) {
        let gmailQuery = GMAIL_DOC_QUERY;
        if (sinceDays > 0) {
          const since = new Date();
          since.setHours(0, 0, 0, 0);
          since.setDate(since.getDate() - sinceDays);
          const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, '/');
          gmailQuery += ` after:${sinceStr}`;
        }

        this.logger.log(`Gmail X-GM-RAW doc search (${label})...`);
        messages = await withTimeout(
          conn.search([['X-GM-RAW', gmailQuery]], {
            bodies: ['HEADER'],
            markSeen: false,
            struct: true,
          }),
          IMAP_SEARCH_TIMEOUT_MS,
          `Gmail doc-attachment search (${label})`,
        );
        this.logger.log(`Gmail (${label}): ${messages.length} message(s) (X-GM-RAW hits)`);
      } else {
        const since =
          sinceDays > 0
            ? (() => {
                const d = new Date();
                d.setHours(0, 0, 0, 0);
                d.setDate(d.getDate() - sinceDays);
                return d;
              })()
            : null;

        this.logger.log(
          sinceDays > 0
            ? `Standard IMAP SINCE ${this.toImapSinceDate(since!)} (${label}) — doc filter client-side`
            : `Standard IMAP ALL (${label}) — doc filter client-side (large mailboxes may be slow)`,
        );

        messages = await withTimeout(
          sinceDays > 0
            ? conn.search([['SINCE', this.toImapSinceDate(since!)]], {
                bodies: ['HEADER'],
                markSeen: false,
                struct: true,
              })
            : conn.search(['ALL'], {
                bodies: ['HEADER'],
                markSeen: false,
                struct: true,
              }),
          IMAP_SEARCH_TIMEOUT_MS,
          `IMAP ${sinceDays > 0 ? 'SINCE' : 'ALL'} search (${label})`,
        );
        this.logger.log(
          `IMAP (${label}): ${messages.length} message(s) in search window before attachment filter`,
        );
      }

      if (messages.length === 0) {
        return { emails: [], imapMatchCount: 0 };
      }

      const emails = await withTimeout(
        this.parseMessages(conn, messages),
        IMAP_PARSE_TIMEOUT_MS,
        `IMAP parse+getPartData (${label})`,
      );

      this.logger.log(
        `IMAP (${label}) done: ${messages.length} scanned → ${emails.length} with doc attachments (PO/GRN filters)`,
      );
      return { emails, imapMatchCount: messages.length };
    });
  }

  /**
   * UNSEEN merged with SINCE-N-days (unread copy wins on same Message-ID).
   * If the SINCE scan fails, we surface UNSEEN results only.
   */
  async fetchUnreadPlusRecentMerged(sinceDays: number = 21): Promise<ImapFetchOutcome> {
    const unread = await this.fetchUnreadEmails();

    let recentEmails: IncomingEmail[] = [];
    let recentHits = 0;
    try {
      const recent = await this.fetchRecentEmailsWithAttachments(sinceDays);
      recentEmails = recent.emails;
      recentHits   = recent.imapMatchCount;
    } catch (err) {
      this.logger.warn(
        `SINCE-${sinceDays}d scan failed, using UNSEEN only: ${err instanceof Error ? err.message : err}`,
      );
    }

    const emails = this.mergePreferUnread(recentEmails, unread.emails);
    this.logger.log(
      `Merged inbox: UNSEEN ${unread.emails.length} + SINCE ${recentEmails.length} → ${emails.length} unique`,
    );
    return {
      emails,
      imapMatchCount: unread.imapMatchCount + recentHits,
      unreadImapHits: unread.imapMatchCount,
      recentImapHits: recentHits,
    };
  }

  /** Same Message-ID only once; unread copy overwrites recent. */
  mergePreferUnread(recent: IncomingEmail[], unread: IncomingEmail[]): IncomingEmail[] {
    const map = new Map<string, IncomingEmail>();
    let anonSeq = 0;
    const keyOf = (e: IncomingEmail) => {
      const c = canonicalMessageId(e.messageId);
      return c || `__noid_${anonSeq++}`;
    };
    for (const e of recent) map.set(keyOf(e), e);
    for (const e of unread) map.set(keyOf(e), e);
    return [...map.values()];
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Process a batch of messages, downloading their qualifying attachments in
   * parallel (up to PARSE_CONCURRENCY at a time). Gmail IMAP supports pipelined
   * FETCH — concurrent `getPartData` calls use different IMAP tags and resolve
   * independently, so parallelism is safe and dramatically cuts wall-clock time:
   *   220 PDFs × 1.5 s each sequential = 330 s
   *   220 PDFs ÷ 8 parallel          ≈  40 s
   */
  private static readonly PARSE_CONCURRENCY = 8;

  private async parseMessages(
    connection: imapSimple.ImapSimple,
    messages: imapSimple.Message[],
  ): Promise<IncomingEmail[]> {
    const emails: IncomingEmail[] = [];
    const C = ImapService.PARSE_CONCURRENCY;

    for (let i = 0; i < messages.length; i += C) {
      const batch = messages.slice(i, i + C);
      const results = await Promise.allSettled(
        batch.map((msg) => this.processOneMessage(connection, msg)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) emails.push(r.value);
        else if (r.status === 'rejected') {
          this.logger.warn(`processOneMessage error: ${(r.reason as Error)?.message ?? r.reason}`);
        }
      }
      if (messages.length > C) {
        this.logger.log(
          `Parsed ${Math.min(i + C, messages.length)}/${messages.length} — doc-mails so far: ${emails.length}`,
        );
      }
    }

    return emails;
  }

  private async processOneMessage(
    connection: imapSimple.ImapSimple,
    message: imapSimple.Message,
  ): Promise<IncomingEmail | null> {
    const header = message.parts.find((p) => p.which === 'HEADER');
    if (!header) return null;

    const headerData = header.body as Record<string, string[]>;
    const subject = decodeMimeWords(headerData['subject']?.[0] || '');
    const from    = decodeMimeWords(headerData['from']?.[0] || '');

    // Quick struct pre-check — skip getPartData if no qualifying doc part
    if (!this.hasDocInStruct(message)) {
      this.logger.log(
        `Skip "${this.truncate(subject, 80)}" from ${this.truncate(from, 50)} — parts: ${this.summarizeStructure(message)}`,
      );
      return null;
    }

    const attachments = await this.extractAttachments(connection, message);

    const poAttachments = attachments.filter((a) => {
      const ext = a.filename.toLowerCase();
      return (
        PO_ATTACHMENT_TYPES.includes(a.contentType.toLowerCase()) ||
        PO_FILE_EXTENSIONS.some((e) => ext.endsWith(e))
      );
    });

    if (poAttachments.length > 0) {
      return {
        messageId: (headerData['message-id']?.[0] || '').trim(),
        from,
        subject,
        body: '',
        date: new Date(headerData['date']?.[0] || ''),
        attachments: poAttachments,
      };
    }

    this.logger.log(
      `Skip "${this.truncate(subject, 80)}" from ${this.truncate(from, 60)} — parts: ${this.summarizeStructure(message)}`,
    );
    return null;
  }

  private hasDocInStruct(message: imapSimple.Message): boolean {
    if (!message.attributes.struct) return false;
    const parts = imapSimple.getParts(message.attributes.struct);
    return parts.some((part) => {
      const contentType = `${part.type ?? ''}/${part.subtype ?? ''}`.toLowerCase();
      const rawName =
        part.disposition?.params?.filename ||
        (part.disposition?.params as Record<string, string> | undefined)?.['filename*'] ||
        part.params?.name ||
        '';
      const filename = String(rawName).toLowerCase();
      const extOk  = PO_FILE_EXTENSIONS.some((e) => filename.endsWith(e));
      const mimeOk =
        PO_ATTACHMENT_TYPES.includes(contentType) ||
        contentType.includes('spreadsheet') ||
        contentType.includes('excel') ||
        contentType.includes('msword') ||
        contentType.includes('wordprocessing') ||
        contentType === 'application/pdf';
      return (extOk || mimeOk) && (filename !== '' || contentType === 'application/pdf');
    });
  }

  private summarizeStructure(message: imapSimple.Message): string {
    if (!message.attributes.struct) return '(no struct)';
    const parts = imapSimple.getParts(message.attributes.struct);
    const items = parts.map((p) => {
      const fn =
        p.disposition?.params?.filename ||
        (p.disposition?.params as Record<string, string> | undefined)?.['filename*'] ||
        p.params?.name ||
        '';
      const mime = `${p.type ?? ''}/${p.subtype ?? ''}`.toLowerCase();
      const disp = (p.disposition?.type || 'none').toLowerCase();
      return `${disp}:${mime}${fn ? ` "${this.truncate(fn, 50)}"` : ''}`;
    });
    return items.length ? items.join(' | ') : '(no parts)';
  }

  private truncate(s: string, max: number): string {
    if (!s) return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  private async extractAttachments(
    connection: imapSimple.ImapSimple,
    message: imapSimple.Message,
  ): Promise<EmailAttachment[]> {
    if (!message.attributes.struct) return [];

    const parts       = imapSimple.getParts(message.attributes.struct);
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

      const extOk  = PO_FILE_EXTENSIONS.some((e) => filename.toLowerCase().endsWith(e));
      const mimeOk =
        PO_ATTACHMENT_TYPES.includes(contentType) ||
        contentType === 'application/pdf' ||
        contentType.includes('spreadsheet') ||
        contentType.includes('excel') ||
        contentType.includes('csv') ||
        contentType.includes('msword') ||
        contentType.includes('wordprocessing');

      const isAttachment = dispositionType === 'ATTACHMENT';
      const isInlineFile = dispositionType === 'INLINE' && !!filename;
      const isBareNamed  = !dispositionType && !!filename && extOk && (mimeOk || contentType === 'application/octet-stream');
      const isBarePdf    = !dispositionType && !filename && contentType === 'application/pdf';

      if (isBarePdf) filename = `attachment-${part.partID}.pdf`;
      if (!isAttachment && !isInlineFile && !isBareNamed && !isBarePdf) continue;
      if ((contentType === 'text/html' || contentType === 'text/plain') && !extOk) continue;
      if (!mimeOk && !extOk) continue;

      try {
        const partData = await connection.getPartData(message, part);
        const content  = Buffer.isBuffer(partData)
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
      try { s = decodeURIComponent(star[2]); } catch { s = star[2]; }
    }
    return s.trim();
  }
}
