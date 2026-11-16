const { money, summarizeLedger } = require("./ledger-utils");

describe("distributor ledger calculations", () => {
  test("rounds currency amounts to cents and rejects invalid values", () => {
    expect(money("10.126")).toBe(10.13);
    expect(() => money(-1)).toThrow();
    expect(() => money("not money")).toThrow();
  });

  test("keeps currencies separate and applies payments and reversals", () => {
    const result = summarizeLedger([
      { type: "purchase", currency: "PKR", amount: 1250 },
      { type: "payment", currency: "PKR", amount: 300 },
      { type: "purchase_reversal", currency: "PKR", amount: 100 },
      { type: "purchase", currency: "USD", amount: 20 },
      { type: "payment", currency: "EUR", amount: 10 }
    ]);
    expect(result.PKR).toEqual({ purchases: 1250, payments: 300, reversals: 100, balance: 850 });
    expect(result.USD).toEqual({ purchases: 20, payments: 0, reversals: 0, balance: 20 });
    expect(result.EUR).toBeUndefined();
  });

  test("returns an empty summary for an empty ledger", () => {
    expect(summarizeLedger([])).toEqual({});
  });
});
