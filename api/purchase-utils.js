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
module.exports = { findReversalBatchIndex, calculatePurchaseTotal };
