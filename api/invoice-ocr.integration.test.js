const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
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

async function makeRotatedInvoiceImage() {
  const image = await loadImage(makeInvoiceImage());
  const canvas = createCanvas(image.height, image.width);
  const context = canvas.getContext("2d");
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(Math.PI / 2);
  context.drawImage(image, -image.width / 2, -image.height / 2);
  return canvas.toBuffer("image/jpeg");
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

  test("rejects oversized PNG and JPEG dimensions before decoding", async () => {
    const pngPath = path.join(directory, "oversized.png");
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
    png.writeUInt32BE(5000, 16);
    png.writeUInt32BE(5000, 20);
    fs.writeFileSync(pngPath, png);
    await expect(extractInvoice(pngPath)).rejects.toThrow(/safe OCR rendering size/);

    const jpegPath = path.join(directory, "oversized.jpg");
    fs.writeFileSync(jpegPath, Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
      0x13, 0x88, 0x13, 0x88, 0x03, 0x01, 0x11, 0x00
    ]));
    await expect(extractInvoice(jpegPath)).rejects.toThrow(/safe OCR rendering size/);
  });

  test("rejects oversized WEBP dimensions before decoding", async () => {
    const imagePath = path.join(directory, "oversized.webp");
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.writeUInt32LE(22, 4);
    webp.write("WEBP", 8, "ascii");
    webp.write("VP8X", 12, "ascii");
    webp.writeUInt32LE(10, 16);
    webp.writeUIntLE(5000 - 1, 24, 3);
    webp.writeUIntLE(5000 - 1, 27, 3);
    fs.writeFileSync(imagePath, webp);
    await expect(extractInvoice(imagePath)).rejects.toThrow(/safe OCR rendering size/);
  });

  test("rejects WEBP files without a readable image dimension chunk", async () => {
    const imagePath = path.join(directory, "malformed.webp");
    const webp = Buffer.alloc(20);
    webp.write("RIFF", 0, "ascii");
    webp.writeUInt32LE(12, 4);
    webp.write("WEBP", 8, "ascii");
    webp.write("JUNK", 12, "ascii");
    webp.writeUInt32LE(0, 16);
    fs.writeFileSync(imagePath, webp);
    await expect(extractInvoice(imagePath)).rejects.toThrow(/invalid or unreadable dimensions/);
  });

  test("recognizes text from a local invoice image", async () => {
    const imagePath = path.join(directory, "invoice.jpg");
    fs.writeFileSync(imagePath, makeInvoiceImage());
    const result = await extractInvoice(imagePath);
    expect(result.reviewRequired).toBe(true);
    expect(result.text.toUpperCase()).toContain("INVOICE");
  });

  test("recognizes text from a local JPEG invoice image", async () => {
    const imagePath = path.join(directory, "invoice.jpeg");
    fs.writeFileSync(imagePath, makeInvoiceImage());
    const result = await extractInvoice(imagePath);
    expect(result.reviewRequired).toBe(true);
    expect(result.text.toUpperCase()).toContain("INVOICE");
  });

  test("corrects a 90-degree rotated distributor invoice image", async () => {
    const imagePath = path.join(directory, "rotated-invoice.jpg");
    fs.writeFileSync(imagePath, await makeRotatedInvoiceImage());
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
