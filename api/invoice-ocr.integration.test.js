const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCanvas } = require("@napi-rs/canvas");
const { extractInvoice } = require("./invoice-ocr");

jest.setTimeout(120000);

function makeInvoiceImage() {
  const canvas = createCanvas(1800, 520);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111111";
  context.font = "bold 82px Arial";
  context.fillText("INVOICE NO INV-TEST-100", 70, 170);
  context.font = "bold 66px Arial";
  context.fillText("PARACETAMOL 500MG 10 12.50 125.00", 70, 330);
  return canvas.toBuffer("image/jpeg");
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

  test("renders and recognizes an image-only scanned PDF page", async () => {
    const pdfPath = path.join(directory, "scanned-invoice.pdf");
    fs.writeFileSync(pdfPath, makeScannedPdf(makeInvoiceImage(), 1800, 520));
    const result = await extractInvoice(pdfPath);
    expect(result.reviewRequired).toBe(true);
    expect(result.text.toUpperCase()).toContain("INVOICE");
  });
});
