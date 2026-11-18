const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeText, normalizeDate, parseInvoiceText, extractInvoice } = require("./invoice-ocr");

describe("invoice OCR text parsing", () => {
  test("captures explicitly labeled packing, bonus, discount and tax values separately", () => {
    const result = parseInvoiceText("Supplier\nProduct: Paracetamol 500mg; Pack: 10x10; Qty: 4; Purchase: 125; Bonus: 1; Discount: 5%; Gross: 500; Sales Tax: 2%; Tax Amount: 10; Net Amount: 485; Batch: B-01; Expiry: 12/2027");
    expect(result.rows[0]).toMatchObject({
      productName: "Paracetamol 500mg", paidQuantity: 4, bonusQuantity: 1, freeQuantity: 1,
      packing: "10x10", discountPercent: 5, grossAmount: 500, salesTaxPercent: 2,
      salesTaxAmount: 10, netAmount: 485, rawExpiry: "12/2027", needsReview: true
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
    expect(normalizeDate("2027-12")).toBe("2027-12-31");
    expect(normalizeDate("Dec 2027")).toBe("2027-12-31");
    const result = parseInvoiceText("Supplier\nProduct: Amoxicillin 250mg; Qty: 5; Purchase: 8.25; Sale: 12; Batch: B-20; Expiry: 12/2027");
    expect(result.rows[0].expiryDate).toBe("2027-12-31");
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

  test("does not invent missing supplier, invoice, currency or line values", () => {
    const result = parseInvoiceText("Supplier statement only");
    expect(result.fields.supplier).toBe("Supplier statement only");
    expect(result.fields.invoiceNo).toBe("");
    expect(result.fields.currency).toBe("");
    expect(result.rows).toEqual([]);
    expect(result.reviewRequired).toBe(true);
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
