/**
 * Output normalisation. Deliberately minimal: product facts are passed through
 * exactly as Argos returns them. The connector only
 *   1. keeps `text` content blocks (drops images/resources/unknown types),
 *   2. strips C0/C1 control characters other than \n and \t, and
 *   3. caps per-block and total size, marking any truncation.
 * Text is untrusted data; this is not an HTML or prompt-injection filter.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LIMITS } from "../config.js";

export type TextBlock = { type: "text"; text: string };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
export const TRUNCATION_NOTE = "[truncated by connector]";

export function cleanText(text: string): string {
  return text.replace(CONTROL, "");
}

export function textBlocks(result: Pick<CallToolResult, "content">): TextBlock[] {
  const out: TextBlock[] = [];
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") out.push({ type: "text", text: cleanText(block.text) });
  }
  return out;
}

export function capBlocks(blocks: TextBlock[]): TextBlock[] {
  const out: TextBlock[] = [];
  let total = 0;
  for (const b of blocks) {
    const remaining = LIMITS.maxTotalTextChars - total;
    if (remaining <= 0) {
      out.push({ type: "text", text: TRUNCATION_NOTE });
      break;
    }
    const limit = Math.min(LIMITS.maxTextBlockChars, remaining);
    const text = b.text.length > limit ? `${b.text.slice(0, limit)} ${TRUNCATION_NOTE}` : b.text;
    out.push({ type: "text", text });
    total += Math.min(b.text.length, limit);
  }
  return out;
}
