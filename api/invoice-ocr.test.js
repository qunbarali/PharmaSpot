const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeText, normalizeDate, parseInvoiceText, hasStructuredInvoiceText, textItemsToLines, ocrWordsToLines, scoreOcrResult, summarizeExtraction, extractInvoice } = require("./invoice-ocr");

function createTextPdf(lines) {
  const escapePdfText = value => String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const commands = [
    "BT",
    "/F1 10 Tf",
    "40 760 Td",
    ...lines.map((line, index) => (index ? "0 -14 Td " : "") + "(" + escapePdfText(line) + ") Tj"),
    "ET"
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + Buffer.byteLength(commands, "ascii") + " >>\nstream\n" + commands + "\nendstream"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += (index + 1) + " 0 obj\n" + objects[index] + "\nendobj\n";
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, "0") + " 00000 n \n";
  pdf += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF";
  return Buffer.from(pdf, "ascii");
}
describe("invoice OCR text parsing", () => {
  test("captures explicitly labeled packing, bonus, discount and tax values separately", () => {
    const result = parseInvoiceText("Supplier\nProduct: Paracetamol 500mg; Pack: 10x10; Qty: 4; Purchase: 125; Bonus: 1; Discount: 5%; Gross: 500; Sales Tax: 2%; Tax Amount: 10; Net Amount: 485; Batch: B-01; Expiry: 12/2027");
    expect(result.rows[0]).toMatchObject({
      productName: "Paracetamol 500mg", paidQuantity: 4, bonusQuantity: 1, freeQuantity: 1,
      packing: "10x10", discountPercent: 5, grossAmount: 500, salesTaxPercent: 2,
      salesTaxAmount: 10, netAmount: 485, lineTotal: 485, rawExpiry: "12/2027", needsReview: true
    });
  });

  test("marks missing sale price, batch and expiry for human review", () => {
    const result = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Supplier ID: SUP-01",
      "Invoice No: INV-REVIEW-001",
      "Invoice Date: 23-11-2026",
      "Currency: PKR",
      "Item | Qty | TP | MRP | Batch No | Expiry Date",
      "Paracetamol 500mg | 10 | 12.50 | | |"
    ].join("\n"));

    expect(result.reviewSummary).toMatchObject({
      missingInvoiceFields: [],
      rowsNeedingReview: 1,
      totalRows: 1
    });
    expect(result.rows[0].reviewFlags).toEqual(["sale price", "batch number", "valid expiry date"]);
    expect(result.rows[0].fieldConfidence).toMatchObject({
      productName: "medium", quantity: "medium", purchasePrice: "medium",
      salePrice: "none", batchNumber: "none", expiryDate: "none"
    });
    expect(result.fieldConfidence).toMatchObject({
      supplier: "medium", invoiceNo: "medium", invoiceDate: "medium", currency: "medium"
    });
  });

  test("does not flag complete supplier and batch fields as missing", () => {
    const result = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Supplier ID: SUP-01",
      "Invoice No: INV-REVIEW-002",
      "Invoice Date: 23-11-2026",
      "Currency: PKR",
      "Item | Qty | TP | MRP | Batch No | Expiry Date",
      "Paracetamol 500mg | 10 | 12.50 | 20.00 | B-01 | 12/2027"
    ].join("\n"));

    expect(result.reviewSummary).toMatchObject({
      missingInvoiceFields: [],
      rowsNeedingReview: 0,
      totalRows: 1
    });
    expect(result.rows[0].reviewFlags).toEqual([]);
    expect(result.rows[0].fieldConfidence).toMatchObject({
      productName: "medium", quantity: "medium", purchasePrice: "medium",
      salePrice: "medium", batchNumber: "medium", expiryDate: "medium"
    });
  });

  test("treats a supplier tax identifier as optional metadata, not a posting blocker", () => {
    const result = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Invoice No: INV-OPTIONAL-ID",
      "Invoice Date: 23-11-2026",
      "Currency: PKR",
      "Item | Qty | TP | MRP | Batch No | Expiry Date",
      "Paracetamol 500mg | 10 | 12.50 | 20.00 | B-01 | 12/2027"
    ].join("\n"));

    expect(result.reviewSummary.missingInvoiceFields).toEqual([]);
    expect(result.reviewSummary.optionalInvoiceFields).toContain("supplier identifier (NTN/GST or distributor code)");
  });

  test("recognizes common distributor free-quantity labels", () => {
    const bonus = parseInvoiceText("Supplier\nProduct: Cetirizine 10mg; Qty: 10; Purchase: 3; Bonus Qty: 2; Batch: C-10; Expiry: 11/2028");
    const foc = parseInvoiceText("Supplier\nProduct: Vitamin C; Qty: 6; Purchase: 4; FOC: 1; Batch: V-01; Expiry: 10/2028");
    expect(bonus.rows[0]).toMatchObject({ paidQuantity: 10, bonusQuantity: 2, freeQuantity: 2 });
    expect(foc.rows[0]).toMatchObject({ paidQuantity: 6, bonusQuantity: 1, freeQuantity: 1 });
  });

  test("maps table columns including paid quantity, FOC quantity, rate, MRP, batch and expiry", () => {
    const result = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Invoice No: INV-TABLE-100",
      "Item Code | Description | Qty | Bonus Qty | TP | MRP | Batch No | Expiry Date",
      "P-001 | Paracetamol 500mg | 10 | 2 | 12.50 | 20 | B-01 | 12/2027"
    ].join("\n"));
    expect(result.rows[0]).toMatchObject({
      productName: "Paracetamol 500mg",
      quantity: 10, paidQuantity: 10, bonusQuantity: 2, freeQuantity: 2,
      purchasePrice: 12.5, salePrice: 20, batchNumber: "B-01", expiryDate: "2027-12-31"
    });
  });

  test("recognizes dotted Pakistani T.P. and M.R.P. invoice columns", () => {
    const result = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Invoice No: INV-DOTTED-TP-01",
      "Item Code | Product Name | Stock Qty | BNS | T.P. (Rs.) | M.R.P. (Incl. GST) | Batch No. | Exp. Date",
      "001 | Paracetamol 500mg | 12 | 2 | 14.25 | 20.00 | P-21 | 11/2028"
    ].join("\n"));
    expect(result.rows[0]).toMatchObject({
      itemCode: "001", productName: "Paracetamol 500mg", quantity: 12,
      bonusQuantity: 2, purchasePrice: 14.25, salePrice: 20,
      batchNumber: "P-21", expiryDate: "2028-11-30"
    });
  });

  test("parses Pakistan distributor stock, BNS, packing and tax columns safely", () => {
    const result = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Invoice No: INV-PAK-002",
      "Code | Description | Packing | Batch No | Exp Date | Stock | BNS | Rate | Gross | Disc % | Disc + Extra Amt | Sale Tax | Fur. Tax | AWH Tax | Net Amount",
      "009 | Cetirizine 10mg | 10s | C-88 | 07/28 | 50 | 2 | 127.50 | 6375.00 | 0 | 0 | 31.88 | 0 | 0 | 6406.88"
    ].join("\n"));
    expect(result.rows[0]).toMatchObject({
      itemCode: "009", productName: "Cetirizine 10mg", packing: "10s",
      quantity: 50, paidQuantity: 50, bonusQuantity: 2,
      purchasePrice: 127.5, salePrice: null,
      batchNumber: "C-88", rawExpiry: "07/28", expiryDate: "2028-07-31",
      grossAmount: 6375, discountPercent: 0, discountAmount: 0,
      salesTaxAmount: 31.88, additionalTaxAmount: 0,
      netAmount: 6406.88, lineTotal: 6406.88, needsReview: true
    });
  });

  test("keeps decimal purchase and sale prices while parsing trailing batch and expiry columns", () => {
    const result = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Invoice No: INV-LOOSE-01",
      "Item Qty Purchase Sale Batch Expiry",
      "Paracetamol 500mg 10 12.50 15.00 BATCH-01 31-Dec-2027"
    ].join("\n"));

    expect(result.rows[0]).toMatchObject({
      productName: "Paracetamol 500mg",
      quantity: 10,
      purchasePrice: 12.5,
      salePrice: 15,
      batchNumber: "BATCH-01",
      rawExpiry: "31-Dec-2027",
      expiryDate: "2027-12-31"
    });
    expect(hasStructuredInvoiceText(result.text)).toBe(true);

    const dottedExpiry = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Item Qty Purchase Sale Batch Expiry",
      "Paracetamol 500mg 10 12.50 15.00 BATCH-01 12.2027"
    ].join("\n"));
    expect(dottedExpiry.rows[0]).toMatchObject({
      purchasePrice: 12.5, salePrice: 15, rawExpiry: "12.2027", expiryDate: "2027-12-31"
    });
  });

  test("preserves PDF text-column gaps as table separators", () => {
    const items = [
      { str: "Item", transform: [10, 0, 0, 10, 10, 100], width: 18 },
      { str: "Qty", transform: [10, 0, 0, 10, 150, 100], width: 15 },
      { str: "Bonus", transform: [10, 0, 0, 10, 230, 100], width: 30 },
      { str: "Paracetamol", transform: [10, 0, 0, 10, 10, 80], width: 60 },
      { str: "500mg", transform: [10, 0, 0, 10, 75, 80], width: 30 },
      { str: "10", transform: [10, 0, 0, 10, 150, 80], width: 12 },
      { str: "2", transform: [10, 0, 0, 10, 230, 80], width: 8 }
    ];
    expect(textItemsToLines(items)).toBe("Item | Qty | Bonus\nParacetamol 500mg | 10 | 2");
  });

  test("reconstructs scanned OCR word columns from word bounding boxes", () => {
    const words = [
      ["Item", 10, 48, 10, 30], ["Qty", 200, 228, 10, 30], ["Bonus", 300, 350, 10, 30],
      ["Paracetamol", 10, 145, 50, 70], ["500mg", 151, 190, 50, 70],
      ["10", 250, 270, 50, 70], ["2", 350, 362, 50, 70]
    ].map(([text, x0, x1, y0, y1]) => ({ text, bbox: { x0, x1, y0, y1 } }));
    expect(ocrWordsToLines({ data: { text: "fallback", words } })).toBe("Item | Qty | Bonus\nParacetamol 500mg | 10 | 2");
  });

  test("uses native PDF text only when it contains structured invoice rows", () => {
    const invoicePage = [
      "ABC DISTRIBUTORS",
      "Invoice No: INV-100",
      "Item Qty Purchase Sale Batch Expiry",
      "Paracetamol 500mg 10 12.50 15.00 BATCH-01 31-Dec-2027"
    ].join("\n");
    const metadataOnlyPage = [
      "ABC DISTRIBUTORS",
      "Invoice No: INV-100",
      "Invoice Date: 16-11-2026",
      "Currency: PKR",
      "Tax Invoice Original Copy"
    ].join("\n");

    expect(hasStructuredInvoiceText(invoicePage)).toBe(true);
    expect(hasStructuredInvoiceText(metadataOnlyPage)).toBe(false);
    expect(hasStructuredInvoiceText(invoicePage, true)).toBe(false);
  });

  test("separates moderately spaced scanned table columns and parses the resulting row", () => {
    const words = [
      ["Description", 10, 80], ["Qty", 160, 185], ["Rate", 210, 240], ["Batch", 275, 315], ["Expiry", 355, 405],
      ["Paracetamol", 10, 95], ["500mg", 99, 130], ["10", 160, 175], ["12.50", 215, 250], ["B-01", 280, 310], ["12/2027", 360, 415]
    ].map(([text, x0, x1], index) => ({
      text,
      bbox: { x0, x1, y0: index < 5 ? 10 : 40, y1: index < 5 ? 30 : 60 }
    }));
    const lines = ocrWordsToLines({ data: { words } });
    expect(lines).toContain("Description | Qty | Rate | Batch | Expiry");
    const parsed = parseInvoiceText("ABC DISTRIBUTORS\n" + lines);
    expect(parsed.rows[0]).toMatchObject({
      productName: "Paracetamol 500mg", quantity: 10, purchasePrice: 12.5, batchNumber: "B-01", expiryDate: "2027-12-31"
    });
  });

  test("recognizes the Expy expiry heading used on distributor invoices", () => {
    const result = parseInvoiceText([
      "CRESCENT DISTRIBUTORS",
      "Item Code | Description | Packing | Batch Number | Expy | Qty | Bon | Rate | Gross Amount | Total Amount",
      "350 | SILVORA TAB 100MG | 10,T | 26L024 | 10/28 | 2 | 0 | 114.00 | 228.00 | 228.00"
    ].join("\n"));
    expect(result.rows[0]).toMatchObject({
      itemCode: "350", packing: "10,T", batchNumber: "26L024", rawExpiry: "10/28", expiryDate: "2028-10-31"
    });
  });

  test("recognizes abbreviated Adv Tax columns", () => {
    const result = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Item | Description | Qty | Rate | Batch | Expiry | Adv Tax",
      "1 | Cetirizine 10mg | 5 | 12.50 | B-01 | 12/2027 | 0.50"
    ].join("\n"));
    expect(result.rows[0]).toMatchObject({ productName: "Cetirizine 10mg", additionalTaxAmount: 0.5 });
  });

  test("joins wrapped product descriptions to numeric invoice columns without merging adjacent rows", () => {
    const result = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Item | Description | Qty | Purchase | Sale | Batch | Expiry",
      "Paracetamol 500mg",
      "10 12.50 15.00 BATCH-01 12/2027",
      "Amoxicillin 250mg 5 8.25 12.00 B-20 11/2028"
    ].join("\n"));

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      productName: "Paracetamol 500mg", quantity: 10,
      purchasePrice: 12.5, salePrice: 15,
      batchNumber: "BATCH-01", expiryDate: "2027-12-31"
    });
    expect(result.rows[1]).toMatchObject({
      productName: "Amoxicillin 250mg", quantity: 5,
      purchasePrice: 8.25, salePrice: 12,
      batchNumber: "B-20", expiryDate: "2028-11-30"
    });
  });

  test("attaches a separate batch and expiry continuation to its invoice row", () => {
    const result = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Item Qty Purchase Sale Batch Expiry",
      "Paracetamol 500mg 10 12.50 15.00",
      "Batch: BATCH-01 Expiry: 12/2027"
    ].join("\n"));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      productName: "Paracetamol 500mg", quantity: 10,
      purchasePrice: 12.5, salePrice: 15,
      batchNumber: "BATCH-01", rawExpiry: "12/2027",
      expiryDate: "2027-12-31"
    });
  });

  test("does not attach invoice total dates as batch expiry continuations", () => {
    const result = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Item Qty Purchase Sale Batch Expiry",
      "Paracetamol 500mg 10 12.50 15.00",
      "Grand Total: 12/2027"
    ].join("\n"));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].batchNumber).toBe("");
    expect(result.rows[0].expiryDate).toBe("");
    expect(result.fields.invoiceTotal).toBeNull();
  });

  test("reports measured Tesseract page confidence separately from parser confidence", () => {
    const scored = scoreOcrResult({
      data: {
        text: "ABC DISTRIBUTORS INV 123",
        confidence: 91.4,
        words: [
          { text: "ABC", confidence: 40, bbox: { x0: 0, x1: 20, y0: 0, y1: 10 } },
          { text: "DISTRIBUTORS", confidence: 40, bbox: { x0: 25, x1: 90, y0: 0, y1: 10 } }
        ]
      }
    });
    expect(scored).toMatchObject({ confidence: 91.4, confidenceSource: "page", wordCount: 2 });
    expect(parseInvoiceText("ABC DISTRIBUTORS\nInvoice No: INV-123").fieldConfidence.supplier).toBe("medium");
  });

  test("falls back to mean word confidence when Tesseract page confidence is unavailable", () => {
    const scored = scoreOcrResult({
      data: {
        words: [
          { text: "ABC", confidence: 80, bbox: { x0: 0, x1: 20, y0: 0, y1: 10 } },
          { text: "123", confidence: 60, bbox: { x0: 25, x1: 40, y0: 0, y1: 10 } }
        ]
      }
    });
    expect(scored).toMatchObject({ confidence: 70, confidenceSource: "words", wordCount: 2 });
  });

  test("summarizes OCR confidence by word count across scanned PDF pages", () => {
    expect(summarizeExtraction({
      kind: "pdf", pageCount: 3, nativeTextPages: 1,
      ocrResults: [
        { confidence: 90, confidenceSource: "page", wordCount: 2 },
        { confidence: 60, confidenceSource: "words", wordCount: 1 }
      ]
    })).toMatchObject({
      kind: "pdf", pageCount: 3, nativeTextPages: 1, ocrPages: 2,
      ocrWordCount: 3, ocrConfidence: 80, ocrConfidenceBand: "medium",
      ocrConfidenceSource: "page+words"
    });
  });

  test("marks native-text PDFs separately from pages requiring OCR", () => {
    expect(summarizeExtraction({ kind: "pdf", pageCount: 2, nativeTextPages: 2 })).toMatchObject({
      kind: "pdf", pageCount: 2, nativeTextPages: 2, ocrPages: 0,
      ocrConfidence: null, ocrConfidenceBand: null, ocrConfidenceSource: "unavailable"
    });
  });

  test("normalizes OCR whitespace and bounds output", () => {
    expect(normalizeText("  ABC  \r\n\r\n\r\n  123  ")).toBe("ABC\n\n 123");
    expect(normalizeText("x".repeat(250000))).toHaveLength(200000);
  });

  test("normalizes common invoice and expiry dates without guessing invalid dates", () => {
    expect(normalizeDate("16-11-2026")).toBe("2026-11-16");
    expect(normalizeDate("31-Dec-2027")).toBe("2027-12-31");
    expect(normalizeDate("2026/11/16")).toBe("2026-11-16");
    expect(normalizeDate("31-02-2027")).toBe("");
  });

  test("normalizes month/year expiry dates to the final calendar day", () => {
    expect(normalizeDate("12/2027")).toBe("2027-12-31");
    expect(normalizeDate("07/28")).toBe("2028-07-31");
    expect(normalizeDate("2027-12")).toBe("2027-12-31");
    expect(normalizeDate("Dec 2027")).toBe("2027-12-31");
    const result = parseInvoiceText("Supplier\nProduct: Amoxicillin 250mg; Qty: 5; Purchase: 8.25; Sale: 12; Batch: B-20; Expiry: 12/2027");
    expect(result.rows[0].expiryDate).toBe("2027-12-31");
  });

  test("extracts labeled invoice payable totals without confusing line net amounts", () => {
    const grandTotal = parseInvoiceText([
      "Supplier Name: Crescent Distributors",
      "Invoice No: CR-104",
      "Currency: PKR",
      "Item | Description | Qty | Rate | Net Amount",
      "1 | Paracetamol 500mg | 2 | 10 | 20",
      "Grand Total: 1,234.50"
    ].join("\n"));
    expect(grandTotal.fields.invoiceTotal).toBe(1234.5);
    const lineOnly = parseInvoiceText([
      "Supplier Name: Crescent Distributors",
      "Item | Description | Qty | Rate | Net Amount",
      "1 | Paracetamol 500mg | 2 | 10 | 20"
    ].join("\n"));
    expect(lineOnly.fields.invoiceTotal).toBeNull();

    const netPayable = parseInvoiceText([
      "Supplier Name: Ahsan Traders",
      "Invoice No: AH-22",
      "Net Payable PKR 485.75"
    ].join("\n"));
    expect(netPayable.fields.invoiceTotal).toBe(485.75);

    const rupeeTotal = parseInvoiceText("Supplier Name: SDK Health Care\nInvoice No: SDK-9\nNet Payable: Rs. 2,050.00");
    expect(rupeeTotal.fields.invoiceTotal).toBe(2050);
  });

  test("extracts supplier identifiers and editable product, price, batch and expiry fields", () => {
    const result = parseInvoiceText([
      "ABC PHARMA DISTRIBUTORS",
      "Supplier Code: SUP-007",
      "Invoice No: INV-2026/0042",
      "Invoice Date: 16-11-2026",
      "Currency: PKR",
      "Item Qty Purchase Price Sale Price Batch Expiry",
      "Paracetamol 500mg 10 12.50 15.00 BATCH-01 31-Dec-2027"
    ].join("\n"));

    expect(result.fields).toMatchObject({
      supplier: "ABC PHARMA DISTRIBUTORS",
      supplierIdentifier: "SUP-007",
      invoiceNo: "INV-2026/0042",
      invoiceDate: "2026-11-16",
      currency: "PKR"
    });
    expect(result.rows[0]).toMatchObject({
      description: "Paracetamol 500mg",
      productName: "Paracetamol 500mg",
      quantity: 10,
      purchasePrice: 12.5,
      salePrice: 15,
      batchNumber: "BATCH-01",
      expiryDate: "2027-12-31",
      needsReview: true
    });
    expect(result.reviewRequired).toBe(true);
  });

  test("prefers explicit supplier-name and invoice-currency labels and accepts short invoice numbers", () => {
    const result = parseInvoiceText([
      "Supplier Name: Ahsan Traders",
      "Supplier No: 12",
      "Invoice No: 07",
      "Invoice Date: 18-11-2026",
      "Currency: PKR",
      "Exchange rate reference: USD/PKR 3.75"
    ].join("\n"));

    expect(result.fields).toMatchObject({
      supplier: "Ahsan Traders",
      supplierIdentifier: "12",
      invoiceNo: "07",
      invoiceDate: "2026-11-18",
      currency: "PKR"
    });
  });

  test("extracts distributor NTN/GST identifiers and Inv. # invoice labels", () => {
    const result = parseInvoiceText([
      "Ahsan Traders - Sadiqabad",
      "Inv. # SOB-0019883",
      "Invoice Date: 05/02/2026",
      "NTN No: 5400033-6",
      "GST No: 3277786338881",
      "Currency: PKR"
    ].join("\n"));

    expect(result.fields).toMatchObject({
      supplier: "Ahsan Traders - Sadiqabad",
      invoiceNo: "SOB-0019883",
      invoiceDate: "2026-02-05",
      supplierIdentifier: "5400033-6",
      currency: "PKR"
    });
  });

  test("keeps line totals distinct from sale prices when the invoice header says amount", () => {
    const result = parseInvoiceText([
      "Demo Supplier",
      "Invoice No: BILL-1001",
      "Item Qty Purchase Sale Amount Batch Expiry",
      "Amoxicillin 250mg 5 8.25 12.00 41.25 B-20 31-12-2027"
    ].join("\n"));
    expect(result.rows[0]).toMatchObject({
      quantity: 5,
      purchasePrice: 8.25,
      salePrice: 12,
      lineTotal: 41.25,
      batchNumber: "B-20",
      expiryDate: "2027-12-31"
    });
  });

  test("supports labelled rows and preserves missing values as blank", () => {
    const labelled = parseInvoiceText("Product: Amoxicillin 250mg; Qty: 5; Purchase: 8.25; Sale: 12.00; Batch: B-20; Expiry: 31-12-2027");
    expect(labelled.rows[0]).toMatchObject({
      productName: "Amoxicillin 250mg",
      quantity: 5,
      purchasePrice: 8.25,
      salePrice: 12,
      batchNumber: "B-20",
      expiryDate: "2027-12-31"
    });

    const incomplete = parseInvoiceText("ABC DISTRIBUTORS\nInvoice No: INV-001\nParacetamol 500mg 10 12.50 125.00");
    expect(incomplete.rows[0]).toMatchObject({
      quantity: 10,
      purchasePrice: 12.5,
      lineTotal: 125,
      salePrice: null,
      batchNumber: "",
      expiryDate: ""
    });
  });

  test("does not mistake an expiry-date column for the invoice date", () => {
    const result = parseInvoiceText([
      "ABC DISTRIBUTORS",
      "Invoice No: INV-EXPIRY-01",
      "Item | Qty | Purchase | Batch | Expiry Date",
      "Paracetamol 500mg | 5 | 8.25 | B-20 | 12/2027"
    ].join("\n"));
    expect(result.fields.invoiceDate).toBe("");
    expect(result.rows[0].expiryDate).toBe("2027-12-31");
  });

  test("does not invent missing supplier, invoice, currency or line values", () => {
    const result = parseInvoiceText("Supplier statement only");
    expect(result.fields.supplier).toBe("Supplier statement only");
    expect(result.fields.invoiceNo).toBe("");
    expect(result.fields.currency).toBe("");
    expect(result.rows).toEqual([]);
    expect(result.reviewRequired).toBe(true);
  });

  test("extracts searchable supplier invoice text from a real PDF file", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pharmaspot-ocr-pdf-"));
    try {
      const pdfPath = path.join(directory, "supplier-invoice.pdf");
      fs.writeFileSync(pdfPath, createTextPdf([
        "ABC DISTRIBUTORS",
        "Supplier Code: SUP-001",
        "Invoice No: INV-PDF-100",
        "Invoice Date: 2026-11-10",
        "Currency: PKR",
        "Item | Description | Qty | Purchase Price | Sale Price | Batch No | Expiry Date",
        "P-001 | Paracetamol 500mg | 10 | 12.50 | 20.00 | B-01 | 12/2027"
      ]));
      const result = await extractInvoice(pdfPath);
      expect(result.fields).toMatchObject({
        supplier: "ABC DISTRIBUTORS",
        supplierIdentifier: "SUP-001",
        invoiceNo: "INV-PDF-100",
        invoiceDate: "2026-11-10",
        currency: "PKR"
      });
      expect(result.rows[0]).toMatchObject({
        productName: "Paracetamol 500mg",
        quantity: 10,
        purchasePrice: 12.5,
        salePrice: 20,
        batchNumber: "B-01",
        expiryDate: "2027-12-31",
        needsReview: true
      });
      expect(result.reviewRequired).toBe(true);
      expect(result.extraction).toMatchObject({
        kind: "pdf", pageCount: 1, nativeTextPages: 1, ocrPages: 0,
        ocrConfidence: null
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects unsupported and malformed document files before OCR", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pharmaspot-ocr-invalid-"));
    try {
      const textPath = path.join(directory, "invoice.txt");
      fs.writeFileSync(textPath, "not an invoice image");
      await expect(extractInvoice(textPath)).rejects.toThrow(/Unsupported invoice file/);

      const pdfPath = path.join(directory, "invoice.pdf");
      fs.writeFileSync(pdfPath, "not a PDF");
      await expect(extractInvoice(pdfPath)).rejects.toThrow(/invalid file signature/);

      const pngPath = path.join(directory, "invoice.png");
      fs.writeFileSync(pngPath, "not a PNG");
      await expect(extractInvoice(pngPath)).rejects.toThrow(/invalid file signature/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
