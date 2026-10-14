/**
 * Validates real tool results against the JSON Schemas the connector actually
 * advertises in tools/list, using an independent validator (Ajv), as opposed
 * to the zod schemas the server validates with internally.
 */
import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { createTestApp } from "../helpers/app.js";
import { EMPTY_SEARCH_RESULT, SEARCH_RESULT, productDetail } from "../helpers/fixtures.js";

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

describe("structuredContent matches the advertised outputSchema", () => {
  it.each([
    ["search with results", "search", { query: "kettle" }, () => SEARCH_RESULT],
    ["empty search", "search", { query: "zzz" }, () => EMPTY_SEARCH_RESULT],
    ["getProducts with promotion", "getProducts", { id: "8444015" }, () => productDetail("8444015")],
    [
      "getProducts with missing price and description",
      "getProducts",
      { id: "1" },
      () => ({ content: [{ type: "text" as const, text: "Name: Bare product" }] }),
    ],
  ])("%s", async (_label, tool, args, upstream) => {
    const app = await createTestApp({ upstream: { tool: upstream } });
    const client = await app.connectClient(await app.tokens.sign());
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === tool)!.outputSchema!;
    const ajv = addFormats(new Ajv({ strict: false, allErrors: true }));
    const validate = ajv.compile(schema);

    const res = await client.callTool({ name: tool, arguments: args });
    expect(res.isError).toBeFalsy();
    const ok = validate(res.structuredContent);
    expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
    expect(ok).toBe(true);
  });

  it("the advertised schema rejects fabricated or malformed values", async () => {
    const app = await createTestApp();
    const client = await app.connectClient(await app.tokens.sign());
    const { tools } = await client.listTools();
    const ajv = addFormats(new Ajv({ strict: false }));
    const search = ajv.compile(tools.find((t) => t.name === "search")!.outputSchema!);
    const base = { id: "1", name: "A", price: 1, currency: "GBP", url: "https://argos.co.uk/product/1/" };
    expect(search({ products: [base], totalCount: 1 })).toBe(true);
    expect(search({ products: [{ ...base, price: -1 }], totalCount: 1 })).toBe(false);
    expect(search({ products: [{ ...base, currency: "USD" }], totalCount: 1 })).toBe(false);
    expect(search({ products: [{ ...base, stock: 5 }], totalCount: 1 })).toBe(false); // no invented fields
    expect(search({ products: [base] })).toBe(false); // totalCount must be present (null if unknown)
  });
});
