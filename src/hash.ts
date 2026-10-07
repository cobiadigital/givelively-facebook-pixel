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

/** Meta: city lowercase, no spaces or punctuation. */
export function normalizeCity(city: string): string | undefined {
  const c = city.trim().toLowerCase().replace(/[\p{P}\p{S}\s\d]/gu, "");
  return c || undefined;
}

/** Meta: 2-letter state/province code, lowercase. Longer names are lowercased without spaces. */
export function normalizeState(state: string): string | undefined {
  const s = state.trim().toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
  return s || undefined;
}

/** Meta: lowercase, no spaces or dashes. US ZIP codes use the first 5 digits only. */
export function normalizeZip(zip: string): string | undefined {
  const z = zip.trim().toLowerCase().replace(/[\s-]/g, "");
  if (/^\d{5}(\d{4})?$/.test(z)) return z.slice(0, 5);
  return z || undefined;
}

/** Meta: ISO 3166-1 alpha-2 country code, lowercase. */
export function normalizeCountry(country: string): string | undefined {
  const c = country.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(c)) return c;
  if (["usa", "united states", "united states of america"].includes(c)) return "us";
  return undefined;
}
