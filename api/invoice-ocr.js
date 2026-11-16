const path = require("path");
const fs = require("fs");

const MAX_TEXT_CHARS = 200000;
const MAX_LINES = 5000;
const optionalRequire = name => { try { return require(name); } catch (_) { return null; } };

function normalizeText(value) {
  return String(value || "").replace(/\r/g, "\n").replace(/[\t\f\v]+/g, " ")
    .replace(/[ ]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT_CHARS);
}
function parseInvoiceText(raw) {
  const text = normalizeText(raw);
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean).slice(0, MAX_LINES);
  const first = pattern => {
    const match = text.match(pattern);
    return match ? String(match[1] || "").trim().slice(0, 120) : "";
  };
  const invoiceNo = first(/(?:invoice|bill|inv)\s*(?:no|number|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{2,})/i);
  const invoiceDate = first(/(?:invoice\s*date|date)\s*[:#-]?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i);
  const currency = /\bUSD\b|\$/i.test(text) ? "USD" : /\bINR\b|₹/i.test(text) ? "INR" : /\bPKR\b|\bRs\.?\b/i.test(text) ? "PKR" : "";
  const rows = [];
  for (const line of lines) {
    const m = line.match(/^(.{2,80}?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d{1,4})?)\s+(\d+(?:\.\d{1,4})?)\s*$/);
    if (m) rows.push({ description: m[1].slice(0, 80), quantity: Number(m[2]), unitPrice: Number(m[3]), lineTotal: Number(m[4]), confidence: "low", needsReview: true });
  }
  return { text, fields: { invoiceNo, invoiceDate, currency }, rows, reviewRequired: true,
    warning: "OCR is a draft only. Verify supplier, invoice number, every quantity, price, batch and expiry date before posting." };
}

async function extractPdf(filePath) {
  const pdfParse = optionalRequire("pdf-parse");
  if (!pdfParse) throw new Error("PDF text extraction is unavailable. Install the optional pdf-parse dependency and restart PharmaSpot.");
  const stat = fs.statSync(filePath);
  if (stat.size > 20 * 1024 * 1024) throw new Error("PDF exceeds the 20 MB processing limit.");
  const parsed = await pdfParse(fs.readFileSync(filePath), { max: 30 });
  return normalizeText(parsed.text);
}
async function extractImage(filePath) {
  const Tesseract = optionalRequire("tesseract.js");
  if (!Tesseract) throw new Error("Image OCR is unavailable. Install the optional tesseract.js dependency and restart PharmaSpot.");
  const stat = fs.statSync(filePath);
  if (stat.size > 20 * 1024 * 1024) throw new Error("Image exceeds the 20 MB processing limit.");
  const dataPackage = path.dirname(require.resolve("@tesseract.js-data/eng/package.json"));
  const worker = await Tesseract.createWorker("eng", 1, { langPath: path.join(dataPackage, "4.0.0_best_int") });
  try {
    const result = await worker.recognize(filePath);
    return normalizeText(result && result.data && result.data.text);
  } finally {
    await worker.terminate();
  }
}
async function extractInvoice(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const text = ext === ".pdf" ? await extractPdf(filePath) : await extractImage(filePath);
  return parseInvoiceText(text);
}

module.exports = { normalizeText, parseInvoiceText, extractInvoice };
