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
    try { await writeAudit(req, "supplier_payment_recorded", "supplier", supplier._id, { currency, amount, reference: payment.reference, ledgerEvent: payment.eventKey }); }
    catch (_) { return res.status(207).json({ success: true, payment, warning: "Payment recorded but audit logging failed. Contact an administrator." }); }
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

const { buildReconciliationPreview, planProductReconciliation } = require("./reconciliation-utils");

app.post("/reconcile/preview", async (req, res) => {
  try {
    const rows = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const { result: products } = await call(inventoryDB, "find", {});
    const preview = buildReconciliationPreview(products, rows);
    res.json({ preview, requiresApproval: true, note: "Preview only. Every tracked batch and any unbatched stock must be counted separately. No stock has changed." });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/reconcile/commit", async (req, res) => {
  const updated = [];
  try {
    const admin = await authorizeAdmin(req);
    if (!admin) return res.status(403).json({ error: "An active administrator account is required to adjust stock." });
    if (req.body && req.body.confirm !== true) throw new Error("Explicit confirmation is required.");
    const rows = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!rows.length || rows.length > 1000) throw new Error("Provide valid reconciliation rows.");
    const { result: products } = await call(inventoryDB, "find", {});
    const preview = buildReconciliationPreview(products, rows.map(row => ({
      productId: row.productId,
      systemQuantity: row.systemQuantity,
      untrackedSystemQuantity: row.untrackedSystemQuantity,
      untrackedCount: row.untrackedCount,
      batchCounts: (Array.isArray(row.batchCounts) ? row.batchCounts : []).map(batch => ({
        batchIndex: batch.batchIndex, batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate, systemQuantity: batch.systemQuantity,
        countedQuantity: batch.countedQuantity
      }))
    })));
    const byId = new Map(products.map(product => [String(product._id), product]));
    const plans = preview.map(row => planProductReconciliation(byId.get(String(row.productId)), {
      productId: row.productId,
      systemQuantity: row.systemQuantity,
      untrackedSystemQuantity: row.untrackedSystemQuantity,
      untrackedCount: row.untrackedCount,
      batchCounts: row.batchCounts
    }));
    const key = "reconcile:" + require("crypto").randomUUID();
    for (const plan of plans) {
      const { result: count } = await call(inventoryDB, "update",
        { _id: plan.productId, quantity: plan.systemQuantity, batches: plan.oldProduct.batches || [] },
        { $set: { quantity: plan.countedQuantity, batches: plan.nextProduct.batches || [] } }, {});
      if (!count) throw new Error("Stock changed during reconciliation. No further rows were applied.");
      updated.push(plan);
    }
    const record = await call(reconciliationDB, "insert", {
      reconciliationKey: key,
      changes: plans.map(plan => ({
        productId: plan.productId, productName: plan.productName,
        systemQuantity: plan.systemQuantity, countedQuantity: plan.countedQuantity,
        variance: plan.variance, systemBatches: plan.systemBatches,
        countedBatches: plan.countedBatches,
        untrackedSystemQuantity: plan.oldUntracked, untrackedCount: plan.countedUntracked
      })),
      status: "posted", createdAt: new Date().toISOString()
    });
    try {
      await writeAudit(req, "stock_reconciliation_posted", "reconciliation", record.result._id, {
        changedProducts: plans.map(plan => ({ productId: plan.productId, from: plan.systemQuantity, to: plan.countedQuantity }))
      });
    } catch (_) {
      return res.status(207).json({ success: true, reconciliationId: record.result._id, updated: updated.length, warning: "Batch-aware stock adjustment saved but audit logging failed. Contact an administrator." });
    }
    return res.json({ success: true, reconciliationId: record.result._id, updated: updated.length });
  } catch (e) {
    let rollbackError = false;
    for (const plan of updated.slice().reverse()) {
      try {
        const { result: count } = await call(inventoryDB, "update",
          { _id: plan.productId, quantity: plan.countedQuantity, batches: plan.nextProduct.batches || [] },
          { $set: { quantity: plan.systemQuantity, batches: plan.oldProduct.batches || [] } }, {});
        if (!count) rollbackError = true;
      } catch (_) { rollbackError = true; }
    }
    return res.status(409).json({
      error: e.message,
      rolledBack: !rollbackError,
      rollbackError: rollbackError ? "A concurrent stock change prevented complete rollback; manual reconciliation is required." : undefined
    });
  }
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
