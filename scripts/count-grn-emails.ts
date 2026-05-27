/**
 * Count GRN-like emails in IMAP (headers + attachment names only — no PDF download).
 * Usage: npx ts-node -r tsconfig-paths/register scripts/count-grn-emails.ts [sinceDays]
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as imapSimple from 'imap-simple';
import { decodeMimeWords } from '../src/email/mime-word.util';
import {
  isGrnInboundEmail,
  isGrnInboxCandidate,
  pickPrimaryGrnPdf,
  type GrnEmailAttachmentLike,
} from '../src/email/grn-email.util';

dotenv.config({ path: path.join(__dirname, '../.env') });

const sinceDays = parseInt(process.argv[2] || '180', 10);

const GMAIL_DOC_QUERY =
  'has:attachment (filename:pdf OR filename:xls OR filename:xlsx OR filename:csv OR filename:doc OR filename:docx)';

const DOC_EXTS = ['.pdf', '.xls', '.xlsx', '.csv', '.doc', '.docx'];

function toImapSince(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

function structFilenames(message: imapSimple.Message): GrnEmailAttachmentLike[] {
  if (!message.attributes?.struct) return [];
  const parts = imapSimple.getParts(message.attributes.struct);
  const out: GrnEmailAttachmentLike[] = [];
  for (const part of parts) {
    const raw =
      part.disposition?.params?.filename ||
      (part.disposition?.params as Record<string, string> | undefined)?.['filename*'] ||
      part.params?.name ||
      '';
    const filename = decodeMimeWords(String(raw));
    if (!filename) continue;
    const ext = filename.toLowerCase();
    if (!DOC_EXTS.some((e) => ext.endsWith(e))) continue;
    const contentType = `${part.type ?? ''}/${part.subtype ?? ''}`.toLowerCase();
    out.push({ filename, contentType, content: Buffer.alloc(0) });
  }
  return out;
}

async function main() {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const password = process.env.IMAP_PASSWORD;
  const port = parseInt(process.env.IMAP_PORT || '993', 10);
  const tls = process.env.IMAP_TLS !== 'false';

  if (!host || !user || !password) {
    throw new Error('Set IMAP_HOST, IMAP_USER, IMAP_PASSWORD in backend/.env');
  }

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - sinceDays);

  const useGmailRaw =
    process.env.IMAP_FORCE_STANDARD_SEARCH !== 'true' &&
    /gmail\.com|googlemail\.com/i.test(host);

  console.log(`\nMailbox: ${user} @ ${host}`);
  console.log(`Window: last ${sinceDays} days (since ${since.toISOString().slice(0, 10)})\n`);
  console.log('Connecting…');

  const conn = await imapSimple.connect({
    imap: {
      host,
      port,
      user,
      password,
      tls,
      authTimeout: 120_000,
      connTimeout: 120_000,
      tlsOptions: { rejectUnauthorized: false },
    },
  });
  await conn.openBox('INBOX');

  let messages: imapSimple.Message[];
  if (useGmailRaw) {
    const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, '/');
    const q = `${GMAIL_DOC_QUERY} after:${sinceStr}`;
    console.log(`Gmail search: ${q.slice(0, 80)}…`);
    messages = await conn.search([['X-GM-RAW', q]], {
      bodies: ['HEADER'],
      markSeen: false,
      struct: true,
    });
  } else {
    console.log(`IMAP SINCE ${toImapSince(since)}…`);
    messages = await conn.search([['SINCE', toImapSince(since)]], {
      bodies: ['HEADER'],
      markSeen: false,
      struct: true,
    });
  }

  console.log(`IMAP returned ${messages.length} message(s) with doc-like attachments.\n`);

  const rows: { subject: string; messageId: string; attachments: GrnEmailAttachmentLike[] }[] = [];

  for (const msg of messages) {
    const header = msg.parts.find((p) => p.which === 'HEADER');
    if (!header) continue;
    const h = header.body as Record<string, string[]>;
    const subject = decodeMimeWords(h['subject']?.[0] || '');
    const attachments = structFilenames(msg);
    if (!attachments.length) continue;
    rows.push({
      subject,
      messageId: (h['message-id']?.[0] || '').trim(),
      attachments,
    });
  }

  const strict = rows.filter((r) => isGrnInboundEmail(r.subject, r.attachments));
  const candidates = rows.filter((r) => isGrnInboxCandidate(r.subject, r.attachments));
  const withPdf = candidates.filter((r) =>
    pickPrimaryGrnPdf(r.subject, r.attachments),
  );

  console.log('── GRN email counts (same rules as “Fetch GRNs from Email”) ──');
  console.log(`  Emails with PDF/doc attachment:     ${rows.length}`);
  console.log(`  Strict GRN (subject / GRN filename): ${strict.length}`);
  console.log(`  GRN candidates (import scan):       ${candidates.length}`);
  console.log(`  With a pickable GRN PDF:            ${withPdf.length}`);

  if (candidates.length > 0) {
    console.log('\n── Sample subjects (up to 12) ──');
    for (const r of candidates.slice(0, 12)) {
      const pdfs = r.attachments.filter((a) => a.filename.toLowerCase().endsWith('.pdf'));
      const fn = pdfs[0]?.filename ?? r.attachments[0]?.filename ?? '';
      console.log(`  • ${r.subject.slice(0, 90)}${fn ? ` [${fn}]` : ''}`);
    }
  }

  conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
