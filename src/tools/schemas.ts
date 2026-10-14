/**
 * Advertised MCP output schemas (tools/list `outputSchema`). The SDK validates
 * every successful result's `structuredContent` against these before it is
 * sent, so a result that does not match can never reach the client.
 */
import { z } from "zod";

const price = z.number().min(0).nullable().describe("Price as a number, or null if Argos did not supply one. Never 0 for missing.");
const currency = z.literal("GBP").nullable().describe("ISO 4217 currency of `price`; null when price is null.");

export const searchProductSchema = z
  .object({
    id: z.string().describe("Argos product identifier"),
    name: z.string(),
    price,
    currency,
    url: z.url().nullable().describe("Argos product page, built from the ID using the form Argos's own product links use"),
  })
  .strict();

export const searchOutput = z
  .object({
    products: z.array(searchProductSchema).describe("Products in this response; an empty array means no matches"),
    totalCount: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Total matches as reported by Argos ('Total Products Found'); null when Argos does not report it"),
  })
  .strict();

export const productDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.url(),
    description: z.string().nullable().describe("Plain-text description converted from Argos's HTML"),
    price,
    currency,
    promotion: z
      .object({
        code: z.string().nullable().describe("Promotional badge code exactly as supplied by Argos"),
        label: z.string().nullable().describe("Customer-facing label; null until a verified mapping exists"),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const getProductOutput = z.object({ product: productDetailSchema }).strict();

export type SearchOutput = z.infer<typeof searchOutput>;
export type GetProductOutput = z.infer<typeof getProductOutput>;
