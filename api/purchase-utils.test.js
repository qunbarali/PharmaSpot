const {
  findReversalBatchIndex,
  calculatePurchaseTotal,
  convertToBaseCurrency,
  normalizeInvoiceKey,
  findDuplicateSourceFile,
  isIsoDate,
  normalizeExpiryDate,
  planPurchaseReversal,
  validatePurchaseDraft
} = require("./purchase-utils");

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
    expect(calculatePurchaseTotal([{ quantity: 5, paidQuantity: 4, bonusQuantity: 1, purchasePrice: 10 }])).toBe(40);
    expect(() => calculatePurchaseTotal([{ quantity: 0, purchasePrice: 5 }])).toThrow();
  });

  test("converts invoice prices into store currency at the recorded rate and precision", () => {
    expect(convertToBaseCurrency(12.5, 3.75, 4)).toBe(46.875);
    expect(convertToBaseCurrency(12.5, 3.75, 2)).toBe(46.88);
    expect(convertToBaseCurrency(10, 1, 2)).toBe(10);
    expect(() => convertToBaseCurrency(10, 0)).toThrow();
    expect(() => convertToBaseCurrency(-1, 2)).toThrow();
  });

  test("normalizes supplier and invoice keys for duplicate detection", () => {
    expect(normalizeInvoiceKey("  Main   Distributor ", " INV-100 ")).toBe("main distributor|inv-100");
    expect(() => normalizeInvoiceKey("", "INV-100")).toThrow();
  });

  test("detects a reused original invoice file by SHA-256", () => {
    const hash = "a".repeat(64);
    const records = [{
      _id: "import-1", status: "posted", supplier: "Main Distributor", invoiceNo: "INV-100",
      sourceFiles: [{ originalName: "invoice.pdf", sha256: hash }]
    }];
    expect(findDuplicateSourceFile(records, [{ sha256: hash.toUpperCase() }])).toMatchObject({
      importId: "import-1", status: "posted", invoiceNo: "INV-100", sha256: hash
    });
    expect(findDuplicateSourceFile(records, [{ sha256: "b".repeat(64) }])).toBeNull();
    expect(findDuplicateSourceFile(records, [{ sha256: "not-a-hash" }])).toBeNull();
  });

  test("validates exchange-rate and invoice dates as real ISO calendar dates", () => {
    expect(isIsoDate("2026-11-16")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("16-11-2026")).toBe(false);
  });

  test("normalizes full and month-only expiry dates, rejecting impossible dates", () => {
    expect(normalizeExpiryDate("2027-12-31")).toBe("2027-12-31");
    expect(normalizeExpiryDate("31-Dec-2027")).toBe("2027-12-31");
    expect(normalizeExpiryDate("12/2027")).toBe("2027-12-31");
    expect(normalizeExpiryDate("2027-12")).toBe("2027-12-31");
    expect(normalizeExpiryDate("Dec 2027")).toBe("2027-12-31");
    expect(normalizeExpiryDate("31/02/2027")).toBe("");
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

  test("validates a purchase draft and records invoice currency conversion date", () => {
    const draft = validatePurchaseDraft({
      supplier: "Main Distributor",
      supplierIdentifier: "SUP-007",
      invoiceNo: "INV-100",
      invoiceDate: "2026-11-15",
      currency: "INR",
      baseCurrency: "PKR",
      exchangeRate: 3.75,
      exchangeRateDate: "2026-11-16",
      items: [{
        productId: 5, sourceDescription: "Paracetamol 500mg",
        quantity: 10, bonusQuantity: 2, purchasePrice: 12, salePrice: 15,
        batchNumber: "B-1", expiryDate: "31-Dec-2027"
      }]
    });
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0].sourceDescription).toBe("Paracetamol 500mg");
    expect(draft.currency).toBe("INR");
    expect(draft.baseCurrency).toBe("PKR");
    expect(draft.exchangeRate).toBe(3.75);
    expect(draft.exchangeRateDate).toBe("2026-11-16");
    expect(draft.items[0].expiryDate).toBe("2027-12-31");
    expect(draft.items[0].bonusQuantity).toBe(2);
  });

  test("rejects duplicate/invalid purchase fields, dates and exchange rates", () => {
    const valid = {
      supplier: "Main Distributor", invoiceNo: "INV-100", currency: "PKR",
      baseCurrency: "PKR", exchangeRate: 1, exchangeRateDate: "2026-11-16",
      items: [{ productId: 5, quantity: 10, purchasePrice: 12, salePrice: 15, batchNumber: "B-1", expiryDate: "31-Dec-2027" }]
    };
    expect(() => validatePurchaseDraft({ ...valid, exchangeRate: 2 })).toThrow(/must be 1/i);
    expect(() => validatePurchaseDraft({ ...valid, currency: "INR", baseCurrency: "PKR", exchangeRate: "" })).toThrow(/positive exchange rate/i);
    expect(() => validatePurchaseDraft({ ...valid, exchangeRateDate: "2026-02-30" })).toThrow(/exchange-rate date/i);
    expect(() => validatePurchaseDraft({ ...valid, items: [{ ...valid.items[0], quantity: -1 }] })).toThrow();
    expect(() => validatePurchaseDraft({ ...valid, items: [{ ...valid.items[0], productId: "x" }] })).toThrow(/valid product/i);
    expect(() => validatePurchaseDraft({ ...valid, items: [{ ...valid.items[0], expiryDate: "31-Feb-2027" }] })).toThrow(/expiry date/i);
  });
});
