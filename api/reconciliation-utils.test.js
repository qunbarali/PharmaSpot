const { planProductReconciliation, buildReconciliationPreview } = require("./reconciliation-utils");

describe("batch-aware stock reconciliation", () => {
  const product = {
    _id: 12, name: "Example medicine", quantity: 17,
    batches: [
      { batchNumber: "A1", expiryDate: "2027-01-01", quantity: 10, purchasePrice: 2 },
      { batchNumber: "B2", expiryDate: "2027-06-01", quantity: 5, purchasePrice: 3 }
    ]
  };
  const row = {
    productId: 12, systemQuantity: 17,
    batchCounts: [
      { batchIndex: 0, batchNumber: "A1", expiryDate: "2027-01-01", systemQuantity: 10, countedQuantity: 8 },
      { batchIndex: 1, batchNumber: "B2", expiryDate: "2027-06-01", systemQuantity: 5, countedQuantity: 6 }
    ],
    untrackedSystemQuantity: 2, untrackedCount: 1
  };

  test("updates each batch and untracked quantity while preserving batch metadata", () => {
    const plan = planProductReconciliation(product, row);
    expect(plan.countedQuantity).toBe(15);
    expect(plan.variance).toBe(-2);
    expect(plan.nextProduct.batches.map(batch => batch.quantity)).toEqual([8, 6]);
    expect(plan.nextProduct.batches[0].purchasePrice).toBe(2);
    expect(plan.countedUntracked).toBe(1);
  });

  test("rejects stale product totals and stale batch quantities", () => {
    expect(() => planProductReconciliation(product, { ...row, systemQuantity: 16 })).toThrow(/changed after preview/);
    const stale = { ...row, batchCounts: row.batchCounts.map(batch => ({ ...batch })) };
    stale.batchCounts[0].systemQuantity = 9;
    expect(() => planProductReconciliation(product, stale)).toThrow(/batch changed after preview/i);
  });

  test("requires every batch exactly once and rejects impossible batch totals", () => {
    expect(() => planProductReconciliation(product, { ...row, batchCounts: row.batchCounts.slice(0, 1) })).toThrow(/every batch/i);
    expect(() => planProductReconciliation({ ...product, quantity: 10 }, { ...row, systemQuantity: 10 })).toThrow(/exceed total stock/i);
  });

  test("preview returns per-batch differences and rejects duplicate products", () => {
    const preview = buildReconciliationPreview([product], [row]);
    expect(preview[0].countedBatches.map(batch => batch.quantity)).toEqual([8, 6]);
    expect(preview[0].untrackedCount).toBe(1);
    expect(() => buildReconciliationPreview([product], [row, row])).toThrow(/only once/i);
  });
});
