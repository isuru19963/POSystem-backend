/** Twilio/WhatsApp: free-form messages only work inside the 24h customer care window. */
export class WhatsAppSessionClosedError extends Error {
  readonly code = 'WHATSAPP_SESSION_CLOSED';

  constructor(
    message: string,
    readonly twilioCode?: number,
  ) {
    super(message);
    this.name = 'WhatsAppSessionClosedError';
  }
}

export function isOutsideSessionWindow(err: unknown): boolean {
  const code =
    (err as { code?: number })?.code ??
    (err as { status?: number })?.status;
  // 63016 = outside allowed window; 63032 = experiment / session restriction
  return code === 63016 || code === 63032;
}

export function formatWhatsAppSendError(err: unknown): string {
  if (err instanceof WhatsAppSessionClosedError) {
    return err.message;
  }
  if (isOutsideSessionWindow(err)) {
    return (
      'WhatsApp 24-hour window closed — recipient must message your business ' +
      'number first, or configure an approved message template (TWILIO_WHATSAPP_TEMPLATE_OUTSIDE_SESSION).'
    );
  }
  return err instanceof Error ? err.message : String(err);
}
