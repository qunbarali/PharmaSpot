function number(value) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error("Stock counts must be finite, non-negative numbers.");
  return result;
}
function planProductReconciliation(product, row) {
  if (!product || !row || String(product._id) !== String(row.productId)) throw new Error("Product not found.");
  const batches = Array.isArray(product.batches) ? product.batches : [];
  const currentQuantity = number(product.quantity || 0);
  if (currentQuantity !== number(row.systemQuantity)) throw new Error("Stock changed after preview. Generate a new preview.");
  if (!Array.isArray(row.batchCounts) || row.batchCounts.length !== batches.length) throw new Error("Batch list changed or is incomplete. Generate a new preview.");
  const batchCounts = new Map();
  for (const entry of row.batchCounts) {
    const index = Number(entry.batchIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= batches.length || batchCounts.has(index)) throw new Error("Invalid or duplicate batch count.");
    const current = batches[index];
    if (String(entry.batchNumber || "") !== String(current.batchNumber || "") ||
        String(entry.expiryDate || "") !== String(current.expiryDate || "") ||
        number(entry.systemQuantity) !== number(current.quantity || 0)) {
      throw new Error("A batch changed after preview. Generate a new preview.");
    }
    batchCounts.set(index, number(entry.countedQuantity));
  }
  let batchTotal = 0;
  const nextBatches = batches.map((batch, index) => {
    if (!batchCounts.has(index)) throw new Error("Every batch must have a physical count.");
    const quantity = batchCounts.get(index);
    batchTotal += quantity;
    return { ...batch, quantity };
  });
  const oldBatchTotal = batches.reduce((sum, batch) => sum + number(batch.quantity || 0), 0);
  const oldUntracked = currentQuantity - oldBatchTotal;
  if (oldUntracked < 0) throw new Error("Recorded batch quantities exceed total stock. Correct inventory before reconciliation.");
  if (number(row.untrackedSystemQuantity) !== oldUntracked) throw new Error("Unbatched stock changed after preview. Generate a new preview.");
  const nextUntracked = number(row.untrackedCount);
  const nextQuantity = batchTotal + nextUntracked;
  return {
    productId: product._id,
    productName: product.name,
    systemQuantity: currentQuantity,
    countedQuantity: nextQuantity,
    variance: nextQuantity - currentQuantity,
    systemBatches: batches.map(batch => ({ batchNumber: batch.batchNumber || "", expiryDate: batch.expiryDate || "", quantity: number(batch.quantity || 0) })),
    countedBatches: nextBatches.map(batch => ({ batchNumber: batch.batchNumber || "", expiryDate: batch.expiryDate || "", quantity: number(batch.quantity || 0) })),
    oldUntracked,
    countedUntracked: nextUntracked,
    oldProduct: JSON.parse(JSON.stringify(product)),
    nextProduct: { ...product, quantity: nextQuantity, batches: nextBatches }
  };
}
function buildReconciliationPreview(products, rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new Error("Provide between 1 and 1000 stock-count rows.");
  const seen = new Set();
  return rows.map(row => {
    const id = String(row && row.productId || "");
    if (!id || seen.has(id)) throw new Error("Each product may appear only once in a reconciliation.");
    seen.add(id);
    const product = products.find(item => String(item._id) === id);
    if (!product) throw new Error("A product is missing.");
    const plan = planProductReconciliation(product, row);
    return {
      productId: plan.productId, productName: plan.productName,
      systemQuantity: plan.systemQuantity, countedQuantity: plan.countedQuantity,
      variance: plan.variance,
      systemBatches: plan.systemBatches, countedBatches: plan.countedBatches,
      untrackedSystemQuantity: plan.oldUntracked, untrackedCount: plan.countedUntracked
    };
  });
}
module.exports = { planProductReconciliation, buildReconciliationPreview };
