const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const archiver = require("archiver");

jest.setTimeout(30000);

let server;
let port;
let inventoryDB;
let importsAPI;
let supplierLedger;
let audit;
let adminToken;
let importRoot;
const productId = 918273645;

function insert(db, document) {
  return new Promise((resolve, reject) => db.insert(document, (error, saved) => error ? reject(error) : resolve(saved)));
}
function findOne(db, query) {
  return new Promise((resolve, reject) => db.findOne(query, (error, doc) => error ? reject(error) : resolve(doc)));
}
function update(db, query, change) {
  return new Promise((resolve, reject) => db.update(query, change, {}, (error, count) => error ? reject(error) : resolve(count)));
}
function request(method, route, body, token = adminToken) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = {};
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = payload.length;
  }
  if (token) headers.Authorization = "Bearer " + token;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method, path: route, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch (_) {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function createZipBuffer(entries) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 0 } });
    const chunks = [];
    archive.on("data", chunk => chunks.push(chunk));
    archive.once("error", reject);
    archive.once("end", () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) archive.append(entry.content, { name: entry.name });
    try { archive.finalize(); } catch (error) { reject(error); }
  });
}

function uploadRequest(filename, content, token = adminToken) {
  const boundary = "----PharmaSpotIntegrationBoundary";
  const payload = Buffer.concat([
    Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"files\"; filename=\"" + filename + "\"\r\nContent-Type: application/octet-stream\r\n\r\n"),
    content,
    Buffer.from("\r\n--" + boundary + "--\r\n")
  ]);
  const headers = {
    "Content-Type": "multipart/form-data; boundary=" + boundary,
    "Content-Length": payload.length
  };
  if (token) headers.Authorization = "Bearer " + token;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method: "POST", path: "/imports/upload", headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch (_) {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  const appDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pharmaspot-workflow-"));
  process.env.APPDATA = appDataRoot;
  process.env.APPNAME = "workflow-test";
  const appRoot = path.join(appDataRoot, process.env.APPNAME);
  importRoot = path.join(appRoot, "uploads", "imports");
  fs.mkdirSync(path.join(appRoot, "server", "databases"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "uploads"), { recursive: true });

  jest.resetModules();
  inventoryDB = require("./inventory").inventoryDB;
  importsAPI = require("./imports");
  supplierLedger = require("./supplier-ledger");
  audit = require("./audit");

  const app = express();
  app.use(express.json());
  app.use("/imports", importsAPI);
  app.use("/supplier-ledger", supplierLedger.app);
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  port = server.address().port;

  await insert(audit.usersDB, {
    _id: 1,
    username: "workflow-admin",
    fullname: "Workflow Administrator",
    perm_users: 1,
    status: "Logged In_workflow-test"
  });
  adminToken = (await audit.issueSession(1)).token;

  await insert(inventoryDB, {
    _id: productId,
    name: "Integration Test Medicine",
    quantity: 10,
    price: "3",
    purchasePrice: "2",
    supplier: "Opening Supplier",
    expirationDate: "2030-01-01",
    batches: [{
      importLineId: "opening-batch",
      batchNumber: "OPENING",
      expiryDate: "2030-01-01",
      quantity: 10,
      purchasePrice: 2,
      salePrice: 3
    }]
  });
});

afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test("purchase approval, controlled reversal, supplier payment, reconciliation and audit work end to end", async () => {
  expect(importsAPI.isSafeArchiveEntryPath("supplier/invoice-page-1.jpg")).toBe(true);
  expect(importsAPI.isSafeArchiveEntryPath("../../outside.jpg")).toBe(false);
  expect(importsAPI.isSafeArchiveEntryPath("C:\\Windows\\outside.jpg")).toBe(false);
  expect(importsAPI.isSafeArchiveEntryPath("\\\\server\\share\\outside.jpg")).toBe(false);
  expect(importsAPI.isSafeArchiveEntryPath("/etc/passwd")).toBe(false);
  expect((await request("POST", "/imports/upload", {}, null)).status).toBe(401);
  expect((await request("POST", "/imports/ocr/not-a-file.pdf", undefined, null)).status).toBe(401);
  expect((await request("POST", "/imports/assign-image", { productId, storedName: "not-a-file.jpg" }, null)).status).toBe(401);
  const malformedUpload = await uploadRequest("invoice.pdf", Buffer.from("not a PDF"));
  expect(malformedUpload.status).toBe(400);
  const malformedArchive = await uploadRequest("invoice.zip", Buffer.from("not a ZIP"));
  expect(malformedArchive.status).toBe(400);
  expect(fs.readdirSync(importRoot)).toHaveLength(0);

  const pdfFixture = Buffer.from("%PDF-1.4\\nZIP invoice fixture\\n");
  const pdfArchive = await createZipBuffer([{ name: "supplier/invoice-page-1.pdf", content: pdfFixture }]);
  const pdfArchiveUpload = await uploadRequest("supplier-invoices.zip", pdfArchive);
  expect(pdfArchiveUpload.status).toBe(200);
  expect(pdfArchiveUpload.data.invoiceReviewRequired).toBe(true);
  const uploadedArchive = pdfArchiveUpload.data.files.find(file => file.type === ".zip");
  expect(uploadedArchive.extractedDocuments).toEqual([
    expect.objectContaining({
      originalName: "invoice-page-1.pdf", type: ".pdf", storedName: expect.any(String),
      size: pdfFixture.length, sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
  ]);
  const extractedPdf = uploadedArchive.extractedDocuments[0];
  expect(fs.readFileSync(path.join(importRoot, extractedPdf.storedName)).subarray(0, 5).toString()).toBe("%PDF-");

  const invalidPdfArchive = await createZipBuffer([{ name: "supplier/broken.pdf", content: Buffer.from("not a PDF") }]);
  expect((await uploadRequest("broken-invoice.zip", invalidPdfArchive)).status).toBe(400);

  const beforeArchiveLimit = fs.readdirSync(importRoot).length;
  const oversizedDocumentCountArchive = await createZipBuffer(Array.from({ length: 201 }, (_, index) => ({
    name: "documents/invoice-" + index + ".pdf", content: pdfFixture
  })));
  expect((await uploadRequest("too-many-invoices.zip", oversizedDocumentCountArchive)).status).toBe(400);
  expect(fs.readdirSync(importRoot)).toHaveLength(beforeArchiveLimit);

  const deniedDraft = await request("POST", "/imports/commit-purchase", {
    supplier: "Demo Distributor", invoiceNo: "DENIED", currency: "PKR", items: []
  }, null);
  expect(deniedDraft.status).toBe(403);
  expect((await request("GET", "/imports/pending-purchases", undefined, null)).status).toBe(403);
  expect((await request("GET", "/supplier-ledger/audit", undefined, null)).status).toBe(403);

  const makePurchase = (invoiceNo, options = {}) => ({
    supplier: "Demo Distributor",
    supplierIdentifier: "SUP-007",
    invoiceNo,
    invoiceDate: options.invoiceDate || "2026-11-15",
    currency: options.currency || "PKR",
    baseCurrency: options.baseCurrency || "PKR",
    exchangeRate: options.exchangeRate ?? 1,
    exchangeRateDate: options.exchangeRateDate || "2026-11-16",
    items: [{
      productId,
      sourceDescription: "Integration Test Medicine 500mg",
      quantity: invoiceNo === "INV-001" ? 5 : 2,
      bonusQuantity: invoiceNo === "INV-001" ? 2 : 0,
      purchasePrice: 4,
      salePrice: 6,
      batchNumber: invoiceNo === "INV-001" ? "BATCH-001" : "BATCH-002",
      expiryDate: "2030-12-31"
    }]
  });

  const zipSourceDraft = await request("POST", "/imports/commit-purchase", {
    ...makePurchase("INV-ZIP-SOURCE"), sourceFiles: [uploadedArchive]
  });
  expect(zipSourceDraft.status).toBe(201);
  const zipPendingDrafts = await request("GET", "/imports/pending-purchases");
  const savedZipDraft = zipPendingDrafts.data.find(draft => draft._id === zipSourceDraft.data.draftId);
  expect(savedZipDraft.sourceFiles).toHaveLength(2);
  expect(savedZipDraft.sourceFiles.map(file => file.sha256)).toContain(extractedPdf.sha256);
  const retainedExtractedPdf = await request("GET", "/imports/file/" + encodeURIComponent(extractedPdf.storedName));
  expect(retainedExtractedPdf.status).toBe(200);
  expect(String(retainedExtractedPdf.data)).toContain("%PDF-1.4");

  const standaloneInvoiceUpload = await uploadRequest("invoice-page-1.pdf", pdfFixture);
  expect(standaloneInvoiceUpload.status).toBe(200);
  const standaloneInvoiceFile = standaloneInvoiceUpload.data.files[0];
  const duplicateExtractedSource = await request("POST", "/imports/commit-purchase", {
    ...makePurchase("INV-ZIP-SOURCE-DUP"), sourceFiles: [standaloneInvoiceFile]
  });
  expect(duplicateExtractedSource.status).toBe(409);
  expect(duplicateExtractedSource.data.error).toMatch(/original invoice files has already been used/i);

  const sourceFileName = "11111111-1111-4111-8111-111111111111.pdf";
  fs.writeFileSync(path.join(importRoot, sourceFileName), Buffer.from("%PDF-1.4\\nsource invoice fixture\\n"));
  const sourceFiles = [{ originalName: "supplier-invoice.pdf", storedName: sourceFileName }];
  const firstDraft = await request("POST", "/imports/commit-purchase", {
    ...makePurchase("INV-001"), sourceFiles
  });
  expect(firstDraft.status).toBe(201);
  expect(firstDraft.data.status).toBe("pending_approval");
  expect(firstDraft.data.revision).toBe(0);
  expect((await request("GET", "/imports/file/" + sourceFileName, undefined, null)).status).toBe(403);
  const originalInvoiceDownload = await request("GET", "/imports/file/" + sourceFileName);
  expect(originalInvoiceDownload.status).toBe(200);
  expect(String(originalInvoiceDownload.data)).toContain("%PDF-1.4");
  const duplicatePendingDraft = await request("POST", "/imports/commit-purchase", makePurchase("INV-001"));
  expect(duplicatePendingDraft.status).toBe(409);
  const duplicateSourceFile = await request("POST", "/imports/commit-purchase", {
    ...makePurchase("INV-SAME-FILE"), sourceFiles
  });
  expect(duplicateSourceFile.status).toBe(409);
  expect(duplicateSourceFile.data.error).toMatch(/original invoice files has already been used/i);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(10);

  const pending = await request("GET", "/imports/pending-purchases");
  expect(pending.status).toBe(200);
  expect(pending.data.some(draft => draft._id === firstDraft.data.draftId)).toBe(true);

  const firstApproval = await request("POST", "/imports/approve-purchase/" + encodeURIComponent(firstDraft.data.draftId), { confirm: true, reviewed: true, reviewedRevision: 0 });
  expect(firstApproval.status).toBe(200);
  expect(firstApproval.data.success).toBe(true);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(17);

  let history = await request("GET", "/imports/history");
  let firstImport = history.data.find(record => record.invoiceNo === "INV-001" && record.status === "posted");
  expect(firstImport).toBeDefined();
  expect(firstImport).toMatchObject({ supplierIdentifier: "SUP-007", invoiceDate: "2026-11-15", exchangeRateDate: "2026-11-16", currency: "PKR", baseCurrency: "PKR", exchangeRate: 1 });
  expect(firstImport.sourceFiles[0]).toMatchObject({ originalName: "supplier-invoice.pdf", type: ".pdf" });
  expect(firstImport.sourceFiles[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(firstImport.items[0]).toMatchObject({ quantity: 7, paidQuantity: 5, bonusQuantity: 2 });
  expect((await findOne(inventoryDB, { _id: productId })).batches.find(batch => batch.importLineId === firstImport.items[0].importLineId).quantity).toBe(7);
  expect(await supplierLedger.getLedgerEvent("purchase:" + firstImport._id)).toMatchObject({ amount: 20 });

  const firstReversal = await request("POST", "/imports/reverse-purchase/" + encodeURIComponent(firstImport._id), {
    confirm: true, reason: "Integration test: supplier invoice correction"
  });
  expect(firstReversal.status).toBe(200);
  expect(firstReversal.data.success).toBe(true);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(10);
  expect(await supplierLedger.getLedgerEvent("purchase-reversal:" + firstImport._id)).toBeDefined();
  const duplicateReversedInvoice = await request("POST", "/imports/commit-purchase", makePurchase("INV-001"));
  expect(duplicateReversedInvoice.status).toBe(409);

  const secondDraft = await request("POST", "/imports/commit-purchase", makePurchase("INV-002", {
    currency: "INR", baseCurrency: "PKR", exchangeRate: 3.75,
    invoiceDate: "2026-11-15", exchangeRateDate: "2026-11-16"
  }));
  expect(secondDraft.status).toBe(201);
  const secondApproval = await request("POST", "/imports/approve-purchase/" + encodeURIComponent(secondDraft.data.draftId), { confirm: true, reviewed: true, reviewedRevision: 0 });
  expect(secondApproval.status).toBe(200);
  history = await request("GET", "/imports/history");
  const secondImport = history.data.find(record => record.invoiceNo === "INV-002" && record.status === "posted");
  expect(secondImport).toBeDefined();
  expect(secondImport).toMatchObject({
    currency: "INR", baseCurrency: "PKR", exchangeRate: 3.75,
    invoiceDate: "2026-11-15", exchangeRateDate: "2026-11-16",
    supplierIdentifier: "SUP-007"
  });
  const beforeSale = await findOne(inventoryDB, { _id: productId });
  const importedBatch = beforeSale.batches.find(batch => batch.importLineId === secondImport.items[0].importLineId);
  expect(importedBatch).toMatchObject({
    purchasePrice: 4, salePrice: 6, currency: "INR", baseCurrency: "PKR",
    exchangeRate: 3.75, exchangeRateDate: "2026-11-16",
    basePurchasePrice: 15, baseSalePrice: 22.5,
    invoiceDate: "2026-11-15",
    sourceDescription: "Integration Test Medicine 500mg"
  });
  const soldBatch = beforeSale.batches.map(batch => batch.importLineId === secondImport.items[0].importLineId ? { ...batch, quantity: 1 } : batch);
  await update(inventoryDB, { _id: productId }, { $set: { quantity: 11, batches: soldBatch } });

  const blockedReversal = await request("POST", "/imports/reverse-purchase/" + encodeURIComponent(secondImport._id), {
    confirm: true, reason: "This must be blocked after batch stock has been sold"
  });
  expect(blockedReversal.status).toBe(409);
  expect(blockedReversal.data.rolledBack).toBe(true);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(11);

  const currentProduct = await findOne(inventoryDB, { _id: productId });
  const reconciliationItems = [{
    productId,
    systemQuantity: currentProduct.quantity,
    untrackedSystemQuantity: 0,
    untrackedCount: 0,
    batchCounts: currentProduct.batches.map((batch, batchIndex) => ({
      batchIndex,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      systemQuantity: batch.quantity,
      countedQuantity: batch.batchNumber === "OPENING" ? 9 : batch.quantity
    }))
  }];
  const preview = await request("POST", "/supplier-ledger/reconcile/preview", { items: reconciliationItems });
  expect(preview.status).toBe(200);
  expect(preview.data.preview[0].countedQuantity).toBe(10);

  const reconciliation = await request("POST", "/supplier-ledger/reconcile/commit", { confirm: true, items: reconciliationItems });
  expect(reconciliation.status).toBe(200);
  expect(reconciliation.data.success).toBe(true);
  const reconciledProduct = await findOne(inventoryDB, { _id: productId });
  expect(reconciledProduct.quantity).toBe(10);
  expect(reconciledProduct.batches[0].quantity).toBe(9);

  const bonusDraft = await request("POST", "/imports/commit-purchase", {
    supplier: "Demo Distributor", supplierIdentifier: "SUP-007", invoiceNo: "INV-BONUS",
    invoiceDate: "2026-11-16", currency: "PKR", baseCurrency: "PKR", exchangeRate: 1,
    exchangeRateDate: "2026-11-16", invoiceTotal: 19.5,
    items: [{ productId, sourceDescription: "Bonus quantity test", quantity: 4, bonusQuantity: 2,
      purchasePrice: 5, salePrice: 7, grossAmount: 20, discountAmount: 2, netAmount: 18, lineTotal: 18,
      batchNumber: "BONUS-BATCH", expiryDate: "2031-12-31" }]
  });
  expect(bonusDraft.status).toBe(201);
  const bonusApproval = await request("POST", "/imports/approve-purchase/" + encodeURIComponent(bonusDraft.data.draftId), { confirm: true, reviewed: true, reviewedRevision: 0 });
  expect(bonusApproval.status).toBe(200);
  expect(bonusApproval.data.invoiceTotal).toBe(19.5);
  const bonusProduct = await findOne(inventoryDB, { _id: productId });
  expect(bonusProduct.quantity).toBe(16);
  const bonusHistory = await request("GET", "/imports/history");
  const bonusImport = bonusHistory.data.find(record => record.invoiceNo === "INV-BONUS" && record.status === "posted");
  expect(bonusImport).toMatchObject({ invoiceTotal: 19.5 });
  expect(bonusImport.items[0]).toMatchObject({ quantity: 6, paidQuantity: 4, bonusQuantity: 2, grossAmount: 20, discountAmount: 2, netAmount: 18, lineTotal: 18 });
  const bonusLedgerEvent = await supplierLedger.getLedgerEvent("purchase:" + bonusImport._id);
  expect(bonusLedgerEvent.amount).toBe(19.5);
  const bonusReversal = await request("POST", "/imports/reverse-purchase/" + encodeURIComponent(bonusImport._id), {
    confirm: true, reason: "Integration test: reverse bonus quantity purchase"
  });
  expect(bonusReversal.status).toBe(200);
  expect((await supplierLedger.getLedgerEvent("purchase-reversal:" + bonusImport._id)).amount).toBe(19.5);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(10);

  const editableSourceName = "22222222-2222-4222-8222-222222222222.pdf";
  fs.writeFileSync(path.join(importRoot, editableSourceName), Buffer.from("%PDF-1.4\\neditable source invoice\\n"));
  const editableDraft = await request("POST", "/imports/commit-purchase", {
    supplier: "Demo Distributor", supplierIdentifier: "SUP-OLD", invoiceNo: "INV-EDIT-01",
    invoiceDate: "2026-11-17", currency: "INR", baseCurrency: "PKR", exchangeRate: 3.75,
    exchangeRateDate: "2026-11-17",
    sourceFiles: [{ originalName: "editable-invoice.pdf", storedName: editableSourceName }],
    items: [{ productId, sourceDescription: "Uncorrected OCR description", quantity: 2, bonusQuantity: 0,
      purchasePrice: 5, salePrice: 7, batchNumber: "OLD-BATCH", expiryDate: "2031-12-31" }]
  });
  expect(editableDraft.status).toBe(201);
  const noReviewApproval = await request("POST", "/imports/approve-purchase/" + encodeURIComponent(editableDraft.data.draftId), { confirm: true });
  expect(noReviewApproval.status).toBe(400);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(10);

  const invalidDraftUpdate = await request("POST", "/imports/update-purchase-draft/" + encodeURIComponent(editableDraft.data.draftId), {
    supplier: "Demo Distributor", supplierIdentifier: "SUP-008", invoiceNo: "INV-EDIT-01",
    invoiceDate: "2026-11-19", currency: "INR", exchangeRate: 4,
    exchangeRateDate: "2026-11-20", expectedRevision: 0,
    items: [{ productId, quantity: 3, bonusQuantity: 1, purchasePrice: 8, salePrice: 10,
      batchNumber: "EDITED-BATCH", expiryDate: "31-Feb-2032" }]
  });
  expect(invalidDraftUpdate.status).toBe(400);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(10);

  const duplicateDraftUpdate = await request("POST", "/imports/update-purchase-draft/" + encodeURIComponent(editableDraft.data.draftId), {
    supplier: "Demo Distributor", invoiceNo: "INV-001", currency: "INR", exchangeRate: 4,
    exchangeRateDate: "2026-11-20", expectedRevision: 0,
    items: [{ productId, quantity: 3, bonusQuantity: 1, purchasePrice: 8, salePrice: 10,
      batchNumber: "EDITED-BATCH", expiryDate: "2032-01-31" }]
  });
  expect(duplicateDraftUpdate.status).toBe(409);

  const correctedDraft = await request("POST", "/imports/update-purchase-draft/" + encodeURIComponent(editableDraft.data.draftId), {
    supplier: "Demo Distributor", supplierIdentifier: "SUP-008", invoiceNo: "INV-EDIT-01",
    invoiceDate: "2026-11-19", currency: "INR", baseCurrency: "USD",
    exchangeRate: 4, exchangeRateDate: "2026-11-20", expectedRevision: 0, invoiceTotal: 22.5,
    sourceFiles: [],
    items: [{ productId, sourceDescription: "Corrected Paracetamol 500mg",
      quantity: 3, bonusQuantity: 1, purchasePrice: 8, salePrice: 10,
      itemCode: "008", packing: "10s", grossAmount: 24, discountAmount: 2,
      salesTaxAmount: 0.44, additionalTaxAmount: 0, netAmount: 22.44, lineTotal: 22.44,
      batchNumber: "EDITED-BATCH", expiryDate: "2032-01-31" }]
  });
  expect(correctedDraft.status).toBe(200);
  const pendingAfterCorrection = await request("GET", "/imports/pending-purchases");
  const correctedPending = pendingAfterCorrection.data.find(draft => draft._id === editableDraft.data.draftId);
  expect(correctedPending).toMatchObject({
    invoiceTotal: 22.5, supplierIdentifier: "SUP-008", invoiceNo: "INV-EDIT-01", currency: "INR",
    baseCurrency: "PKR", exchangeRate: 4, exchangeRateDate: "2026-11-20", revision: 1
  });
  expect(correctedPending.sourceFiles[0]).toMatchObject({ originalName: "editable-invoice.pdf", type: ".pdf" });
  expect(correctedPending.items[0]).toMatchObject({
    sourceDescription: "Corrected Paracetamol 500mg", quantity: 3, paidQuantity: 3,
    bonusQuantity: 1, purchasePrice: 8, salePrice: 10,
    itemCode: "008", packing: "10s", grossAmount: 24, discountAmount: 2,
    salesTaxAmount: 0.44, additionalTaxAmount: 0, netAmount: 22.44, lineTotal: 22.44,
    batchNumber: "EDITED-BATCH", expiryDate: "2032-01-31"
  });
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(10);

  const staleDraftEdit = await request("POST", "/imports/update-purchase-draft/" + encodeURIComponent(editableDraft.data.draftId), {
    supplier: "Demo Distributor", supplierIdentifier: "SUP-009", invoiceNo: "INV-EDIT-01",
    invoiceDate: "2026-11-19", currency: "INR", exchangeRate: 4,
    exchangeRateDate: "2026-11-20", expectedRevision: 0,
    items: [{ productId, quantity: 5, bonusQuantity: 0, purchasePrice: 8, salePrice: 10,
      batchNumber: "STALE-BATCH", expiryDate: "2032-01-31" }]
  });
  expect(staleDraftEdit.status).toBe(409);

  const staleRevisionApproval = await request("POST", "/imports/approve-purchase/" + encodeURIComponent(editableDraft.data.draftId), {
    confirm: true, reviewed: true, reviewedRevision: 0
  });
  expect(staleRevisionApproval.status).toBe(409);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(10);

  const correctedApproval = await request("POST", "/imports/approve-purchase/" + encodeURIComponent(editableDraft.data.draftId), { confirm: true, reviewed: true, reviewedRevision: 1 });
  expect(correctedApproval.status).toBe(200);
  const correctedHistory = await request("GET", "/imports/history");
  const correctedImport = correctedHistory.data.find(record => record.invoiceNo === "INV-EDIT-01" && record.status === "posted");
  expect(correctedImport).toBeDefined();
  expect(correctedImport).toMatchObject({ invoiceTotal: 22.5 });
  expect(correctedImport).toMatchObject({
    supplierIdentifier: "SUP-008", currency: "INR", baseCurrency: "PKR",
    exchangeRate: 4, exchangeRateDate: "2026-11-20"
  });
  expect(correctedImport.sourceFiles[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  const correctedProduct = await findOne(inventoryDB, { _id: productId });
  const correctedBatch = correctedProduct.batches.find(batch => batch.importLineId === correctedImport.items[0].importLineId);
  expect(correctedBatch).toMatchObject({
    quantity: 4, paidQuantity: 3, bonusQuantity: 1,
    purchasePrice: 8, salePrice: 10, basePurchasePrice: 32, baseSalePrice: 40,
    currency: "INR", baseCurrency: "PKR", exchangeRate: 4, exchangeRateDate: "2026-11-20"
  });
  expect(correctedImport.items[0]).toMatchObject({ itemCode: "008", packing: "10s", grossAmount: 24, discountAmount: 2, salesTaxAmount: 0.44, netAmount: 22.44, lineTotal: 22.44 });
  expect(correctedBatch).toMatchObject({ itemCode: "008", packing: "10s", grossAmount: 24, discountAmount: 2, salesTaxAmount: 0.44, netAmount: 22.44, invoiceLineTotal: 22.44 });
  expect(await supplierLedger.getLedgerEvent("purchase:" + correctedImport._id)).toMatchObject({ amount: 22.5, currency: "INR" });
  const editAfterApproval = await request("POST", "/imports/update-purchase-draft/" + encodeURIComponent(editableDraft.data.draftId), {
    supplier: "Demo Distributor", invoiceNo: "INV-EDIT-01", currency: "INR", exchangeRate: 4,
    exchangeRateDate: "2026-11-20", items: []
  });
  expect(editAfterApproval.status).toBe(404);
  const correctedReversal = await request("POST", "/imports/reverse-purchase/" + encodeURIComponent(correctedImport._id), {
    confirm: true, reason: "Integration test: reverse corrected editable draft"
  });
  expect(correctedReversal.status).toBe(200);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(10);

  const usdDraft = await request("POST", "/imports/commit-purchase", {
    supplier: "Demo Distributor", supplierIdentifier: "SUP-007", invoiceNo: "INV-USD-003",
    invoiceDate: "2026-11-17", currency: "USD", baseCurrency: "PKR", exchangeRate: 280,
    exchangeRateDate: "2026-11-18",
    items: [{ productId, sourceDescription: "USD invoice conversion test", quantity: 2, bonusQuantity: 1,
      purchasePrice: 4.5, salePrice: 6.5, batchNumber: "USD-BATCH-003", expiryDate: "2032-12-31" }]
  });
  expect(usdDraft.status).toBe(201);
  const usdApproval = await request("POST", "/imports/approve-purchase/" + encodeURIComponent(usdDraft.data.draftId), { confirm: true, reviewed: true, reviewedRevision: 0 });
  expect(usdApproval.status).toBe(200);
  const usdHistory = await request("GET", "/imports/history");
  const usdImport = usdHistory.data.find(record => record.invoiceNo === "INV-USD-003" && record.status === "posted");
  expect(usdImport).toBeDefined();
  expect(usdImport).toMatchObject({ currency: "USD", baseCurrency: "PKR", exchangeRate: 280, exchangeRateDate: "2026-11-18" });
  const usdProduct = await findOne(inventoryDB, { _id: productId });
  const usdBatch = usdProduct.batches.find(batch => batch.importLineId === usdImport.items[0].importLineId);
  expect(usdBatch).toMatchObject({
    quantity: 3, paidQuantity: 2, bonusQuantity: 1,
    purchasePrice: 4.5, salePrice: 6.5,
    basePurchasePrice: 1260, baseSalePrice: 1820,
    currency: "USD", baseCurrency: "PKR", exchangeRate: 280,
    exchangeRateDate: "2026-11-18"
  });
  expect(await supplierLedger.getLedgerEvent("purchase:" + usdImport._id)).toMatchObject({ amount: 9, currency: "USD" });
  const usdReversal = await request("POST", "/imports/reverse-purchase/" + encodeURIComponent(usdImport._id), {
    confirm: true, reason: "Integration test: reverse USD invoice conversion"
  });
  expect(usdReversal.status).toBe(200);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(10);
  expect(await supplierLedger.getLedgerEvent("purchase-reversal:" + usdImport._id)).toMatchObject({ amount: 9, currency: "USD" });

  const payment = await request("POST", "/supplier-ledger/payment", {
    supplier: "Demo Distributor", amount: 100, currency: "PKR", reference: "PAY-001"
  });
  expect(payment.status).toBe(201);
  expect(payment.data.success).toBe(true);

  const auditResponse = await request("GET", "/supplier-ledger/audit");
  expect(auditResponse.status).toBe(200);
  const draftAudit = auditResponse.data.find(event => event.action === "purchase_draft_created" && event.entityId === firstDraft.data.draftId);
  expect(draftAudit.details.sourceFiles[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  const actions = auditResponse.data.map(event => event.action);
  expect(actions).toEqual(expect.arrayContaining([
    "purchase_draft_created",
    "purchase_draft_updated",
    "purchase_approved_and_posted",
    "purchase_reversed",
    "supplier_payment_recorded",
    "stock_reconciliation_posted"
  ]));

  const reconciliationHistory = await request("GET", "/supplier-ledger/reconcile/history");
  expect(reconciliationHistory.status).toBe(200);
  expect(reconciliationHistory.data.some(record => record._id === reconciliation.data.reconciliationId)).toBe(true);
});
