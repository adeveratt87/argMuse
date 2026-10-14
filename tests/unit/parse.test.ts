import { describe, expect, it } from "vitest";
import { ParseError, htmlToText, parsePrice, parseProduct, parseSearch, safeArgosUrl } from "../../src/tools/parse.js";
import { getProductOutput, searchOutput } from "../../src/tools/schemas.js";

describe("parsePrice", () => {
  it.each([
    ["119.0", 119],
    ["£5.0", 5],
    ["Â£199.0", 199],
    ["£1,299.99", 1299.99],
    ["15.99", 15.99],
    ["0.00", 0],
  ])("%s → %s", (raw, n) => expect(parsePrice(raw)).toBe(n));

  it.each([[undefined], [""], ["POA"], ["n/a"]])("%s → null (missing is never 0)", (raw) => expect(parsePrice(raw)).toBeNull());
});

describe("htmlToText", () => {
  it("keeps meaningful text and safety warnings, drops markup and scripts", () => {
    const html =
      "<p>All dressed up in a skeleton costume.</p><script>steal()</script><style>p{}</style>" +
      "<p><b>Warning:</b> Not suitable for children under 3 years old.<br>Adult supervision required at all times.</p>" +
      "<ul><li>Size H11, W11, D8cm.</li><li>Weight 0.1kg</li></ul>";
    expect(htmlToText(html)).toBe(
      "All dressed up in a skeleton costume.\nWarning: Not suitable for children under 3 years old.\n" +
        "Adult supervision required at all times.\n• Size H11, W11, D8cm.\n• Weight 0.1kg",
    );
  });

  it("decodes entities and fixes £ mojibake without reintroducing markup", () => {
    expect(htmlToText("Save &pound;5 &amp; more &lt;script&gt; Â£10&nbsp;off &#8211; now")).toBe("Save £5 & more £10 off – now");
  });

  it("removes event-handler attributes, comments, iframes and control characters", () => {
    const out = htmlToText('<img src=x onerror="alert(1)">Hi<!-- secret --><iframe src="https://evil"></iframe>\u0007there');
    expect(out).toBe("Hi there");
  });

  it("caps very long descriptions", () => {
    expect(htmlToText(`<p>${"a".repeat(6000)}</p>`).length).toBeLessThanOrEqual(5001);
  });
});

describe("safeArgosUrl", () => {
  it.each([
    ["https://argos.co.uk/product/8444015/", "https://argos.co.uk/product/8444015/"],
    ["https://www.argos.co.uk/product/8444015", "https://www.argos.co.uk/product/8444015"],
  ])("accepts %s", (raw, out) => expect(safeArgosUrl(raw)).toBe(out));
  it.each(["http://argos.co.uk/product/1", "https://argos.co.uk.evil.example/p", "javascript:alert(1)", "https://u:p@argos.co.uk/"])(
    "rejects %s",
    (raw) => expect(safeArgosUrl(raw)).toBeNull(),
  );
});

describe("parseSearch", () => {
  it("parses product lines including commas in names, and the reported total", () => {
    const r = parseSearch(["Search Results\nTotal Products Found: 18", "ID: 1, Product: Kettle, 1.7L, Black, Price: 15.99\nID: ab12, Product: Toaster"]);
    expect(r.totalCount).toBe(18);
    expect(r.products).toEqual([
      { id: "1", name: "Kettle, 1.7L, Black", price: 15.99, currency: "GBP", url: "https://argos.co.uk/product/1/" },
      { id: "ab12", name: "Toaster", price: null, currency: null, url: "https://argos.co.uk/product/ab12/" },
    ]);
    expect(searchOutput.safeParse(r).success).toBe(true);
  });

  it("returns an empty array and null total when there are no product lines", () => {
    expect(parseSearch(["Search Results", "No products found"])).toEqual({ products: [], totalCount: null });
    expect(parseSearch([])).toEqual({ products: [], totalCount: null });
  });

  it("deduplicates repeated IDs", () => {
    expect(parseSearch(["ID: 1, Product: A, Price: 1\nID: 1, Product: A, Price: 1"]).products).toHaveLength(1);
  });

  it.each([["ID: 123; Name=Kettle"], ["ID: 1, Product: A, Price: free"], ["ID: !!, Product: A"]])("throws on unrecognised line %s", (line) => {
    expect(() => parseSearch([line])).toThrow(ParseError);
  });
});

describe("parseProduct", () => {
  const blocks = [
    "Product Information for 8444015",
    "Name: Argos Home Mouse In Skeleton Felt Hanging Decoration",
    "Link: https://argos.co.uk/product/8444015/",
    "Description: <p>Mice to meet you.</p><p>Not suitable for children under 3 years old.</p>",
    "Price: £5.0",
    "Promotional badge: VALUE_20_pc_spooky20",
  ];

  it("parses separate labelled blocks", () => {
    const p = parseProduct("8444015", blocks);
    expect(p).toEqual({
      id: "8444015",
      name: "Argos Home Mouse In Skeleton Felt Hanging Decoration",
      url: "https://argos.co.uk/product/8444015/",
      description: "Mice to meet you.\nNot suitable for children under 3 years old.",
      price: 5,
      currency: "GBP",
      promotion: { code: "VALUE_20_pc_spooky20", label: null },
    });
    expect(getProductOutput.safeParse({ product: p }).success).toBe(true);
  });

  it("parses the same fields from a single multi-line block", () => {
    expect(parseProduct("8444015", [blocks.join("\n")])).toEqual(parseProduct("8444015", blocks));
  });

  it("accepts other badge label spellings", () => {
    for (const label of ["Badge", "Badges", "Promotion", "Promotional Badge"]) {
      expect(parseProduct("1", ["Name: X", `${label}: CODE_1`])?.promotion).toEqual({ code: "CODE_1", label: null });
    }
  });

  it("returns null when Argos returned nothing recognisable (not found)", () => {
    expect(parseProduct("0", [])).toBeNull();
    expect(parseProduct("0", ["Product not found"])).toBeNull();
  });

  it("derives the URL from the ID only when Argos gave no link", () => {
    expect(parseProduct("hm128582", ["Name: Kettle"])?.url).toBe("https://argos.co.uk/product/hm128582/");
  });

  it.each([
    ["details without a name", ["Price: £5"]],
    ["non-Argos link", ["Name: X", "Link: https://evil.example/x"]],
    ["unreadable price", ["Name: X", "Price: call us"]],
    ["promotion that is not a code", ["Name: X", "Badge: 20% off <b>today</b>!"]],
  ])("throws on %s", (_l, texts) => {
    expect(() => parseProduct("1", texts)).toThrow(ParseError);
  });
});
