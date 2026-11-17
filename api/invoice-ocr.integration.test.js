const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCanvas } = require("@napi-rs/canvas");
const { extractInvoice } = require("./invoice-ocr");

jest.setTimeout(120000);

function makeInvoiceImage(format = "image/jpeg") {
  const canvas = createCanvas(1800, 520);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111111";
  context.font = "bold 82px Arial";
  context.fillText("INVOICE NO INV-TEST-100", 70, 170);
  context.font = "bold 66px Arial";
  context.fillText("PARACETAMOL 500MG 10 12.50 125.00", 70, 330);
  return canvas.toBuffer(format);
}

function makeTextPdf() {
  const chunks = [];
  const offsets = [0];
  let cursor = 0;
  const append = value => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "binary");
    chunks.push(buffer);
    cursor += buffer.length;
  };
  append("%PDF-1.4\n");
  const object = (id, body) => {
    offsets[id] = cursor;
    append(id + " 0 obj\n");
    append(body);
    append("\nendobj\n");
  };
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
  const content = Buffer.from([
    "BT",
    "/F1 24 Tf",
    "50 740 Td (ABC DISTRIBUTORS) Tj",
    "0 -40 Td (Invoice No: INV-TEXT-01) Tj",
    "0 -40 Td (Invoice Date: 16-11-2026) Tj",
    "0 -40 Td (Currency: PKR) Tj",
    "0 -40 Td (Item Qty Purchase Sale Batch Expiry) Tj",
    "0 -40 Td (Paracetamol 500mg 10 12.50 15.00 BATCH-01 31-Dec-2027) Tj",
    "ET"
  ].join("\n"), "binary");
  offsets[4] = cursor;
  append("4 0 obj\n<< /Length " + content.length + " >>\nstream\n");
  append(content);
  append("\nendstream\nendobj\n");
  object(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const xrefOffset = cursor;
  append("xref\n0 6\n0000000000 65535 f \n");
  for (let id = 1; id <= 5; id += 1) append(String(offsets[id]).padStart(10, "0") + " 00000 n \n");
  append("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n");
  return Buffer.concat(chunks);
}

function makeScannedPdf(jpeg, width, height) {
  const chunks = [];
  const offsets = [0];
  let cursor = 0;
  const append = value => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "binary");
    chunks.push(buffer);
    cursor += buffer.length;
  };
  append("%PDF-1.4\n");
  const object = (id, body) => {
    offsets[id] = cursor;
    append(id + " 0 obj\n");
    append(body);
    append("\nendobj\n");
  };
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + width + " " + height + "] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>");
  offsets[4] = cursor;
  append("4 0 obj\n<< /Type /XObject /Subtype /Image /Width " + width + " /Height " + height + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpeg.length + " >>\nstream\n");
  append(jpeg);
  append("\nendstream\nendobj\n");
  const content = Buffer.from("q\n" + width + " 0 0 " + height + " 0 0 cm\n/Im0 Do\nQ\n", "binary");
  offsets[5] = cursor;
  append("5 0 obj\n<< /Length " + content.length + " >>\nstream\n");
  append(content);
  append("endstream\nendobj\n");
  const xrefOffset = cursor;
  append("xref\n0 6\n0000000000 65535 f \n");
  for (let id = 1; id <= 5; id += 1) append(String(offsets[id]).padStart(10, "0") + " 00000 n \n");
  append("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n");
  return Buffer.concat(chunks);
}

describe("offline invoice OCR integration", () => {
  let directory;
  beforeAll(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "pharmaspot-ocr-")); });
  afterAll(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

  test("recognizes text from a local invoice image", async () => {
    const imagePath = path.join(directory, "invoice.jpg");
    fs.writeFileSync(imagePath, makeInvoiceImage());
    const result = await extractInvoice(imagePath);
    expect(result.reviewRequired).toBe(true);
    expect(result.text.toUpperCase()).toContain("INVOICE");
  });

  test("recognizes text from a local PNG invoice image", async () => {
    const imagePath = path.join(directory, "invoice.png");
    fs.writeFileSync(imagePath, makeInvoiceImage("image/png"));
    const result = await extractInvoice(imagePath);
    expect(result.reviewRequired).toBe(true);
    expect(result.text.toUpperCase()).toContain("INVOICE");
  });

  test("extracts selectable text and invoice line fields from a native PDF", async () => {
    const pdfPath = path.join(directory, "text-invoice.pdf");
    fs.writeFileSync(pdfPath, makeTextPdf());
    const result = await extractInvoice(pdfPath);
    expect(result.fields.invoiceNo).toBe("INV-TEXT-01");
    expect(result.fields.invoiceDate).toBe("2026-11-16");
    expect(result.rows[0]).toMatchObject({
      productName: "Paracetamol 500mg",
      quantity: 10,
      purchasePrice: 12.5,
      salePrice: 15,
      batchNumber: "BATCH-01",
      expiryDate: "2027-12-31"
    });
  });

  test("renders and recognizes an image-only scanned PDF page", async () => {
    const pdfPath = path.join(directory, "scanned-invoice.pdf");
    fs.writeFileSync(pdfPath, makeScannedPdf(makeInvoiceImage(), 1800, 520));
    const result = await extractInvoice(pdfPath);
    expect(result.reviewRequired).toBe(true);
    expect(result.text.toUpperCase()).toContain("INVOICE");
  });
});
