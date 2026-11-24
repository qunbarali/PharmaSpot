const path = require("path");
const fs = require("fs");

const MAX_TEXT_CHARS = 200000;
const MAX_LINES = 5000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 30;
const MAX_RENDER_PIXELS = 12000000;
const optionalRequire = name => { try { return require(name); } catch (_) { return null; } };

const DATE_SOURCE = "(?:\\d{4}[./-]\\d{1,2}[./-]\\d{1,2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{1,2}[- ](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[- ]\\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}[./-]\\d{4}|\\d{4}[/-]\\d{1,2}|\\d{1,2}[/-]\\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+\\d{4})";
const NUMBER_SOURCE = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,4})?";
const NUMBER_RE = new RegExp(NUMBER_SOURCE, "g");
const CURRENCY_CODES = new Set(["PKR", "INR", "USD"]);
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12
};

function normalizeText(value) {
  return String(value || "").replace(/\0/g, "").replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v]+/g, " ").replace(/[ ]{2,}/g, " ")
    .replace(/[ ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim().slice(0, MAX_TEXT_CHARS);
}

function toIsoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || y < 1900 || y > 2200 || !Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(d) || d < 1 || d > 31) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return "";
  return date.toISOString().slice(0, 10);
}

function normalizeDate(value) {
  const raw = String(value || "").trim().replace(/,/g, "");
  let match = raw.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (match) return toIsoDate(match[1], match[2], match[3]);
  match = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return toIsoDate(year, match[2], match[1]);
  }
  match = raw.match(/^(\d{4})[./-](\d{1,2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return toIsoDate(year, month, day);
  }
  match = raw.match(/^(\d{1,2})[./-](\d{4})$/);
  if (match) {
    const month = Number(match[1]);
    const year = Number(match[2]);
    const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return toIsoDate(year, month, day);
  }
  match = raw.match(/^(\d{1,2})[./-](\d{2})$/);
  if (match) {
    let year = Number(match[2]);
    year += year >= 70 ? 1900 : 2000;
    const month = Number(match[1]);
    const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return toIsoDate(year, month, day);
  }
  match = raw.match(/^([A-Za-z]{3,9})\s+(\d{4})$/);
  if (match) {
    const month = MONTHS[match[1].toLowerCase()];
    const year = Number(match[2]);
    const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return toIsoDate(year, month, day);
  }
  match = raw.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{2,4})$/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return toIsoDate(year, MONTHS[match[2].toLowerCase()], match[1]);
  }
  match = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{2,4})$/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return toIsoDate(year, MONTHS[match[1].toLowerCase()], match[2]);
  }
  return "";
}

function extractDateTokens(line) {
  const expression = new RegExp(DATE_SOURCE, "gi");
  return Array.from(String(line || "").matchAll(expression)).map(match => ({
    value: match[0],
    index: match.index,
    end: match.index + match[0].length,
    iso: normalizeDate(match[0])
  }));
}

function parseNumber(value) {
  const raw = String(value == null ? "" : value).replace(/,/g, "").replace(/[₹$]/g, "").trim();
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function getLabeledValue(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match && match[1]) return String(match[1]).trim().replace(/[|;,]+$/, "").slice(0, 120);
  }
  return "";
}

function inferSupplier(lines, text) {
  const explicit = getLabeledValue(text, [
    /(?:supplier|vendor|distributor)\s*(?:name|title)\s*[:#=-]\s*([^\n|]+)/i,
    /(?:bill(?:ed)?\s+from|sold\s+by)\s*[:#=-]\s*([^\n|]+)/i,
    /(?:supplier|vendor|distributor)\s*[:#=-]\s*([^\n|]+)/i
  ]);
  if (explicit) return explicit;
  const ignored = /^(?:tax\s+invoice|invoice|bill|purchase\s+invoice|duplicate|original|copy)$/i;
  const metadata = /\b(invoice|bill\s*(?:no|number)|date|ntn|gst|tax\s*id|phone|mobile|email|www\.|http|address|customer|buyer|ship\s*to|bill\s*to|currency|page\s+\d+)\b/i;
  for (const line of lines.slice(0, 12)) {
    const candidate = line.trim().replace(/^[-*#]+\s*/, "");
    if (candidate.length >= 3 && candidate.length <= 120 && !ignored.test(candidate) && !metadata.test(candidate) && /[A-Za-z]/.test(candidate)) return candidate;
  }
  return "";
}

function getExplicitRowValue(rawLine, patterns) {
  for (const pattern of patterns) {
    const match = String(rawLine || "").match(pattern);
    if (match && match[1]) return match[1].trim().replace(/[|;,]+$/, "").slice(0, 100);
  }
  return "";
}

function getExplicitRowNumber(rawLine, patterns) {
  const value = getExplicitRowValue(rawLine, patterns);
  return value ? parseNumber(value) : null;
}

function extractExplicitRowFields(rawLine) {
  const line = String(rawLine || "");
  const itemCode = getExplicitRowValue(line, [/(?:item\s*code|product\s*code|sku)\s*[:#=]\s*([A-Z0-9/-]+)/i]);
  const packing = getExplicitRowValue(line, [/(?:pack(?:ing)?|pack\s*size)\s*[:=]\s*([^;|]+)/i]);
  const bonusQuantity = getExplicitRowNumber(line, [/(?:bonus(?:\s*qty)?|free(?:\s*qty)?|foc(?:\s*qty)?|scheme\s*qty|bns)\s*[:=]\s*([\d,.]+)/i]);
  const discountPercent = getExplicitRowNumber(line, [/(?:discount|disc)\s*(?:%|percent|percentage)?\s*[:=]\s*([\d,.]+)\s*%?/i]);
  const discountAmount = getExplicitRowNumber(line, [/(?:discount|disc)\s*(?:amount|amt)\s*[:=]\s*([\d,.]+)/i]);
  const grossAmount = getExplicitRowNumber(line, [/(?:gross(?:\s*amount)?|gross\s*total)\s*[:=]\s*([\d,.]+)/i]);
  const salesTaxPercent = getExplicitRowNumber(line, [/(?:sales\s*tax|gst|tax)\s*(?:%|percent|rate)?\s*[:=]\s*([\d,.]+)\s*%?/i]);
  const salesTaxAmount = getExplicitRowNumber(line, [/(?:sales\s*tax|gst|tax)\s*(?:amount|amt)\s*[:=]\s*([\d,.]+)/i]);
  const additionalTaxAmount = getExplicitRowNumber(line, [/(?:additional\s*tax|adv(?:ance)?\s*tax|withholding\s*tax|further\s*tax)\s*(?:amount|amt)?\s*[:=]\s*([\d,.]+)/i]);
  const netAmount = getExplicitRowNumber(line, [/(?:net\s*(?:amount|total)|line\s*total|amount)\s*[:=]\s*([\d,.]+)/i]);
  const rawExpiry = getExplicitRowValue(line, [/(?:exp(?:iry|y)?(?:\s*date)?|use\s*by|best\s*before)\s*[:=]\s*([^;|]+)/i]);
  return { itemCode, packing, bonusQuantity: bonusQuantity ?? 0, discountPercent, discountAmount, grossAmount, salesTaxPercent, salesTaxAmount, additionalTaxAmount, netAmount, rawExpiry };
}

function makeRow(description, values) {
  const productName = String(description || "").trim().replace(/\s{2,}/g, " ").slice(0, 160);
  if (!productName || !Number.isFinite(values.quantity) || values.quantity <= 0 ||
      !Number.isFinite(values.purchasePrice) || values.purchasePrice < 0) return null;
  const rawLine = String(values.rawLine || "").slice(0, 300);
  const explicit = extractExplicitRowFields(rawLine);
  const rawExpiry = String(explicit.rawExpiry || values.rawExpiry || "").trim();
  const expiryDate = String(values.expiryDate || normalizeDate(rawExpiry) || "").trim();
  const bonusQuantity = Number.isFinite(values.bonusQuantity) ? values.bonusQuantity : explicit.bonusQuantity;
  const itemCode = String(explicit.itemCode || values.itemCode || "").trim();
  const packing = String(explicit.packing || values.packing || "").trim();
  const grossAmount = explicit.grossAmount ?? values.grossAmount ?? null;
  const discountPercent = explicit.discountPercent ?? values.discountPercent ?? null;
  const discountAmount = explicit.discountAmount ?? values.discountAmount ?? null;
  const salesTaxPercent = explicit.salesTaxPercent ?? values.salesTaxPercent ?? null;
  const salesTaxAmount = explicit.salesTaxAmount ?? values.salesTaxAmount ?? null;
  const additionalTaxAmount = explicit.additionalTaxAmount ?? values.additionalTaxAmount ?? null;
  const netAmount = explicit.netAmount ?? values.netAmount ?? null;
  const salePrice = Number.isFinite(values.salePrice) ? values.salePrice : null;
  const batchNumber = String(values.batchNumber || "").trim().slice(0, 80);
  const sourceConfidence = values.confidence || "low";
  const reviewFlags = [];
  if (salePrice === null) reviewFlags.push("sale price");
  if (!batchNumber) reviewFlags.push("batch number");
  if (!expiryDate || !normalizeDate(expiryDate)) reviewFlags.push("valid expiry date");
  return {
    description: productName, productName,
    itemCode, packing,
    quantity: values.quantity, paidQuantity: values.quantity,
    bonusQuantity, freeQuantity: bonusQuantity,
    purchasePrice: values.purchasePrice, rate: values.purchasePrice, unitPrice: values.purchasePrice,
    salePrice,
    grossAmount, discountPercent, discountAmount, salesTaxPercent,
    salesTaxAmount, additionalTaxAmount, netAmount,
    lineTotal: Number.isFinite(values.lineTotal) ? values.lineTotal : (netAmount ?? null),
    batchNumber,
    rawExpiry, expiryDate,
    fieldConfidence: {
      itemCode: itemCode ? "medium" : "none",
      packing: packing ? "medium" : "none",
      bonusQuantity: bonusQuantity > 0 ? "medium" : "none",
      salePrice: salePrice === null ? "none" : sourceConfidence,
      batchNumber: batchNumber ? sourceConfidence : "none",
      expiryDate: expiryDate && normalizeDate(expiryDate) ? sourceConfidence : "none",
      discount: discountPercent !== null || discountAmount !== null ? "medium" : "none",
      tax: salesTaxAmount !== null || salesTaxPercent !== null || additionalTaxAmount !== null ? "medium" : "none"
    },
    reviewFlags,
    warnings: ["Confirm all extracted values against the original invoice before posting.", ...reviewFlags.map(field => "Missing or invalid " + field + ".")],
    confidence: sourceConfidence, needsReview: true, rawLine
  };
}

function parseLabeledRow(line) {
  if (!/(?:qty|quantity)\s*[:=]/i.test(line) || !/(?:purchase|cost|unit\s*price|rate)\s*[:=]/i.test(line)) return null;
  const description = getLabeledValue(line, [/(?:product|item|description)\s*[:=]\s*([^;|]+)/i]);
  const quantity = parseNumber(getLabeledValue(line, [/(?:qty|quantity)\s*[:=]\s*([\d,.]+)/i]));
  const purchasePrice = parseNumber(getLabeledValue(line, [/(?:purchase\s*price|cost\s*price|unit\s*price|rate|purchase|cost)\s*[:=]\s*([\d,.]+)/i]));
  const salePrice = parseNumber(getLabeledValue(line, [/(?:sale\s*price|retail\s*price|mrp|sale)\s*[:=]\s*([\d,.]+)/i]));
  const batchNumber = getLabeledValue(line, [/(?:batch|lot)\s*(?:no|number|#)?\s*[:=]\s*([A-Z0-9][A-Z0-9/-]*)/i]);
  const expiryRaw = getLabeledValue(line, [/(?:exp(?:iry)?(?:\s*date)?|use\s*by|best\s*before)\s*[:=]\s*([^;|]+)/i]);
  const expiryDate = normalizeDate(expiryRaw) || expiryRaw;
  const total = parseNumber(getLabeledValue(line, [/(?:line\s*total|amount|total)\s*[:=]\s*([\d,.]+)/i]));
  const explicit = extractExplicitRowFields(line);
  return makeRow(description, {
    quantity, purchasePrice, salePrice, batchNumber, expiryDate,
    lineTotal: explicit.netAmount ?? total,
    confidence: "medium", rawLine: line
  });
}

function parseDelimitedRow(line, header) {
  if (!line.includes("|") || !header || !header.includes("|")) return null;
  const columns = header.split("|").map(value => value.trim().toLowerCase()
    .replace(/\./g, "")
    .replace(/[()[\]{}]/g, " ")
    .replace(/[_/+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim());
  const values = line.split("|").map(value => value.trim());
  if (values.length < 3) return null;
  const indexFor = pattern => columns.findIndex(column => pattern.test(column));
  let descriptionIndex = indexFor(/description|product\s*name|medicine/);
  if (descriptionIndex < 0) descriptionIndex = indexFor(/^item(?:\s*name)?$/);
  if (descriptionIndex < 0) descriptionIndex = indexFor(/product|item/);
  let quantityIndex = indexFor(/^(?:paid\s*)?(?:qty|quantity|units?|stock)(?:\s*(?:packs?|pcs?))?$/);
  if (quantityIndex < 0) quantityIndex = columns.findIndex(column =>
    /\b(?:qty|quantity|stock)\b/.test(column) && !/(?:bonus|free|foc|scheme)/.test(column)
  );
  let purchaseIndex = columns.findIndex(column =>
    /purchase|cost|unit\s*price|rate|trade\s*price|\btp\b|\bptr\b/.test(column) && !/sale|retail|mrp/.test(column)
  );
  if (purchaseIndex < 0) purchaseIndex = columns.findIndex(column =>
    /\bprice\b/.test(column) && !/sale|retail|mrp/.test(column)
  );
  const saleIndex = columns.findIndex(column =>
    /^(?:(?:maximum\s+)?retail|mrp|rp|sale|sales|selling|srp)(?:\s+(?:price|rate|value|unit))?(?:\s+(?:(?:incl|including|inc)\s+(?:gst|tax)|rs|pkr|inr|usd))*$/.test(column)
  );
  const bonusIndex = indexFor(/bonus|free|foc|scheme|^bns$/);
  const batchIndex = indexFor(/batch|lot/);
  const expiryIndex = indexFor(/expiry|\bexpy?\b|use\s*by|best\s*before/);
  const grossIndex = indexFor(/gross/);
  const discountPercentIndex = columns.findIndex(column =>
    /disc(?:ount)?/.test(column) && /%|rate|percent/.test(column)
  );
  const discountAmountIndex = columns.findIndex(column =>
    /disc(?:ount)?/.test(column) && /amount|amt|extra/.test(column)
  );
  const salesTaxIndex = indexFor(/sales?\s*tax|gst/);
  const additionalTaxIndexes = columns.reduce((indexes, column, index) => {
    if (/fur(?:ther)?\.?\s*tax|additional|advance|adv\.?|awh|withholding/.test(column) && !/%|rate|percent/.test(column)) indexes.push(index);
    return indexes;
  }, []);
  const netIndex = indexFor(/net/);
  const totalIndex = netIndex >= 0 ? netIndex : columns.findIndex(column =>
    /line\s*total|\bamount\b|\btotal\b/.test(column) && !/gross|discount|tax/.test(column)
  );
  const itemCodeIndex = indexFor(/(?:item|product)\s*code|^code$/);
  const packingIndex = indexFor(/pack(?:ing)?|pack\s*size/);
  const get = index => index >= 0 && index < values.length ? values[index] : "";
  const quantity = parseNumber(get(quantityIndex));
  const purchasePrice = parseNumber(get(purchaseIndex));
  const salePrice = parseNumber(get(saleIndex));
  const bonusQuantity = parseNumber(get(bonusIndex));
  const lineTotal = parseNumber(get(totalIndex));
  const expiryRaw = get(expiryIndex);
  const expiryDate = normalizeDate(expiryRaw) || expiryRaw;
  const salesTaxHeader = salesTaxIndex >= 0 ? columns[salesTaxIndex] : "";
  const salesTaxValue = parseNumber(get(salesTaxIndex));
  const additionalTaxValues = additionalTaxIndexes.map(index => parseNumber(get(index))).filter(value => value !== null);
  const additionalTaxAmount = additionalTaxValues.length ? additionalTaxValues.reduce((sum, value) => sum + value, 0) : null;
  return makeRow(get(descriptionIndex), {
    quantity, purchasePrice, salePrice, bonusQuantity, lineTotal,
    itemCode: get(itemCodeIndex), packing: get(packingIndex),
    grossAmount: parseNumber(get(grossIndex)),
    discountPercent: parseNumber(get(discountPercentIndex)),
    discountAmount: parseNumber(get(discountAmountIndex)),
    salesTaxPercent: /%|rate|percent/.test(salesTaxHeader) ? salesTaxValue : null,
    salesTaxAmount: /%|rate|percent/.test(salesTaxHeader) ? null : salesTaxValue,
    additionalTaxAmount,
    netAmount: parseNumber(get(netIndex)),
    batchNumber: get(batchIndex), rawExpiry: expiryRaw, expiryDate,
    confidence: "medium", rawLine: line
  });
}

function parseLooseRow(line, headerContext) {
  if (!line || line.length < 5 || /\b(subtotal|grand\s*total|amount\s*due|total\s+tax|discount|taxable\s+value|invoice\s+total|balance\s+due)\b/i.test(line)) return null;
  if (/\b(?:invoice|bill)\s*(?:no|number|date)\b/i.test(line) || /\b(?:supplier|vendor|distributor|ntn|gstin|tax\s*id)\s*[:#]/i.test(line)) return null;

  let cleaned = line;
  const batchLabelPatterns = [
    /(?:batch|lot)\s*(?:no\.?|number|#)?\s*[:=]\s*([A-Z0-9][A-Z0-9/-]*)/i,
    /(?:batch|lot)\s*#\s*([A-Z0-9][A-Z0-9/-]*)/i
  ];
  let batchNumber = getLabeledValue(cleaned, batchLabelPatterns);
  for (const pattern of batchLabelPatterns) cleaned = cleaned.replace(pattern, " ");

  const dates = extractDateTokens(cleaned);
  const expiryLabel = cleaned.match(new RegExp("(?:exp(?:iry|y)?(?:\\s*date)?|use\\s*by|best\\s*before)\\s*[:#-]?\\s*(" + DATE_SOURCE + ")", "i"));
  let rawExpiry = "";
  let expiryDate = "";
  if (expiryLabel) {
    rawExpiry = expiryLabel[1];
    expiryDate = normalizeDate(rawExpiry) || rawExpiry;
  } else if (dates.length) {
    rawExpiry = dates[dates.length - 1].value;
    expiryDate = dates[dates.length - 1].iso || rawExpiry;
  }
  if (dates.length) {
    for (const date of dates.slice().reverse()) cleaned = cleaned.slice(0, date.index) + " " + cleaned.slice(date.end);
  }
  cleaned = cleaned.replace(/(?:exp(?:iry|y)?|use\s*by|best\s*before)\s*[:#-]?\s*/ig, " ");

  if (!batchNumber) {
    const trailingBatch = cleaned.match(/\s+([A-Z][A-Z0-9/-]{1,})\s*$/i);
    if (trailingBatch && /[0-9]/.test(trailingBatch[1])) {
      batchNumber = trailingBatch[1];
      cleaned = cleaned.slice(0, trailingBatch.index);
    }
  }

  const trailingNumbers = cleaned.match(new RegExp("(" + NUMBER_SOURCE + "(?:\\s+" + NUMBER_SOURCE + "){1,3})\\s*$"));
  if (!trailingNumbers) return null;
  const numericValues = trailingNumbers[1].match(NUMBER_RE).map(parseNumber).filter(value => value !== null);
  if (numericValues.length < 2) return null;
  const description = cleaned.slice(0, trailingNumbers.index).replace(/^\s*(?:\d{1,3}[.)-]\s*)?/, "").trim();
  const hasSaleColumn = /\b(?:sale|sales|retail|mrp)\b/i.test(headerContext || "") && !/\b(?:sale|sales)\s*tax\b/i.test(headerContext || "");
  const hasTotalColumn = /\b(amount|line\s*total|total)\b/i.test(headerContext || "");
  let salePrice = null;
  let lineTotal = null;
  if (numericValues.length >= 4) {
    salePrice = numericValues[2];
    lineTotal = numericValues[3];
  } else if (numericValues.length === 3 && hasSaleColumn && !hasTotalColumn) {
    salePrice = numericValues[2];
  } else if (numericValues.length === 3) {
    lineTotal = numericValues[2];
  }
  return makeRow(description, {
    quantity: numericValues[0],
    purchasePrice: numericValues[1],
    salePrice,
    lineTotal,
    batchNumber,
    rawExpiry,
    expiryDate,
    confidence: "low",
    rawLine: line
  });
}

function textItemsToLines(items) {
  const source = (items || []).map((item, index) => {
    const value = String(item && item.str || "").trim();
    const transform = item && Array.isArray(item.transform) ? item.transform : [];
    return {
      value, index,
      x: Number(transform[4]),
      y: Number(transform[5]),
      width: Number(item && item.width),
      height: Math.abs(Number(transform[3]) || 10),
      rotated: Math.abs(Number(transform[1]) || 0) > 0.75 || Math.abs(Number(transform[2]) || 0) > 0.75
    };
  }).filter(item => item.value);
  if (!source.length) return "";

  const hasGeometry = source.every(item => Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.width));
  const hasRotation = source.some(item => item.rotated);
  if (!hasGeometry || hasRotation) {
    const lines = [];
    let current = [];
    let currentY = null;
    for (const item of items || []) {
      const value = String(item && item.str || "").trim();
      if (!value) continue;
      const y = item && Array.isArray(item.transform) ? Number(item.transform[5]) : null;
      if (current.length && Number.isFinite(y) && Number.isFinite(currentY) && Math.abs(y - currentY) > 2.5) {
        lines.push(current.join(" ").trim());
        current = [];
      }
      if (!current.length) currentY = y;
      current.push(value);
    }
    if (current.length) lines.push(current.join(" ").trim());
    return lines.join("\n");
  }

  source.sort((a, b) => b.y - a.y || a.x - b.x || a.index - b.index);
  const groups = [];
  for (const item of source) {
    const current = groups[groups.length - 1];
    const tolerance = current ? Math.max(2.5, Math.min(current.height, item.height) * 0.25) : 2.5;
    if (!current || Math.abs(item.y - current.y) > tolerance) {
      groups.push({ y: item.y, height: item.height, items: [item] });
    } else {
      current.items.push(item);
      current.height = Math.max(current.height, item.height);
    }
  }
  return groups.map(group => {
    group.items.sort((a, b) => a.x - b.x || a.index - b.index);
    let line = "";
    let previousEnd = null;
    let previousHeight = group.height;
    for (const item of group.items) {
      if (previousEnd !== null) {
        const gap = item.x - previousEnd;
        const separatorThreshold = Math.max(14, Math.max(previousHeight, item.height) * 1.35);
        line += gap > separatorThreshold ? " | " : " ";
      }
      line += item.value;
      previousEnd = item.x + item.width;
      previousHeight = item.height;
    }
    return line.trim();
  }).join("\n");
}

function ocrWordsToLines(result) {
  const data = result && result.data ? result.data : {};
  const words = (Array.isArray(data.words) ? data.words : []).map((word, index) => {
    const box = word && word.bbox ? word.bbox : {};
    return {
      text: String(word && word.text || "").trim(),
      x0: Number(box.x0), x1: Number(box.x1),
      y0: Number(box.y0), y1: Number(box.y1), index
    };
  }).filter(word => word.text && [word.x0, word.x1, word.y0, word.y1].every(Number.isFinite));
  if (!words.length) return normalizeText(data.text);

  words.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0 || a.index - b.index);
  const groups = [];
  for (const word of words) {
    const center = (word.y0 + word.y1) / 2;
    const height = Math.max(1, word.y1 - word.y0);
    let group = null;
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const candidate = groups[i];
      if (center - candidate.center > Math.max(8, height * 0.8)) break;
      if (Math.abs(center - candidate.center) <= Math.max(5, Math.min(height, candidate.height) * 0.45)) {
        group = candidate;
        break;
      }
    }
    if (!group) {
      group = { center, height, words: [] };
      groups.push(group);
    }
    group.words.push(word);
    group.center = group.words.reduce((sum, entry) => sum + (entry.y0 + entry.y1) / 2, 0) / group.words.length;
    group.height = Math.max(group.height, height);
  }

  return groups.map(group => {
    group.words.sort((a, b) => a.x0 - b.x0 || a.index - b.index);
    let line = "";
    let previousEnd = null;
    const threshold = Math.max(12, group.height * 0.75);
    for (const word of group.words) {
      if (previousEnd !== null) {
        const gap = word.x0 - previousEnd;
        line += gap > threshold ? " | " : " ";
      }
      line += word.text;
      previousEnd = word.x1;
    }
    return line.trim();
  }).join("\n");
}

function hasStructuredInvoiceText(raw, hasRotatedText = false) {
  if (hasRotatedText) return false;
  const text = normalizeText(raw);
  if (text.length < 40 || (text.match(/[A-Za-z0-9]{2,}/g) || []).length < 6) return false;
  return parseInvoiceText(text).rows.length > 0;
}

function parseBatchExpiryContinuation(line) {
  const value = String(line || "").trim();
  if (!value || isInvoiceMetadataLine(value)) return null;
  const dates = extractDateTokens(value);
  if (!dates.length) return null;
  const expiry = dates[dates.length - 1];
  const explicitBatch = value.match(/(?:batch|lot)\s*(?:no\.?|number|#)?\s*[:=]\s*([A-Z0-9][A-Z0-9/-]*)/i);
  const withoutDate = value.slice(0, expiry.index) + " " + value.slice(expiry.end);
  const trailingBatch = withoutDate.trim().match(/(?:^|\s)([A-Z][A-Z0-9/-]{1,})\s*$/i);
  const batchNumber = explicitBatch ? explicitBatch[1] : (trailingBatch ? trailingBatch[1] : "");
  const hasExpiryLabel = /(?:exp(?:iry|y)?(?:\s*date)?|use\s*by|best\s*before)/i.test(value);
  if (!batchNumber && !hasExpiryLabel) return null;
  return {
    batchNumber,
    rawExpiry: expiry.value,
    expiryDate: expiry.iso || expiry.value
  };
}

function isInvoiceMetadataLine(line) {
  return /\b(?:supplier|vendor|distributor|invoice|bill\s*(?:no|number|date)|invoice\s*(?:no|number|date)|ntn|gstin|tax\s*id|grand\s*total|invoice\s*total|net\s*payable|amount\s*due|balance\s*due|subtotal|total\s*tax)\b/i.test(String(line || ""));
}

function parseInvoiceText(raw) {
  const text = normalizeText(raw);
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean).slice(0, MAX_LINES);
  const supplier = inferSupplier(lines, text);
  const supplierIdentifier = getLabeledValue(text, [
    /(?:supplier|vendor|distributor)\s*(?:id|code|no\.?|number)\s*[:#-]\s*([A-Z0-9][A-Z0-9/-]*)/i,
    /\b(?:NTN|GSTIN|GST|tax\s*id|registration\s*(?:no|number))\s*(?:no\.?|number|#)?\s*[:#=-]?\s*([A-Z0-9][A-Z0-9/-]{2,})/i
  ]);
  const invoiceNo = getLabeledValue(text, [
    /(?:invoice|bill|inv\.?|voucher)\s*(?:no\.?|number|num|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]*)/i,
    /(?:invoice|bill|inv\.?|voucher)\s*[:#]\s*([A-Z0-9][A-Z0-9/-]*)/i
  ]);
  const invoiceDateRaw = getLabeledValue(text, [
    new RegExp("(?:invoice\\s*date|bill\\s*date|(?<!expiry\\s)(?<!exp\\s)(?<!due\\s)\\bdate\\b)\\s*[:#-]?\\s*(" + DATE_SOURCE + ")", "i")
  ]);
  const invoiceDate = normalizeDate(invoiceDateRaw) || invoiceDateRaw;
  const invoiceTotalRaw = getLabeledValue(text, [
    /(?:grand\s*total|invoice\s*total|net\s*payable|total\s*payable|amount\s*due|balance\s*payable)\s*[:#=-]\s*(?:PKR|INR|USD|Rs\.?|₹|\$)?\s*([\d,]+(?:\.\d{1,4})?)(?![\d,./-])/i,
    /(?:grand\s*total|invoice\s*total|net\s*payable|total\s*payable|amount\s*due|balance\s*payable)\s+(?:PKR|INR|USD|Rs\.?|₹|\$)?\s*([\d,]+(?:\.\d{1,4})?)(?![\d,./-])/i
  ]);
  const invoiceTotal = parseNumber(invoiceTotalRaw);
  const explicitCurrency = getLabeledValue(text, [
    /(?:invoice\s*)?currency\s*[:#=-]\s*(PKR|INR|USD|Rs\.?|₹|\$)/i
  ]);
  let currency = "";
  if (/^(?:PKR|Rs\.?)$/i.test(explicitCurrency)) currency = "PKR";
  else if (/^INR$/i.test(explicitCurrency) || explicitCurrency === "₹") currency = "INR";
  else if (/^USD$/i.test(explicitCurrency) || explicitCurrency === "$") currency = "USD";
  else if (/\bUSD\b/i.test(text)) currency = "USD";
  else if (/\bINR\b/i.test(text)) currency = "INR";
  else if (/\bPKR\b/i.test(text)) currency = "PKR";
  else if (/₹/.test(text)) currency = "INR";
  else if (/\bRs\.?/i.test(text)) currency = "PKR";
  else if (/\$/.test(text)) currency = "USD";
  if (!CURRENCY_CODES.has(currency)) currency = "";

  const rows = [];
  let headerContext = "";
  let delimitedHeader = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const isLabelledLine = /(?:product|item|description)\s*[:=]/i.test(line) || /(?:qty|quantity)\s*[:=]/i.test(line);
    if (!isLabelledLine && /\b(item|product|description|medicine|code)\b/i.test(line) && /\b(qty|quantity|stock)\b/i.test(line)) {
      headerContext = line;
      if (line.includes("|")) delimitedHeader = line;
      continue;
    }

    const parseRow = value => parseDelimitedRow(value, delimitedHeader) || parseLabeledRow(value) || parseLooseRow(value, headerContext);
    let row = parseRow(line);

    // Distributor invoices often wrap the medicine description onto one line and
    // put the numeric columns on the next. Join only numeric-leading continuations.
    if (!row && index + 1 < lines.length && !isInvoiceMetadataLine(line)) {
      const nextLine = lines[index + 1];
      const nextLooksLikeNumericContinuation = /^\s*(?:\d+(?:[,.]\d+)?|qty\s*[:=])/i.test(nextLine);
      if (nextLooksLikeNumericContinuation && !isInvoiceMetadataLine(nextLine)) {
        row = parseRow(line + " " + nextLine);
        if (row) index += 1;
      }
    }

    // Batch and expiry are sometimes printed below an otherwise complete row.
    if (row && (!row.batchNumber || !row.expiryDate) && index + 1 < lines.length) {
      const continuation = parseBatchExpiryContinuation(lines[index + 1]);
      if (continuation) {
        row = {
          ...row,
          batchNumber: row.batchNumber || continuation.batchNumber,
          rawExpiry: row.rawExpiry || continuation.rawExpiry,
          expiryDate: row.expiryDate || continuation.expiryDate,
          rawLine: (row.rawLine + " " + lines[index + 1]).slice(0, 300)
        };
        index += 1;
      }
    }

    if (row && !rows.some(existing => existing.rawLine === row.rawLine)) rows.push(row);
    if (rows.length >= 500) break;
  }

  const missingInvoiceFields = [];
  if (!supplier) missingInvoiceFields.push("supplier");
  if (!supplierIdentifier) missingInvoiceFields.push("supplier identifier (NTN/GST or distributor code)");
  if (!invoiceNo) missingInvoiceFields.push("invoice number");
  if (!invoiceDate || !normalizeDate(invoiceDate)) missingInvoiceFields.push("valid invoice date");
  if (!currency) missingInvoiceFields.push("invoice currency");
  return {
    text,
    fields: { supplier, supplierIdentifier, invoiceNo, invoiceDate, currency, invoiceTotal },
    rows,
    reviewSummary: {
      missingInvoiceFields,
      rowsNeedingReview: rows.filter(row => row.reviewFlags && row.reviewFlags.length).length,
      totalRows: rows.length
    },
    reviewRequired: true,
    warning: "OCR output is an unapproved draft. Confirm supplier identifiers, invoice number/date/currency/payable total, product mapping, every quantity and price, line discounts and taxes, batch number and expiry date against the original document before saving or approving."
  };
}

async function createOcrWorker() {
  const Tesseract = optionalRequire("tesseract.js");
  if (!Tesseract || typeof Tesseract.createWorker !== "function") throw new Error("OCR is unavailable. Install the locked tesseract.js dependency and restart PharmaSpot.");
  let langPath;
  try {
    const dataPackage = path.dirname(require.resolve("@tesseract.js-data/eng/package.json"));
    langPath = path.join(dataPackage, "4.0.0_best_int");
  } catch (_) {
    throw new Error("English OCR language data is unavailable. Reinstall @tesseract.js-data/eng and restart PharmaSpot.");
  }
  return Tesseract.createWorker("eng", 1, { langPath });
}

function validateFile(filePath, extension) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("The staged document is not a regular file.");
  if (stat.size <= 0 || stat.size > MAX_FILE_BYTES) throw new Error("Document must be between 1 byte and 20 MB.");
  const header = Buffer.alloc(16);
  const fd = fs.openSync(filePath, "r");
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (extension === ".pdf" && header.toString("ascii", 0, 5) !== "%PDF-") throw new Error("The uploaded PDF has an invalid file signature.");
  if ((extension === ".jpg" || extension === ".jpeg") && !(header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)) throw new Error("The uploaded JPEG has an invalid file signature.");
  if (extension === ".png" && !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("The uploaded PNG has an invalid file signature.");
  if (extension === ".webp" && !(header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP")) throw new Error("The uploaded WEBP has an invalid file signature.");
  return stat;
}

function scoreOcrResult(result) {
  const text = ocrWordsToLines(result);
  const data = result && result.data ? result.data : {};
  const confidence = Number(data.confidence);
  const wordCount = Array.isArray(data.words)
    ? data.words.filter(word => String(word && word.text || "").trim()).length
    : (text.match(/\S+/g) || []).length;
  const usefulTokens = (text.match(/[A-Za-z0-9]{2,}/g) || []).length;
  return {
    text,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    wordCount,
    score: (Number.isFinite(confidence) ? confidence : 0) + Math.min(usefulTokens, 80) * 0.08
  };
}

function enhanceCanvasForOcr(canvas) {
  const context = canvas.getContext("2d");
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  const lookup = new Uint8Array(256);
  for (let value = 0; value < 256; value += 1) {
    lookup[value] = Math.max(0, Math.min(255, Math.round((value - 128) * 1.6 + 128)));
  }
  for (let index = 0; index < pixels.length; index += 4) {
    const gray = (pixels[index] * 77 + pixels[index + 1] * 150 + pixels[index + 2] * 29) >> 8;
    const value = lookup[gray];
    pixels[index] = value;
    pixels[index + 1] = value;
    pixels[index + 2] = value;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

async function recognizeCanvasWithRotation(canvas, worker) {
  enhanceCanvasForOcr(canvas);
  const { createCanvas } = require("@napi-rs/canvas");
  let best = null;
  for (const rotation of [0, 90, 270, 180]) {
    let target = canvas;
    let temporary = false;
    if (rotation !== 0) {
      const width = rotation % 180 === 0 ? canvas.width : canvas.height;
      const height = rotation % 180 === 0 ? canvas.height : canvas.width;
      target = createCanvas(width, height);
      temporary = true;
      const context = target.getContext("2d");
      context.translate(width / 2, height / 2);
      context.rotate(rotation * Math.PI / 180);
      context.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    }
    try {
      const result = await worker.recognize(target.toBuffer("image/png"));
      const candidate = scoreOcrResult(result);
      if (!best || candidate.score > best.score) best = candidate;
      if (candidate.confidence >= 93 && candidate.wordCount >= 12) return candidate.text;
    } finally {
      if (temporary) {
        target.width = 0;
        target.height = 0;
      }
    }
  }
  return best ? best.text : "";
}

function readWebpDimensions(buffer) {
  if (buffer.length < 20 || buffer.toString("ascii", 0, 4) !== "RIFF" ||
      buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const riffSize = buffer.readUInt32LE(4);
  const riffEnd = Math.min(buffer.length, riffSize + 8);
  if (riffSize < 4 || riffEnd < 20) return null;

  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + chunkSize;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > riffEnd) return null;

    if (chunkType === "VP8X" && chunkSize >= 10) {
      return {
        width: 1 + buffer.readUIntLE(dataOffset + 4, 3),
        height: 1 + buffer.readUIntLE(dataOffset + 7, 3)
      };
    }
    if (chunkType === "VP8L" && chunkSize >= 5 && buffer[dataOffset] === 0x2f) {
      const b1 = buffer[dataOffset + 1];
      const b2 = buffer[dataOffset + 2];
      const b3 = buffer[dataOffset + 3];
      const b4 = buffer[dataOffset + 4];
      return {
        width: 1 + (b1 | ((b2 & 0x3f) << 8)),
        height: 1 + (((b2 & 0xc0) >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10))
      };
    }
    if (chunkType === "VP8 " && chunkSize >= 10 &&
        buffer[dataOffset + 3] === 0x9d && buffer[dataOffset + 4] === 0x01 && buffer[dataOffset + 5] === 0x2a) {
      return {
        width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff
      };
    }

    offset = chunkEnd + (chunkSize & 1);
  }
  return null;
}

function readImageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 4 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      while (buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
      if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
        return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
      }
      offset += segmentLength;
    }
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return readWebpDimensions(buffer);
  }
  return null;
}

async function recognizeImageBuffer(buffer, maxPixels) {
  const { createCanvas, loadImage } = require("@napi-rs/canvas");
  const declaredDimensions = readImageDimensions(buffer);
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  if ((isPng || isJpeg || isWebp) && !declaredDimensions) {
    throw new Error("The uploaded image has invalid or unreadable dimensions.");
  }
  if (declaredDimensions) {
    const declaredPixels = declaredDimensions.width * declaredDimensions.height;
    if (!declaredDimensions.width || !declaredDimensions.height || !Number.isSafeInteger(declaredPixels) || declaredPixels > maxPixels) {
      throw new Error("The uploaded image exceeds the safe OCR rendering size.");
    }
  }
  const image = await loadImage(buffer);
  if (!image.width || !image.height) throw new Error("The uploaded image has invalid dimensions.");
  const pixels = image.width * image.height;
  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) throw new Error("The uploaded image exceeds the safe OCR rendering size.");
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0, image.width, image.height);
  const worker = await createOcrWorker();
  try {
    return await recognizeCanvasWithRotation(canvas, worker);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    await worker.terminate();
  }
}

async function extractPdf(filePath) {
  let loadingTask;
  let pdfDocument;
  let worker;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { createCanvas } = require("@napi-rs/canvas");
    const pdfjsBuildDir = path.dirname(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
    const { pathToFileURL } = require("node:url");
    const assetUrl = (...segments) => pathToFileURL(path.resolve(pdfjsBuildDir, "..", "..", ...segments) + path.sep).href;
    const bytes = new Uint8Array(fs.readFileSync(filePath));
    loadingTask = pdfjs.getDocument({
      data: bytes,
      cMapUrl: assetUrl("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: assetUrl("standard_fonts"),
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false
    });
    pdfDocument = await loadingTask.promise;
    if (!pdfDocument.numPages || pdfDocument.numPages > MAX_PDF_PAGES) throw new Error("PDF must contain between 1 and 30 pages.");
    const pageTexts = [];
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const items = (content.items || []).filter(item => item && typeof item.str === "string" && item.str.trim());
        const nativeText = normalizeText(textItemsToLines(items));
        const hasRotatedText = items.some(item => {
          const transform = Array.isArray(item.transform) ? item.transform : [];
          return Math.abs(Number(transform[1]) || 0) > 0.75 || Math.abs(Number(transform[2]) || 0) > 0.75;
        });
        let pageText = hasStructuredInvoiceText(nativeText, hasRotatedText) ? nativeText : "";
        if (!pageText) {
          if (!worker) worker = await createOcrWorker();
          const baseViewport = page.getViewport({ scale: 1 });
          const basePixels = Math.max(1, baseViewport.width * baseViewport.height);
          const scale = Math.min(2, Math.sqrt(MAX_RENDER_PIXELS / basePixels));
          const viewport = page.getViewport({ scale: Math.max(0.5, scale) });
          const width = Math.ceil(viewport.width);
          const height = Math.ceil(viewport.height);
          if (!width || !height || width * height > MAX_RENDER_PIXELS) throw new Error("A PDF page exceeds the safe OCR rendering size.");
          const canvas = createCanvas(width, height);
          try {
            const context = canvas.getContext("2d");
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, width, height);
            await page.render({ canvasContext: context, viewport }).promise;
            const recognizedText = await recognizeCanvasWithRotation(canvas, worker);
            pageText = normalizeText([nativeText, recognizedText].filter(Boolean).join("\n"));
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        }
        if (pageText) pageTexts.push("[Page " + pageNumber + "]\n" + pageText);
      } finally {
        page.cleanup();
      }
      if (pageTexts.join("\n").length >= MAX_TEXT_CHARS) break;
    }
    const text = normalizeText(pageTexts.join("\n\n"));
    if (!text) throw new Error("No readable text was detected in the PDF. Try a clearer scan or upload page images.");
    return text;
  } catch (error) {
    if (error && /between 1 and 30|safe OCR rendering size|No readable text|invalid file signature/.test(error.message)) throw error;
    throw new Error("PDF extraction failed. Check the PDF file and the locked PDF/OCR dependencies: " + (error.message || "unknown error"));
  } finally {
    if (worker) await worker.terminate();
    if (loadingTask) await loadingTask.destroy();
  }
}

async function extractImage(filePath, extension) {
  validateFile(filePath, extension);
  const buffer = fs.readFileSync(filePath);
  return recognizeImageBuffer(buffer, MAX_RENDER_PIXELS);
}

async function extractInvoice(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (![".pdf", ".jpg", ".jpeg", ".png", ".webp"].includes(extension)) throw new Error("Unsupported invoice file. Use PDF, JPG, JPEG, PNG or WEBP.");
  validateFile(filePath, extension);
  const text = extension === ".pdf" ? await extractPdf(filePath) : await extractImage(filePath, extension);
  if (!text) throw new Error("No readable invoice text was detected.");
  return parseInvoiceText(text);
}

module.exports = { normalizeText, normalizeDate, parseInvoiceText, hasStructuredInvoiceText, textItemsToLines, ocrWordsToLines, enhanceCanvasForOcr, validateInvoiceFile: validateFile, extractInvoice };
