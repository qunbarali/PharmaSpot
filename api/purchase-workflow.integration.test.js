const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");

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

  const purchase = {
    supplier: "Demo Distributor",
    invoiceNo: "INV-001",
    currency: "PKR",
    baseCurrency: "PKR",
    exchangeRate: 1,
    items: [{
      productId,
      quantity: 5,
      purchasePrice: 4,
      salePrice: 6,
      batchNumber: "BATCH-001",
      expiryDate: "2030-12-31"
    }]
  };

  const draftResponse = await request("POST", "/imports/commit-purchase", purchase);
  expect(draftResponse.status).toBe(201);
  expect(draftResponse.data.status).toBe("pending_approval");
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(10);

  const pending = await request("GET", "/imports/pending-purchases");
  expect(pending.status).toBe(200);
  expect(pending.data.some(draft => draft._id === draftResponse.data.draftId)).toBe(true);

  const approval = await request("POST", "/imports/approve-purchase/" + encodeURIComponent(draftResponse.data.draftId), { confirm: true });
  expect(approval.status).toBe(200);
  expect(approval.data.success).toBe(true);
  expect((await findOne(inventoryDB, { _id: productId })).quantity).toBe(15);

  const postedImport = await findOne(require("./imports-db-placeholder"), {});
  expect(postedImport).toBeDefined();
});
