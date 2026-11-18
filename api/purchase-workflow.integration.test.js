const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");

jest.setTimeout(30000);

let server;
let port;
let inventoryDB;
let importsAPI;
let supplierLedger;
let audit;
let adminToken;
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

beforeAll(async () => {
  const appDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pharmaspot-workflow-"));
  process.env.APPDATA = appDataRoot;
  process.env.APPNAME = "workflow-test";
  const appRoot = path.join(appDataRoot, process.env.APPNAME);
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

  const firstDraft = await request("POST", "/imports/commit-purchase", makePurchase("INV-001"));
  expect(firstDraft.status).toBe(201);
  expect(firstDraft.data.status).toBe("pending_approval");
  const duplicatePendingDraft = await request("POST", "/imports/commit-purchase", makePurchase("INV-001"));
  expect(duplicatePendingDraft.status).toBe(409);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(10);

  const pending = await request("GET", "/imports/pending-purchases");
  expect(pending.status).toBe(200);
  expect(pending.data.some(draft => draft._id === firstDraft.data.draftId)).toBe(true);

  const firstApproval = await request("POST", "/imports/approve-purchase/" + encodeURIComponent(firstDraft.data.draftId), { confirm: true });
  expect(firstApproval.status).toBe(200);
  expect(firstApproval.data.success).toBe(true);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(17);

  let history = await request("GET", "/imports/history");
  let firstImport = history.data.find(record => record.invoiceNo === "INV-001" && record.status === "posted");
  expect(firstImport).toBeDefined();
  expect(firstImport).toMatchObject({ supplierIdentifier: "SUP-007", invoiceDate: "2026-11-15", exchangeRateDate: "2026-11-16", currency: "PKR", baseCurrency: "PKR", exchangeRate: 1 });
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
  const secondApproval = await request("POST", "/imports/approve-purchase/" + encodeURIComponent(secondDraft.data.draftId), { confirm: true });
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
    exchangeRateDate: "2026-11-16",
    items: [{ productId, sourceDescription: "Bonus quantity test", quantity: 4, bonusQuantity: 2,
      purchasePrice: 5, salePrice: 7, batchNumber: "BONUS-BATCH", expiryDate: "2031-12-31" }]
  });
  expect(bonusDraft.status).toBe(201);
  const bonusApproval = await request("POST", "/imports/approve-purchase/" + encodeURIComponent(bonusDraft.data.draftId), { confirm: true });
  expect(bonusApproval.status).toBe(200);
  const bonusProduct = await findOne(inventoryDB, { _id: productId });
  expect(bonusProduct.quantity).toBe(16);
  const bonusHistory = await request("GET", "/imports/history");
  const bonusImport = bonusHistory.data.find(record => record.invoiceNo === "INV-BONUS" && record.status === "posted");
  expect(bonusImport.items[0]).toMatchObject({ quantity: 6, paidQuantity: 4, bonusQuantity: 2 });
  const bonusLedgerEvent = await supplierLedger.getLedgerEvent("purchase:" + bonusImport._id);
  expect(bonusLedgerEvent.amount).toBe(20);
  const bonusReversal = await request("POST", "/imports/reverse-purchase/" + encodeURIComponent(bonusImport._id), {
    confirm: true, reason: "Integration test: reverse bonus quantity purchase"
  });
  expect(bonusReversal.status).toBe(200);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(10);

  const payment = await request("POST", "/supplier-ledger/payment", {
    supplier: "Demo Distributor", amount: 100, currency: "PKR", reference: "PAY-001"
  });
  expect(payment.status).toBe(201);
  expect(payment.data.success).toBe(true);

  const auditResponse = await request("GET", "/supplier-ledger/audit");
  expect(auditResponse.status).toBe(200);
  const actions = auditResponse.data.map(event => event.action);
  expect(actions).toEqual(expect.arrayContaining([
    "purchase_draft_created",
    "purchase_approved_and_posted",
    "purchase_reversed",
    "supplier_payment_recorded",
    "stock_reconciliation_posted"
  ]));

  const reconciliationHistory = await request("GET", "/supplier-ledger/reconcile/history");
  expect(reconciliationHistory.status).toBe(200);
  expect(reconciliationHistory.data.some(record => record._id === reconciliation.data.reconciliationId)).toBe(true);
});
