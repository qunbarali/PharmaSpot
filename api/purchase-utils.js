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


function validatePurchaseDraft(input) {
  const supplier = String(input && input.supplier || "").trim();
  const invoiceNo = String(input && input.invoiceNo || "").trim();
  const currency = String(input && input.currency || "").toUpperCase();
  const baseCurrency = String(input && input.baseCurrency || "PKR").toUpperCase();
  const exchangeRate = Number(input && input.exchangeRate == null ? 1 : input.exchangeRate);
  const items = Array.isArray(input && input.items) ? input.items : [];
  if (!supplier || !invoiceNo) throw new Error("Supplier and invoice number are required.");
  if (!["PKR", "INR", "USD"].includes(currency) || !["PKR", "INR", "USD"].includes(baseCurrency)) {
    throw new Error("Invoice and store currencies must be PKR, INR or USD.");
  }
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0 || (currency === baseCurrency && exchangeRate !== 1)) {
    throw new Error("Enter a positive exchange rate; it must be 1 when invoice and store currencies match.");
  }
  if (!items.length || items.length > 500) throw new Error("A purchase must contain between 1 and 500 invoice lines.");
  calculatePurchaseTotal(items);
  for (const item of items) {
    const productId = Number(item.productId);
    const salePrice = Number(item.salePrice);
    if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isFinite(salePrice) || salePrice < 0 ||
        !String(item.batchNumber || "").trim() || !String(item.expiryDate || "").trim()) {
      throw new Error("Every invoice line needs a valid product, sale price, batch number and expiry date.");
    }
  }
  return { supplier, invoiceNo, currency, baseCurrency, exchangeRate, items };
}

module.exports = { findReversalBatchIndex, calculatePurchaseTotal, planPurchaseReversal, validatePurchaseDraft };
