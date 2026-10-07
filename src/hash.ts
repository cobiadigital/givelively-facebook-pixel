/** SHA-256, hex encoded, via Web Crypto. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Meta: trim and lowercase. */
export function normalizeEmail(email: string): string | undefined {
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : undefined;
}

/** Meta: lowercase, no punctuation, UTF-8 letters kept. */
export function normalizeName(name: string): string | undefined {
  const n = name
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, "");
  return n || undefined;
}

/**
 * Meta: digits only, including country code. 10-digit numbers are assumed to be
 * US/Canada and get a leading 1.
 */
export function normalizePhone(phone: string): string | undefined {
  const d = phone.replace(/\D/g, "");
  if (d.length === 10) return `1${d}`;
  if (d.length >= 11 && d.length <= 15) return d;
  return undefined;
}
