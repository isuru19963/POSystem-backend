/** Eggs per crate (standard) */
export const EGGS_PER_CRATE = 210;

/** Queue names */
export const QUEUE_NAMES = {
  PO_PROCESSING: 'po-processing',
  PDF_EXTRACTION: 'pdf-extraction',
  PRICE_VALIDATION: 'price-validation',
  ALERT_DISPATCH: 'alert-dispatch',
  NECC_FETCH: 'necc-fetch',
  EMAIL_MONITORING: 'email-monitoring',
  GRN_PROCESSING: 'grn-processing',
} as const;

/** Job names */
export const JOB_NAMES = {
  PROCESS_PO_EMAIL: 'process-po-email',
  EXTRACT_PDF: 'extract-pdf',
  VALIDATE_PRICES: 'validate-prices',
  SEND_ALERT: 'send-alert',
  FETCH_NECC_RATES: 'fetch-necc-rates',
  MONITOR_INBOX: 'monitor-inbox',
  PROCESS_GRN: 'process-grn',
} as const;
