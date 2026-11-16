const express = require("express");
const Datastore = require("@seald-io/nedb");
const path = require("path");
const { writeAudit, auditDB, authorizeAdmin } = require("./audit");
const { currencies, money, summarizeLedger } = require("./ledger-utils");

const app = express();
const appData = process.env.APPDATA;
const appName = process.env.APPNAME;
const inventoryDB = require("./inventory").inventoryDB;
const dbDir = path.join(appData, appName, "server", "databases");
const supplierDB = new Datastore({ filename: path.join(dbDir, "suppliers.db"), autoload: true });
const ledgerDB = new Datastore({ filename: path.join(dbDir, "supplier-ledger.db"), autoload: true });
const reconciliationDB = new Datastore({ filename: path.join(dbDir, "stock-reconciliation.db"), autoload: true });

supplierDB.ensureIndex({ fieldName: "normalizedName", unique: true });
ledgerDB.ensureIndex({ fieldName: "eventKey", unique: true, sparse: true });
reconciliationDB.ensureIndex({ fieldName: "reconciliationKey", unique: true, sparse: true });

const call = (db, method, ...args) => new Promise((resolve, reject) => {
  db[method](...args, (err, result, extra) => err ? reject(err) : resolve({ result, extra }));
});
const clean = value => String(value == null ? "" : value).trim().slice(0, 160);
const money = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("Amounts must be finite non-negative numbers.");
  return Number(n.toFixed(2));
};
const localOnly = (req, res, next) => {
  const remote = String(req.socket && req.socket.remoteAddress || "");
  if (!(remote === "::1" || remote === "127.0.0.1" || remote.startsWith("::ffff:127."))) {
    return res.status(403).json({ error: "Supplier accounting is available only on the main PharmaSpot computer." });
  }
  next();
};
app.use(localOnly);
app.use(express.json({ limit: "1mb" }));

async function getSupplier(name, create) {
  const normalizedName = clean(name).toLowerCase();
  if (!normalizedName) throw new Error("A distributor name is required.");
  let { result } = await call(supplierDB, "findOne", { normalizedName });
  if (!result && create) {
    const inserted = await call(supplierDB, "insert", {
      name: clean(name), normalizedName, openingBalance: 0, createdAt: new Date().toISOString()
    });
    result = inserted.result;
  }
  return result;
}
async function recordLedger({ supplier, type, currency, amount, reference, importId, note, eventKey }) {
  if (!currencies.has(currency)) throw new Error("Unsupported currency.");
  const entry = {
    eventKey, supplierId: supplier._id, supplier: supplier.name, type, currency,
    amount: money(amount), reference: clean(reference), importId: importId || null,
    note: clean(note), createdAt: new Date().toISOString()
  };
  await call(ledgerDB, "insert", entry);
  return entry;
}

app.get("/suppliers", async (_req, res) => {
  try {
    const { result: suppliers } = await call(supplierDB, "find", {});
    const { result: entries } = await call(ledgerDB, "find", {});
    const result = suppliers.map(s => {
      const ledger = entries.filter(e => e.supplierId === s._id);
      const currenciesSummary = summarizeLedger(ledger);
      return { id: s._id, name: s.name, balances: currenciesSummary };
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: "Could not load distributor accounts." }); }
});

app.post("/suppliers", async (req, res) => {
  try {
    const supplier = await getSupplier(req.body && req.body.name, true);
    res.status(201).json({ id: supplier._id, name: supplier.name });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/payment", async (req, res) => {
  try {
    const admin = await authorizeAdmin(req);
    if (!admin) return res.status(403).json({ error: "An active administrator account is required to record supplier payments." });
    const supplier = await getSupplier(req.body && req.body.supplier, true);
    const currency = String(req.body.currency || "PKR").toUpperCase();
    const amount = money(req.body.amount);
    if (amount <= 0) throw new Error("Payment amount must be greater than zero.");
    const payment = await recordLedger({
      supplier, type: "payment", currency, amount,
      reference: req.body.reference, note: req.body.note,
      eventKey: "payment:" + require("crypto").randomUUID()
    });
    await writeAudit(req, "supplier_payment_recorded", "supplier", supplier._id, { currency, amount, reference: payment.reference, ledgerEvent: payment.eventKey });
    res.status(201).json({ success: true, payment });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/ledger/:supplier", async (req, res) => {
  try {
    const supplier = await getSupplier(req.params.supplier, false);
    if (!supplier) return res.status(404).json({ error: "Distributor not found." });
    const { result } = await call(ledgerDB, "find", { supplierId: supplier._id });
    result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json(result);
  } catch (e) { res.status(400).json({ error: "Could not load distributor ledger." }); }
});

app.get("/expiry", async (req, res) => {
  try {
    const days = Math.max(0, Math.min(365, Number(req.query.days == null ? 90 : req.query.days)));
    if (!Number.isFinite(days)) return res.status(400).json({ error: "Invalid expiry window." });
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const until = new Date(now); until.setDate(until.getDate() + days);
    const { result: products } = await call(inventoryDB, "find", {});
    const alerts = [];
    for (const p of products) {
      for (const b of (Array.isArray(p.batches) ? p.batches : [])) {
        const d = new Date(b.expiryDate);
        if (!Number.isNaN(d.getTime()) && d <= until && Number(b.quantity) > 0) {
          alerts.push({ productId: p._id, productName: p.name, batchNumber: b.batchNumber, expiryDate: b.expiryDate, quantity: Number(b.quantity), expired: d < now });
        }
      }
    }
    res.json(alerts.sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate))));
  } catch (e) { res.status(500).json({ error: "Could not calculate expiry alerts." }); }
});

app.post("/reconcile/preview", async (req, res) => {
  try {
    const rows = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!rows.length || rows.length > 1000) throw new Error("Provide between 1 and 1000 stock-count rows.");
    const seen = new Set();
    const { result: products } = await call(inventoryDB, "find", {});
    const byId = new Map(products.map(p => [String(p._id), p]));
    const preview = rows.map(row => {
      const id = String(row.productId || "");
      if (seen.has(id)) throw new Error("Each product may appear only once in a reconciliation.");
      seen.add(id);
      const product = byId.get(id);
      const counted = Number(row.countedQuantity);
      if (!product || !Number.isFinite(counted) || counted < 0) throw new Error("A product is missing or a counted quantity is invalid.");
      const current = Number(product.quantity || 0);
      return { productId: product._id, productName: product.name, systemQuantity: current, countedQuantity: counted, variance: counted - current };
    });
    res.json({ preview, requiresApproval: true, note: "Preview only. No stock has changed." });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/reconcile/commit", async (req, res) => {
  try {
    const admin = await authorizeAdmin(req);
    if (!admin) return res.status(403).json({ error: "An active administrator account is required to adjust stock." });
    if (req.body && req.body.confirm !== true) throw new Error("Explicit confirmation is required.");
    const rows = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!rows.length || rows.length > 1000) throw new Error("Provide valid reconciliation rows.");
    const key = "reconcile:" + require("crypto").randomUUID();
    const { result: products } = await call(inventoryDB, "find", {});
    const byId = new Map(products.map(p => [String(p._id), p]));
    const changes = [];
    for (const row of rows) {
      const product = byId.get(String(row.productId));
      const counted = Number(row.countedQuantity);
      if (!product || !Number.isFinite(counted) || counted < 0) throw new Error("Invalid product or counted quantity.");
      const oldQuantity = Number(product.quantity || 0);
      if (oldQuantity !== Number(row.systemQuantity)) throw new Error("Stock changed after preview. Generate a new preview.");
      changes.push({ productId: product._id, oldQuantity, countedQuantity: counted, productSnapshot: product });
    }
    const updated = [];
    try {
      for (const change of changes) {
        const { result: count } = await call(inventoryDB, "update", { _id: change.productId, quantity: change.oldQuantity }, { $set: { quantity: change.countedQuantity } }, {});
        if (!count) throw new Error("Concurrent stock change detected; reconciliation stopped.");
        updated.push(change);
      }
      const record = await call(reconciliationDB, "insert", { reconciliationKey: key, changes, status: "posted", createdAt: new Date().toISOString() });
      await writeAudit(req, "stock_reconciliation_posted", "reconciliation", record.result._id, { changedProducts: changes.map(change => ({ productId: change.productId, from: change.oldQuantity, to: change.countedQuantity })) });
      res.json({ success: true, reconciliationId: record.result._id, updated: updated.length });
    } catch (err) {
      for (const change of updated.reverse()) {
        await call(inventoryDB, "update", { _id: change.productId, quantity: change.countedQuantity }, { $set: { quantity: change.oldQuantity } }, {});
      }
      throw err;
    }
  } catch (e) { res.status(409).json({ error: e.message, stockChanged: true }); }
});

app.get("/audit", async (req, res) => {
  try {
    const admin = await authorizeAdmin(req);
    if (!admin) return res.status(403).json({ error: "An active administrator account is required to view the audit log." });
    const { result } = await call(auditDB, "find", {});
    result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json(result.slice(0, 500));
  } catch (e) { res.status(500).json({ error: "Could not load administrator audit history." }); }
});
app.get("/reconcile/history", async (_req, res) => {
  try {
    const { result } = await call(reconciliationDB, "find", {});
    result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json(result.slice(0, 100));
  } catch (e) { res.status(500).json({ error: "Could not load reconciliation history." }); }
});

module.exports = { app, supplierDB, ledgerDB, recordLedger, getSupplier, summarizeLedger };
