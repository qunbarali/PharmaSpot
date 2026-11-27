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
    const quantity = Number(item && (item.paidQuantity == null ? item.quantity : item.paidQuantity));
    const price = Number(item && item.purchasePrice);
    const rawLineTotal = item && (item.lineTotal == null || (typeof item.lineTotal === "string" && !item.lineTotal.trim()) ? item.netAmount : item.lineTotal);
    const lineTotal = rawLineTotal == null || (typeof rawLineTotal === "string" && !rawLineTotal.trim()) ? null : Number(rawLineTotal);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0 ||
        (lineTotal !== null && (!Number.isFinite(lineTotal) || lineTotal < 0))) {
      throw new Error("Purchase lines contain an invalid paid quantity, purchase price or reviewed line total.");
    }
    return sum + (lineTotal === null ? quantity * price : lineTotal);
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

function findDuplicateSourceFile(existingRecords, sourceFiles) {
  const requestedHashes = new Set((Array.isArray(sourceFiles) ? sourceFiles : [])
    .map(file => String(file && file.sha256 || "").trim().toLowerCase())
    .filter(hash => /^[a-f0-9]{64}$/.test(hash)));
  if (!requestedHashes.size) return null;

  for (const record of (Array.isArray(existingRecords) ? existingRecords : [])) {
    for (const source of (Array.isArray(record && record.sourceFiles) ? record.sourceFiles : [])) {
      const hash = String(source && source.sha256 || "").trim().toLowerCase();
      if (requestedHashes.has(hash)) {
        return {
          importId: String(record._id || ""),
          status: String(record.status || ""),
          supplier: String(record.supplier || ""),
          invoiceNo: String(record.invoiceNo || ""),
          sha256: hash
        };
      }
    }
  }
  return null;
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

const EXPIRY_MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12
};
function toExpiryIso(year, month, day) {
  let y = Number(year);
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || y < 1900 || y > 2200 || !Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(d) || d < 1 || d > 31) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return "";
  return date.toISOString().slice(0, 10);
}
function monthEndExpiry(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || y < 1900 || y > 2200 || !Number.isInteger(m) || m < 1 || m > 12) return "";
  return toExpiryIso(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
}
function normalizeExpiryDate(value) {
  const raw = String(value || "").trim().replace(/,/g, "");
  if (isIsoDate(raw)) return Number(raw.slice(0, 4)) >= 1900 && Number(raw.slice(0, 4)) <= 2200 ? raw : "";
  let match = raw.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (match) return toExpiryIso(match[1], match[2], match[3]);
  match = raw.match(/^(\d{1,2})[./-](\d{4})$/);
  if (match) return monthEndExpiry(match[2], match[1]);
  match = raw.match(/^(\d{4})[./-](\d{1,2})$/);
  if (match) return monthEndExpiry(match[1], match[2]);
  match = raw.match(/^(\d{1,2})[./-](\d{2})$/);
  if (match) {
    let year = Number(match[2]);
    year += year >= 70 ? 1900 : 2000;
    return monthEndExpiry(year, match[1]);
  }
  match = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (match) return toExpiryIso(match[3], match[2], match[1]);
  match = raw.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{2,4})$/);
  if (match) return toExpiryIso(match[3], EXPIRY_MONTHS[match[2].toLowerCase()], match[1]);
  match = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{2,4})$/);
  if (match) return toExpiryIso(match[3], EXPIRY_MONTHS[match[1].toLowerCase()], match[2]);
  match = raw.match(/^([A-Za-z]{3,9})\s+(\d{4})$/);
  if (match) return monthEndExpiry(match[2], EXPIRY_MONTHS[match[1].toLowerCase()]);
  return "";
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
  const normalizedItems = items.map(item => {
    const hasValue = value => value != null && !(typeof value === "string" && !value.trim());
    if (!hasValue(item.purchasePrice) || !hasValue(item.salePrice)) {
      throw new Error("Every invoice line needs an explicitly reviewed purchase price and sale price; blank values cannot be treated as zero.");
    }
    const quantity = Number(item.quantity);
    const paidQuantity = Number(item.paidQuantity == null || item.paidQuantity === "" ? quantity : item.paidQuantity);
    const purchasePrice = Number(item.purchasePrice);
    const productId = Number(item.productId);
    const salePrice = Number(item.salePrice);
    const bonusQuantity = Number(item.bonusQuantity == null || item.bonusQuantity === "" ? 0 : item.bonusQuantity);
    const expiryDate = normalizeExpiryDate(item.expiryDate);
    const optionalAmount = key => {
      const raw = item[key];
      if (raw == null || (typeof raw === "string" && !raw.trim())) return null;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) throw new Error("Invoice line " + key + " must be a non-negative number.");
      return value;
    };
    const grossAmount = optionalAmount("grossAmount");
    const discountPercent = optionalAmount("discountPercent");
    const discountAmount = optionalAmount("discountAmount");
    const salesTaxPercent = optionalAmount("salesTaxPercent");
    const salesTaxAmount = optionalAmount("salesTaxAmount");
    const additionalTaxAmount = optionalAmount("additionalTaxAmount");
    const netAmount = optionalAmount("netAmount");
    const lineTotal = optionalAmount("lineTotal") ?? netAmount;
    if (discountPercent !== null && discountPercent > 100) throw new Error("Invoice line discount percentage cannot exceed 100.");
    if (salesTaxPercent !== null && salesTaxPercent > 100) throw new Error("Invoice line sales-tax percentage cannot exceed 100.");
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(purchasePrice) || purchasePrice < 0) {
      throw new Error("Every invoice line needs a positive paid quantity and a valid purchase price.");
    }
    if (!Number.isFinite(paidQuantity) || paidQuantity !== quantity) {
      throw new Error("Paid quantity must match the invoice line quantity. Record free stock separately as bonus quantity.");
    }
    if (!Number.isFinite(bonusQuantity) || bonusQuantity < 0) throw new Error("Bonus/free quantity must be zero or a positive number.");
    if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isFinite(salePrice) || salePrice < 0 ||
        !String(item.batchNumber || "").trim() || !expiryDate) {
      throw new Error("Every invoice line needs a valid product, sale price, batch number and expiry date.");
    }
    return {
      ...item,
      quantity,
      paidQuantity: quantity,
      purchasePrice,
      bonusQuantity,
      expiryDate,
      itemCode: String(item.itemCode || "").trim().slice(0, 80),
      packing: String(item.packing || "").trim().slice(0, 80),
      grossAmount,
      discountPercent,
      discountAmount,
      salesTaxPercent,
      salesTaxAmount,
      additionalTaxAmount,
      netAmount,
      lineTotal,
      sourceDescription: String(item.sourceDescription || item.productName || item.description || "").trim().slice(0, 160)
    };
  });
  const invoiceTotalRaw = body.invoiceTotal;
  const invoiceTotal = invoiceTotalRaw == null || (typeof invoiceTotalRaw === "string" && !invoiceTotalRaw.trim())
    ? calculatePurchaseTotal(normalizedItems)
    : Number(invoiceTotalRaw);
  if (!Number.isFinite(invoiceTotal) || invoiceTotal < 0) {
    throw new Error("Invoice payable total must be a non-negative amount in the invoice currency.");
  }

  return {
    supplier,
    supplierIdentifier,
    invoiceNo,
    invoiceDate,
    currency,
    baseCurrency,
    exchangeRate,
    exchangeRateDate,
    invoiceTotal,
    items: normalizedItems
  };
}

module.exports = {
  findReversalBatchIndex,
  calculatePurchaseTotal,
  convertToBaseCurrency,
  normalizeInvoiceKey,
  findDuplicateSourceFile,
  isIsoDate,
  normalizeExpiryDate,
  planPurchaseReversal,
  validatePurchaseDraft
};
