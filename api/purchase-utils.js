function findReversalBatchIndex(batches, item) {
  if (!Array.isArray(batches) || !item) return -1;
  if (item.importLineId) return batches.findIndex(batch => batch && batch.importLineId === item.importLineId);
  return batches.findIndex(batch =>
    batch &&
    String(batch.batchNumber || "") === String(item.batchNumber || "") &&
    String(batch.expiryDate || "") === String(item.expiryDate || "") &&
    Number(batch.quantity) === Number(item.quantity)
  );
}
function calculatePurchaseTotal(items) {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => {
    const quantity = Number(item.quantity);
    const price = Number(item.purchasePrice);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0) {
      throw new Error("Purchase lines contain an invalid quantity or purchase price.");
    }
    return sum + quantity * price;
  }, 0);
}

function planPurchaseReversal(product, item) {
  if (!product || !item) throw new Error("Purchase product or line is missing.");
  const batches = Array.isArray(product.batches) ? product.batches : [];
  const index = findReversalBatchIndex(batches, item);
  const quantity = Number(item.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || index < 0 ||
      Number(batches[index].quantity) !== quantity || Number(product.quantity || 0) < quantity) {
    throw new Error("A purchased batch has changed or been sold. Automatic reversal is blocked to protect stock; use stock reconciliation.");
  }
  const nextBatches = batches.slice();
  nextBatches.splice(index, 1);
  const postedFields = item.postedProductFields;
  const metadataStillMatchesPurchase = postedFields && Object.keys(postedFields).every(key =>
    String(product[key] ?? "") === String(postedFields[key] ?? "")
  );
  return {
    batchIndex: index,
    quantity,
    nextQuantity: Number(product.quantity || 0) - quantity,
    nextBatches,
    restoreFields: metadataStillMatchesPurchase ? (item.previousProductFields || {}) : {}
  };
}

module.exports = { findReversalBatchIndex, calculatePurchaseTotal, planPurchaseReversal };
