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
    const quantity = Number(item && item.quantity);
    const price = Number(item && item.purchasePrice);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0) {
      throw new Error("Purchase lines contain an invalid quantity or purchase price.");
    }
    return sum + quantity * price;
  }, 0);
}

function convertToBaseCurrency(amount, exchangeRate, decimals = 4) {
  const value = Number(amount);
  const rate = Number(exchangeRate);
  const precision = Number(decimals);
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(rate) || rate <= 0 ||
      !Number.isInteger(precision) || precision < 0 || precision > 8) {
    throw new Error("A non-negative amount, positive exchange rate and valid precision are required.");
  }
  const factor = Math.pow(10, precision);
  return Math.round((value * rate + Number.EPSILON) * factor) / factor;
}

function normalizeInvoiceKey(supplier, invoiceNo) {
  const normalize = value => String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/g, " ");
  const supplierKey = normalize(supplier);
  const invoiceKey = normalize(invoiceNo);
  if (!supplierKey || !invoiceKey) throw new Error("Supplier and invoice number are required for duplicate detection.");
  return supplierKey + "|" + invoiceKey;
}

function isIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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
  const body = input || {};
  const supplier = String(body.supplier || "").trim().slice(0, 160);
  const supplierIdentifier = String(body.supplierIdentifier || "").trim().slice(0, 120);
  const invoiceNo = String(body.invoiceNo || "").trim().slice(0, 120);
  const invoiceDate = String(body.invoiceDate || "").trim();
  const currency = String(body.currency || "").toUpperCase();
  const baseCurrency = String(body.baseCurrency || "PKR").toUpperCase();
  const exchangeRate = Number(body.exchangeRate == null || body.exchangeRate === "" ? (currency === baseCurrency ? 1 : NaN) : body.exchangeRate);
  const exchangeRateDate = String(body.exchangeRateDate || invoiceDate || new Date().toISOString().slice(0, 10)).trim();
  const items = Array.isArray(body.items) ? body.items : [];

  if (!supplier || !invoiceNo) throw new Error("Supplier and invoice number are required.");
  if (invoiceDate && !isIsoDate(invoiceDate)) throw new Error("Invoice date must be a valid YYYY-MM-DD date.");
  if (!isIsoDate(exchangeRateDate)) throw new Error("Exchange-rate date must be a valid YYYY-MM-DD date.");
  if (!["PKR", "INR", "USD"].includes(currency) || !["PKR", "INR", "USD"].includes(baseCurrency)) {
    throw new Error("Invoice and store currencies must be PKR, INR or USD.");
  }
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0 || (currency === baseCurrency && exchangeRate !== 1)) {
    throw new Error("Enter a positive exchange rate; it must be 1 when invoice and store currencies match.");
  }
  if (!items.length || items.length > 500 || items.some(item => !item || typeof item !== "object")) {
    throw new Error("A purchase must contain between 1 and 500 valid invoice lines.");
  }
  calculatePurchaseTotal(items);
  const normalizedItems = items.map(item => {
    const productId = Number(item.productId);
    const salePrice = Number(item.salePrice);
    if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isFinite(salePrice) || salePrice < 0 ||
        !String(item.batchNumber || "").trim() || !String(item.expiryDate || "").trim()) {
      throw new Error("Every invoice line needs a valid product, sale price, batch number and expiry date.");
    }
    return {
      ...item,
      sourceDescription: String(item.sourceDescription || item.productName || item.description || "").trim().slice(0, 160)
    };
  });

  return {
    supplier,
    supplierIdentifier,
    invoiceNo,
    invoiceDate,
    currency,
    baseCurrency,
    exchangeRate,
    exchangeRateDate,
    items: normalizedItems
  };
}

module.exports = {
  findReversalBatchIndex,
  calculatePurchaseTotal,
  convertToBaseCurrency,
  normalizeInvoiceKey,
  isIsoDate,
  planPurchaseReversal,
  validatePurchaseDraft
};
