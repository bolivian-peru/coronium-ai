import { describe, expect, it } from "vitest";
import { CoroniumError, CoroniumStockOutError } from "../src/index.js";

describe("CoroniumError", () => {
  it("falls back to HTTP_<status> code when no body code", () => {
    const e = new CoroniumError(503, undefined, "upstream down");
    expect(e.code).toBe("HTTP_503");
    expect(e.status).toBe(503);
    expect(e.message).toBe("upstream down");
  });

  it("uses body code when present", () => {
    const e = new CoroniumError(401, { code: "INVALID_KEY", message: "bad key" }, "fallback");
    expect(e.code).toBe("INVALID_KEY");
    expect(e.message).toBe("bad key");
  });

  it("CoroniumStockOutError exposes suggestions", () => {
    const body = {
      code: "STOCK_OUT",
      message: "out",
      suggestion: { available_now: [{ country: "US", carrier: "T-Mobile", in_stock: 5 }] },
    };
    const e = new CoroniumStockOutError(409, body, "fallback");
    expect(e).toBeInstanceOf(CoroniumError);
    expect(e.code).toBe("STOCK_OUT");
    expect(e.suggestions).toHaveLength(1);
    expect(e.suggestions[0]).toMatchObject({ country: "US", in_stock: 5 });
  });

  it("CoroniumStockOutError defaults to empty suggestions when missing", () => {
    const e = new CoroniumStockOutError(409, { code: "STOCK_OUT", message: "x" }, "fallback");
    expect(e.suggestions).toEqual([]);
  });
});
