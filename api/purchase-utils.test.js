const { findReversalBatchIndex, calculatePurchaseTotal } = require("./purchase-utils");

describe("purchase posting and reversal helpers", () => {
  test("targets an exact imported line even when batch labels are duplicated", () => {
    const batches = [
      { importLineId: "line-a", batchNumber: "B-1", expiryDate: "2027-01-01", quantity: 5 },
      { importLineId: "line-b", batchNumber: "B-1", expiryDate: "2027-01-01", quantity: 5 }
    ];
    expect(findReversalBatchIndex(batches, { importLineId: "line-b", quantity: 5 })).toBe(1);
  });

  test("supports older imports without an import-line identifier", () => {
    const batches = [
      { batchNumber: "B-1", expiryDate: "2027-01-01", quantity: 4 },
      { batchNumber: "B-1", expiryDate: "2027-01-01", quantity: 6 }
    ];
    expect(findReversalBatchIndex(batches, { batchNumber: "B-1", expiryDate: "2027-01-01", quantity: 6 })).toBe(1);
    expect(findReversalBatchIndex(batches, { batchNumber: "B-1", expiryDate: "2027-01-01", quantity: 7 })).toBe(-1);
  });

  test("calculates invoice totals and rejects invalid lines", () => {
    expect(calculatePurchaseTotal([{ quantity: 2, purchasePrice: 10.25 }, { quantity: 3, purchasePrice: 4 }])).toBe(32.5);
    expect(() => calculatePurchaseTotal([{ quantity: 0, purchasePrice: 5 }])).toThrow();
  });
});
