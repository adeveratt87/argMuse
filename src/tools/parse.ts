/**
 * Parsers that turn the Argos MCP's text output into structured product data.
 *
 * Formats (see docs/upstream-contract.md):
 *   searchProducts: header lines ("Search Results", "Total Products Found: 18")
 *                   then lines "ID: 7615436, Product: <name>, Price: 119.0"
 *   fetchProduct:   labelled parts "Name: …", "Link: …", "Description: <html>",
 *                   "Price: £5.0", a promotional badge line, in one or more blocks.
 *
 * Rules: never invent values. A field that is absent stays null; a price is
 * never defaulted to 0; promotion codes are passed through without a label.
 * Text that looks like product data but cannot be parsed raises ParseError so
 * the tool fails loudly instead of returning half-parsed results.
 */
import { LIMITS } from "../config.js";
import { cleanText } from "./sanitize.js";

export class ParseError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "ParseError";
  }
}

export const CURRENCY = "GBP" as const;
const PRODUCT_HOSTS = new Set(["argos.co.uk", "www.argos.co.uk"]);
const MAX_NAME = 500;
const MAX_DESCRIPTION = 5000;
const MAX_PROMO_CODE = 100;

// ---------- primitives ----------

/** Fixes the "Â£"-style UTF-8 mojibake Argos sometimes emits before symbols and spaces. */
export function fixMojibake(s: string): string {
  return s.replace(/Â(?=[£©®°±·¼½¾ ])/g, "");
}

/** "£1,299.00", "Â£5.0", "119.0" → number; anything else → null. Never 0 for missing. */
export function parsePrice(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/.exec(raw);
  if (!m) return null;
  const n = Number(`${m[1]!.replace(/,/g, "")}${m[2] ?? ""}`);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

/** Product URL rule (approved): the form Argos's own fetchProduct links use. */
export function productUrl(id: string): string {
  return `https://argos.co.uk/product/${encodeURIComponent(id)}/`;
}

/** Accepts only https links on an Argos product host; otherwise null. */
export function safeArgosUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || !PRODUCT_HOSTS.has(u.hostname) || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", pound: "£", euro: "€",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…",
  deg: "°", times: "×", frac12: "½", frac14: "¼", frac34: "¾", reg: "®", copy: "©", trade: "™", bull: "•",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML → plain text. Nothing is rendered or executed: script/style/head blocks
 * (and their contents) are removed, block elements become line breaks, list
 * items become bullets, all other tags are dropped, entities are decoded.
 * Ordinary text — including safety warnings and dimensions — is kept as is.
 */
export function htmlToText(html: string): string {
  let s = fixMojibake(html);
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|head|template|noscript|iframe|object|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<(script|style|head|template|noscript|iframe|object|svg)\b[^>]*\/?>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n• ");
  s = s.replace(/<\/?(p|div|ul|ol|li|h[1-6]|tr|table|section|article|header|footer|blockquote)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/?(td|th)\b[^>]*>/gi, " ");
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/[<>]/g, ""); // stray brackets from malformed markup
  s = decodeEntities(s);
  // Entity-encoded markup (e.g. "&lt;script&gt;") must not survive as tag text either.
  s = s.replace(/<\/?[a-z!][^<>]*>/gi, " ");
  s = cleanText(s);
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n")
    .trim();
  return s.length > MAX_DESCRIPTION ? `${s.slice(0, MAX_DESCRIPTION).trimEnd()}…` : s;
}

function plain(s: string, max: number): string {
  const t = cleanText(fixMojibake(s)).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

// ---------- search ----------

export interface SearchProduct {
  id: string;
  name: string;
  price: number | null;
  currency: typeof CURRENCY | null;
  url: string | null;
}

export interface SearchStructured {
  products: SearchProduct[];
  totalCount: number | null;
}

const PRODUCT_LINE = /^ID:\s*([A-Za-z0-9]+)\s*,\s*Product:\s*(.+?)(?:\s*,\s*Price:\s*(.*?))?\s*$/i;
const LOOKS_LIKE_PRODUCT = /^\s*ID\s*:/i;
const TOTAL_LINE = /^\s*Total\s+Products\s+Found\s*:\s*(\d+)\s*$/i;

export function parseSearch(texts: string[]): SearchStructured {
  const products: SearchProduct[] = [];
  const seen = new Set<string>();
  let totalCount: number | null = null;

  for (const text of texts) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const total = TOTAL_LINE.exec(line);
      if (total) {
        totalCount = Number(total[1]);
        continue;
      }
      if (!LOOKS_LIKE_PRODUCT.test(line)) continue; // headers and other prose
      const m = PRODUCT_LINE.exec(line);
      const id = m?.[1];
      const name = m?.[2] ? plain(m[2], MAX_NAME) : "";
      if (!m || !id || id.length > LIMITS.productIdMaxLength || !name) {
        throw new ParseError("unrecognised search result line");
      }
      if (m[3] !== undefined && m[3] !== "" && parsePrice(m[3]) === null) {
        throw new ParseError("unrecognised price in search result");
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const price = parsePrice(m[3]);
      products.push({ id, name, price, currency: price === null ? null : CURRENCY, url: productUrl(id) });
    }
  }
  return { products, totalCount };
}

// ---------- product details ----------

export interface Promotion {
  code: string | null;
  label: string | null;
}

export interface ProductDetail {
  id: string;
  name: string;
  url: string;
  description: string | null;
  price: number | null;
  currency: typeof CURRENCY | null;
  promotion: Promotion | null;
}

type Field = "name" | "link" | "description" | "price" | "promotion" | "header";

const LABELS: [Field, RegExp][] = [
  ["header", /^\s*Product\s+Information\s+for\b\s*(.*)$/i],
  ["name", /^\s*(?:Name|Product\s+Name|Title)\s*:\s*(.*)$/i],
  ["link", /^\s*(?:Link|URL|Product\s+URL)\s*:\s*(.*)$/i],
  ["description", /^\s*Description\s*:\s*(.*)$/i],
  ["price", /^\s*Price\s*:\s*(.*)$/i],
  ["promotion", /^\s*(?:Promotional\s+Badge|Promotion(?:al)?|Promo(?:tion)?\s+Badge|Badges?)\s*:\s*(.*)$/i],
];

/**
 * Splits labelled text into fields. A labelled line starts a field; following
 * unlabelled lines continue the previous field (multi-line descriptions).
 */
function labelledFields(texts: string[]): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  for (const text of texts) {
    // A new content block never continues the previous block's field.
    let current: Field | null = null;
    for (const line of text.split(/\r?\n/)) {
      const hit = LABELS.find(([, re]) => re.test(line));
      if (hit) {
        current = hit[0];
        const value = hit[1].exec(line)?.[1] ?? "";
        if (out[current] === undefined) out[current] = value;
        else if (current === "description") out[current] += `\n${value}`;
        continue;
      }
      if (current === "description" && out.description !== undefined) out.description += `\n${line}`;
    }
  }
  return out;
}

const PROMO_CODE = /^[A-Za-z0-9][A-Za-z0-9_.\-%]*$/;

/**
 * Returns null when Argos returned no details at all (treated by the tool as
 * "not found"). Throws ParseError when details are present but malformed.
 */
export function parseProduct(id: string, texts: string[]): ProductDetail | null {
  const f = labelledFields(texts);
  const hasAnyField = f.name !== undefined || f.link !== undefined || f.description !== undefined || f.price !== undefined;
  if (!hasAnyField) return null;

  const name = f.name !== undefined ? plain(f.name, MAX_NAME) : "";
  if (!name) throw new ParseError("product details without a name");

  let url: string;
  if (f.link !== undefined && f.link.trim() !== "") {
    const safe = safeArgosUrl(f.link);
    if (!safe) throw new ParseError("product link is not an Argos https URL");
    url = safe;
  } else {
    url = productUrl(id);
  }

  let price: number | null = null;
  if (f.price !== undefined && f.price.trim() !== "") {
    price = parsePrice(f.price);
    if (price === null) throw new ParseError("unrecognised product price");
  }

  const description = f.description !== undefined ? htmlToText(f.description) || null : null;

  let promotion: Promotion | null = null;
  if (f.promotion !== undefined) {
    const code = plain(f.promotion, MAX_PROMO_CODE + 1);
    if (code) {
      if (code.length > MAX_PROMO_CODE || !PROMO_CODE.test(code)) throw new ParseError("unrecognised promotion code");
      // The code's customer-facing meaning is not established: never infer a label or discount.
      promotion = { code, label: null };
    }
  }

  return { id, name, url, description, price, currency: price === null ? null : CURRENCY, promotion };
}
