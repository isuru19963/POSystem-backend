import { registerAs } from '@nestjs/config';

export default registerAs('email', () => ({
  imap: {
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASSWORD,
    /**
     * Port 993 is TLS-wrapped IMAP. Treating “unset” as TLS off broke Gmail
     * and most providers when IMAP_TLS was omitted from env.
     */
    tls:
      process.env.IMAP_TLS === 'false' || process.env.IMAP_TLS === '0'
        ? false
        : true,
    /** Skip Gmail X-GM-RAW and use RFC SEARCH SINCE/ALL (debug or odd setups). */
    forceStandardSearch: process.env.IMAP_FORCE_STANDARD_SEARCH === 'true',
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
  },
}));
