const { normalizeText, parseInvoiceText } = require("./invoice-ocr");

describe("invoice OCR text parsing", () => {
  test("normalizes OCR whitespace and bounds output", () => {
    expect(normalizeText("  ABC  \r\n\r\n\r\n  123  ")).toBe("ABC\n\n 123");
    expect(normalizeText("x".repeat(250000))).toHaveLength(200000);
  });

  test("extracts invoice metadata without treating it as approved data", () => {
    const result = parseInvoiceText("ABC DISTRIBUTORS\nInvoice No: INV-2026/0042\nDate: 16-11-2026\nCurrency: PKR\nParacetamol 500mg 10 12.50 125.00");
    expect(result.fields.invoiceNo).toBe("INV-2026/0042");
    expect(result.fields.invoiceDate).toBe("16-11-2026");
    expect(result.fields.currency).toBe("PKR");
    expect(result.reviewRequired).toBe(true);
    expect(result.rows[0]).toMatchObject({ description: "Paracetamol 500mg", quantity: 10, unitPrice: 12.5, lineTotal: 125, needsReview: true });
  });

  test("does not invent missing invoice values", () => {
    const result = parseInvoiceText("Supplier statement only");
    expect(result.fields.invoiceNo).toBe("");
    expect(result.fields.currency).toBe("");
    expect(result.rows).toEqual([]);
    expect(result.reviewRequired).toBe(true);
  });
});
