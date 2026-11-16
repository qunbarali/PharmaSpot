const path = require("path");
const fs = require("fs");

const MAX_TEXT_CHARS = 200000;
const MAX_LINES = 5000;
const optionalRequire = name => { try { return require(name); } catch (_) { return null; } };

function normalizeText(value) {
  return String(value || "").replace(/\r/g, "\n").replace(/[\t\f\v]+/g, " ")
    .replace(/[ ]{2,}/g, " ").replace(/[ ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT_CHARS);
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

async function createOcrWorker() {
  const Tesseract = optionalRequire("tesseract.js");
  if (!Tesseract) throw new Error("OCR is unavailable. Install tesseract.js and restart PharmaSpot.");
  const dataPackage = path.dirname(require.resolve("@tesseract.js-data/eng/package.json"));
  return Tesseract.createWorker("eng", 1, { langPath: path.join(dataPackage, "4.0.0_best_int") });
}

async function extractScannedPdf(filePath) {
  let pdfDocument;
  let worker;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { createCanvas } = require("@napi-rs/canvas");
    const pdfjsBuildDir = path.dirname(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
    const { pathToFileURL } = require("node:url");
    const assetUrl = (...segments) => pathToFileURL(path.resolve(pdfjsBuildDir, "..", "..", ...segments) + path.sep).href;
    const bytes = new Uint8Array(fs.readFileSync(filePath));
    const loadingTask = pdfjs.getDocument({
      data: bytes,
      cMapUrl: assetUrl("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: assetUrl("standard_fonts"),
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false
    });
    pdfDocument = await loadingTask.promise;
    if (!pdfDocument.numPages || pdfDocument.numPages > 30) throw new Error("Scanned PDF must contain between 1 and 30 pages.");
    worker = await createOcrWorker();
    const pageTexts = [];
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const basePixels = Math.max(1, baseViewport.width * baseViewport.height);
      const scale = Math.min(2, Math.sqrt(12000000 / basePixels));
      const viewport = page.getViewport({ scale: Math.max(0.5, scale) });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      if (width * height > 12000000) throw new Error("A PDF page exceeds the safe OCR rendering size.");
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      await page.render({ canvasContext: context, viewport }).promise;
      const png = canvas.toBuffer("image/png");
      const result = await worker.recognize(png);
      const pageText = normalizeText(result && result.data && result.data.text);
      if (pageText) pageTexts.push("[Page " + pageNumber + "]\n" + pageText);
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
      if (pageTexts.join("\n").length > MAX_TEXT_CHARS) break;
    }
    const text = normalizeText(pageTexts.join("\n\n"));
    if (!text) throw new Error("No readable text was detected in the scanned PDF. Try a clearer scan or upload page images.");
    return text;
  } catch (error) {
    if (error && /between 1 and 30|safe OCR rendering size|No readable text/.test(error.message)) throw error;
    throw new Error("Scanned-PDF OCR could not start. Check the PDF renderer, canvas and English OCR dependencies: " + (error.message || "unknown error"));
  } finally {
    if (worker) await worker.terminate();
    if (pdfDocument) await pdfDocument.destroy();
  }
}

async function extractPdf(filePath) {
  const pdfParse = optionalRequire("pdf-parse");
  if (!pdfParse) throw new Error("PDF text extraction is unavailable. Install pdf-parse and restart PharmaSpot.");
  const stat = fs.statSync(filePath);
  if (stat.size > 20 * 1024 * 1024) throw new Error("PDF exceeds the 20 MB processing limit.");
  const buffer = fs.readFileSync(filePath);
  const parsed = await pdfParse(buffer, { max: 30 });
  const text = normalizeText(parsed.text);
  if (text.length >= 12) return text;
  return extractScannedPdf(filePath);
}
async function extractImage(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > 20 * 1024 * 1024) throw new Error("Image exceeds the 20 MB processing limit.");
  const { createCanvas, loadImage } = require("@napi-rs/canvas");
  const image = await loadImage(filePath);
  if (!image.width || !image.height) throw new Error("The uploaded image has invalid dimensions.");
  const pixels = image.width * image.height;
  const scale = Math.min(1, Math.sqrt(12000000 / pixels));
  const width = Math.max(1, Math.floor(image.width * scale));
  const height = Math.max(1, Math.floor(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
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
async function extractInvoice(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const text = ext === ".pdf" ? await extractPdf(filePath) : await extractImage(filePath);
  return parseInvoiceText(text);
}

module.exports = { normalizeText, parseInvoiceText, extractInvoice };
