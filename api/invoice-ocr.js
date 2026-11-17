const path = require("path");
const fs = require("fs");

const MAX_TEXT_CHARS = 200000;
const MAX_LINES = 5000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 30;
const MAX_RENDER_PIXELS = 12000000;
const optionalRequire = name => { try { return require(name); } catch (_) { return null; } };

const DATE_SOURCE = "(?:\\d{4}[./-]\\d{1,2}[./-]\\d{1,2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{1,2}[- ](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[- ]\\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+\\d{1,2},?\\s+\\d{2,4})";
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
  const number = Number(String(value == null ? "" : value).replace(/,/g, "").replace(/[₹$]/g, "").trim());
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
    /(?:supplier|vendor|distributor|bill(?:ed)?\s+from|sold\s+by)\s*[:#-]\s*([^\n|]+)/i
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

function makeRow(description, values) {
  const productName = String(description || "").trim().replace(/\s{2,}/g, " ").slice(0, 160);
  if (!productName || !Number.isFinite(values.quantity) || values.quantity <= 0 ||
      !Number.isFinite(values.purchasePrice) || values.purchasePrice < 0) return null;
  return {
    description: productName,
    productName,
    quantity: values.quantity,
    purchasePrice: values.purchasePrice,
    unitPrice: values.purchasePrice,
    salePrice: Number.isFinite(values.salePrice) ? values.salePrice : null,
    lineTotal: Number.isFinite(values.lineTotal) ? values.lineTotal : null,
    batchNumber: String(values.batchNumber || "").trim().slice(0, 80),
    expiryDate: String(values.expiryDate || "").trim(),
    confidence: values.confidence || "low",
    needsReview: true,
    rawLine: String(values.rawLine || "").slice(0, 300)
  };
}

function parseLabeledRow(line) {
  if (!/(?:qty|quantity)\s*[:=]/i.test(line) || !/(?:purchase|cost|unit\s*price|rate)\s*[:=]/i.test(line)) return null;
  const description = getLabeledValue(line, [/(?:product|item|description)\s*[:=]\s*([^;|]+)/i]);
  const quantity = parseNumber(getLabeledValue(line, [/(?:qty|quantity)\s*[:=]\s*([\d,.]+)/i]));
  const purchasePrice = parseNumber(getLabeledValue(line, [/(?:purchase\s*price|cost\s*price|unit\s*price|rate|purchase|cost)\s*[:=]\s*([\d,.]+)/i]));
  const salePrice = parseNumber(getLabeledValue(line, [/(?:sale\s*price|retail\s*price|mrp|sale)\s*[:=]\s*([\d,.]+)/i]));
  const batchNumber = getLabeledValue(line, [/(?:batch|lot)\s*(?:no|number|#)?\s*[:=]\s*([A-Z0-9][A-Z0-9/-]*)/i]);
  const expiryRaw = getLabeledValue(line, [/(?:exp(?:iry)?|use\s*by|best\s*before)\s*[:=]\s*([^;|]+)/i]);
  const expiryDate = normalizeDate(expiryRaw) || expiryRaw;
  const total = parseNumber(getLabeledValue(line, [/(?:line\s*total|amount|total)\s*[:=]\s*([\d,.]+)/i]));
  return makeRow(description, {
    quantity, purchasePrice, salePrice, lineTotal: total, batchNumber, expiryDate,
    confidence: "medium", rawLine: line
  });
}

function parseDelimitedRow(line, header) {
  if (!line.includes("|") || !header || !header.includes("|")) return null;
  const columns = header.split("|").map(value => value.trim().toLowerCase());
  const values = line.split("|").map(value => value.trim());
  if (values.length < 3) return null;
  const indexFor = pattern => columns.findIndex(column => pattern.test(column));
  const descriptionIndex = indexFor(/item|product|description|medicine/);
  const quantityIndex = indexFor(/qty|quantity/);
  const purchaseIndex = indexFor(/purchase|cost|unit\s*price|rate|price/);
  const saleIndex = indexFor(/sale|retail|mrp/);
  const totalIndex = indexFor(/amount|line\s*total|total/);
  const batchIndex = indexFor(/batch|lot/);
  const expiryIndex = indexFor(/expiry|exp\b|use\s*by/);
  const get = index => index >= 0 && index < values.length ? values[index] : "";
  const quantity = parseNumber(get(quantityIndex));
  const purchasePrice = parseNumber(get(purchaseIndex));
  const salePrice = parseNumber(get(saleIndex));
  const lineTotal = parseNumber(get(totalIndex));
  const expiryRaw = get(expiryIndex);
  const expiryDate = normalizeDate(expiryRaw) || expiryRaw;
  return makeRow(get(descriptionIndex), {
    quantity, purchasePrice, salePrice, lineTotal,
    batchNumber: get(batchIndex), expiryDate,
    confidence: "medium", rawLine: line
  });
}

function parseLooseRow(line, headerContext) {
  if (!line || line.length < 5 || /\b(subtotal|grand\s*total|amount\s*due|total\s+tax|discount|taxable\s+value|invoice\s+total|balance\s+due)\b/i.test(line)) return null;
  if (/\b(?:invoice|bill)\s*(?:no|number|date)\b/i.test(line) || /\b(?:supplier|vendor|distributor|ntn|gstin|tax\s*id)\s*[:#]/i.test(line)) return null;

  let cleaned = line;
  let batchNumber = getLabeledValue(cleaned, [/(?:batch|lot)\s*(?:no|number|#)?\s*[:#-]\s*([A-Z0-9][A-Z0-9/-]*)/i]);
  cleaned = cleaned.replace(/\b(?:batch|lot)\s*(?:no|number|#)?\s*[:#-]?\s*[A-Z0-9][A-Z0-9/-]*/i, " ");

  const dates = extractDateTokens(cleaned);
  const expiryLabel = cleaned.match(new RegExp("(?:exp(?:iry)?|use\\s*by|best\\s*before)\\s*[:#-]?\\s*(" + DATE_SOURCE + ")", "i"));
  let expiryDate = "";
  if (expiryLabel) expiryDate = normalizeDate(expiryLabel[1]) || expiryLabel[1];
  else if (dates.length) expiryDate = dates[dates.length - 1].iso || dates[dates.length - 1].value;
  if (dates.length) {
    for (const date of dates.slice().reverse()) cleaned = cleaned.slice(0, date.index) + " " + cleaned.slice(date.end);
  }
  cleaned = cleaned.replace(/(?:exp(?:iry)?|use\s*by|best\s*before)\s*[:#-]?\s*/ig, " ");

  if (!batchNumber) {
    const trailingBatch = cleaned.match(/\s+([A-Z][A-Z0-9/-]{2,})\s*$/i);
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
  const hasSaleColumn = /\b(sale|retail|mrp)\b/i.test(headerContext || "");
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
    expiryDate,
    confidence: "low",
    rawLine: line
  });
}

function parseInvoiceText(raw) {
  const text = normalizeText(raw);
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean).slice(0, MAX_LINES);
  const supplier = inferSupplier(lines, text);
  const supplierIdentifier = getLabeledValue(text, [
    /(?:supplier|vendor|distributor)\s*(?:id|code)\s*[:#-]\s*([A-Z0-9/-]+)/i,
    /\b(?:NTN|GSTIN?|tax\s*id|registration\s*(?:no|number))\s*[:#-]?\s*([A-Z0-9/-]{3,})/i
  ]);
  const invoiceNo = getLabeledValue(text, [
    new RegExp("(?:invoice\\s*date|bill\\s*date|date)\\s*[:#-]?\\s*(" + DATE_SOURCE + ")", "i")
    new RegExp("(?:invoice\\s*date|bill\\s*date|date)\\s*[:#-]?\\s*(" + DATE_SOURCE + ")", "i")
  ]);
  const invoiceDateRaw = getLabeledValue(text, [
    new RegExp("(?:invoice\\s*date|bill\\s*date|date)\\s*[:#-]?\\s*(" + DATE_SOURCE + ")", "i")
  ]);
  const invoiceDate = normalizeDate(invoiceDateRaw) || invoiceDateRaw;
  let currency = "";
  if (/\bUSD\b/i.test(text)) currency = "USD";
  else if (/\bINR\b/i.test(text)) currency = "INR";
  else if (/\bPKR\b/i.test(text)) currency = "PKR";
  else if (/₹/.test(text)) currency = "INR";
  else if (/\bRs\.?\b/i.test(text)) currency = "PKR";
  else if (/\$/.test(text)) currency = "USD";
  if (!CURRENCY_CODES.has(currency)) currency = "";

  const rows = [];
  let headerContext = "";
  let delimitedHeader = "";
  for (const line of lines) {
    if (/\b(item|product|description|medicine)\b/i.test(line) && /\b(qty|quantity)\b/i.test(line)) {
      headerContext = line;
      if (line.includes("|")) delimitedHeader = line;
      continue;
    }
    const row = parseDelimitedRow(line, delimitedHeader) || parseLabeledRow(line) || parseLooseRow(line, headerContext);
    if (row && !rows.some(existing => existing.rawLine === row.rawLine)) rows.push(row);
    if (rows.length >= 500) break;
  }

  return {
    text,
    fields: { supplier, supplierIdentifier, invoiceNo, invoiceDate, currency },
    rows,
    reviewRequired: true,
    warning: "OCR output is an unapproved draft. Confirm supplier identifiers, invoice number/date/currency, product mapping, every quantity and price, batch number and expiry date against the original document before saving or approving."
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

async function recognizeImageBuffer(buffer, maxPixels) {
  const { createCanvas, loadImage } = require("@napi-rs/canvas");
  const image = await loadImage(buffer);
  if (!image.width || !image.height) throw new Error("The uploaded image has invalid dimensions.");
  const pixels = image.width * image.height;
  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) throw new Error("The uploaded image exceeds the safe OCR rendering size.");
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, image.width, image.height);
  const worker = await createOcrWorker();
  try {
    const result = await worker.recognize(canvas.toBuffer("image/png"));
    return normalizeText(result && result.data && result.data.text);
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
        const nativeText = normalizeText(items.map(item => item.str).join(" "));
        let pageText = nativeText.length >= 12 ? nativeText : "";
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
            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            const result = await worker.recognize(canvas.toBuffer("image/png"));
            pageText = normalizeText(result && result.data && result.data.text);
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

module.exports = { normalizeText, normalizeDate, parseInvoiceText, extractInvoice };
