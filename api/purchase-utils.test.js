const { findReversalBatchIndex, calculatePurchaseTotal, planPurchaseReversal, validatePurchaseDraft } = require("./purchase-utils");

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
  test("plans a safe reversal and restores unchanged product metadata", () => {
    const product = {
      _id: 7, quantity: 12, price: "25", supplier: "Supplier A",
      purchasePrice: "15", expirationDate: "2027-01-01",
      batches: [{ importLineId: "line-1", batchNumber: "A", expiryDate: "2027-01-01", quantity: 2 }]
    };
    const item = {
      importLineId: "line-1", quantity: 2,
      postedProductFields: { price: "25", supplier: "Supplier A", purchasePrice: "15", expirationDate: "2027-01-01" },
      previousProductFields: { price: "20", supplier: "Supplier Old", purchasePrice: "12", expirationDate: "2026-12-01" }
    };
    const plan = planPurchaseReversal(product, item);
    expect(plan.nextQuantity).toBe(10);
    expect(plan.nextBatches).toEqual([]);
    expect(plan.restoreFields.price).toBe("20");
  });

  test("does not overwrite product pricing edited after the purchase", () => {
    const product = {
      _id: 7, quantity: 12, price: "30", supplier: "Supplier A",
      purchasePrice: "15", expirationDate: "2027-01-01",
      batches: [{ importLineId: "line-1", batchNumber: "A", expiryDate: "2027-01-01", quantity: 2 }]
    };
    const item = {
      importLineId: "line-1", quantity: 2,
      postedProductFields: { price: "25", supplier: "Supplier A", purchasePrice: "15", expirationDate: "2027-01-01" },
      previousProductFields: { price: "20", supplier: "Supplier Old", purchasePrice: "12", expirationDate: "2026-12-01" }
    };
    expect(planPurchaseReversal(product, item).restoreFields).toEqual({});
  });

  test("blocks reversal when a purchased batch quantity has changed", () => {
    const product = { _id: 7, quantity: 10, batches: [{ importLineId: "line-1", quantity: 1 }] };
    expect(() => planPurchaseReversal(product, { importLineId: "line-1", quantity: 2 })).toThrow(/changed or been sold/);
  });

  test("validates a purchase draft before it enters the approval queue", () => {
    const draft = validatePurchaseDraft({
      supplier: "Main Distributor", invoiceNo: "INV-100", currency: "PKR",
      baseCurrency: "PKR", exchangeRate: 1,
      items: [{ productId: 5, quantity: 10, purchasePrice: 12, salePrice: 15, batchNumber: "B-1", expiryDate: "31-Dec-2027" }]
    });
    expect(draft.items).toHaveLength(1);
    expect(draft.currency).toBe("PKR");
  });

  test("rejects duplicate/invalid purchase fields and invalid exchange rates", () => {
    const valid = {
      supplier: "Main Distributor", invoiceNo: "INV-100", currency: "PKR",
      baseCurrency: "PKR", exchangeRate: 1,
      items: [{ productId: 5, quantity: 10, purchasePrice: 12, salePrice: 15, batchNumber: "B-1", expiryDate: "31-Dec-2027" }]
    };
    expect(() => validatePurchaseDraft({ ...valid, exchangeRate: 2 })).toThrow(/must be 1/i);
    expect(() => validatePurchaseDraft({ ...valid, items: [{ ...valid.items[0], quantity: -1 }] })).toThrow();
    expect(() => validatePurchaseDraft({ ...valid, items: [{ ...valid.items[0], productId: "x" }] })).toThrow(/valid product/i);
  });

});
