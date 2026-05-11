/**
 * Decode RFC 2047 encoded-words in headers (common for Subject / filenames).
 * Handles =?UTF-8?B?...?= and basic =?UTF-8?Q?...?= fragments.
 */
export function decodeMimeWords(input: string): string {
  if (!input || !input.includes('=?')) return input;

  return input.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (full, charset, enc, text) => {
    const encU = String(enc).toUpperCase();
    try {
      if (encU === 'B') {
        const buf = Buffer.from(String(text).replace(/\s+/g, ''), 'base64');
        const cs = String(charset).toUpperCase();
        if (cs.includes('UTF-8')) return buf.toString('utf8');
        return buf.toString('latin1');
      }
      if (encU === 'Q') {
        return String(text)
          .replace(/_/g, ' ')
          .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      }
    } catch {
      return full;
    }
    return full;
  });
}
