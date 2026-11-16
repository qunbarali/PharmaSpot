const app = require("express")();
const Datastore = require("@seald-io/nedb");
const multer = require("multer");
const unzipper = require("unzipper");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Transform } = require("stream");
const async = require("async");
const { extractInvoice } = require("./invoice-ocr");
const supplierLedger = require("./supplier-ledger");

const appName = process.env.APPNAME;
const appData = process.env.APPDATA;
const uploadsRoot = path.join(appData, appName, "uploads");
const importRoot = path.join(uploadsRoot, "imports");
fs.mkdirSync(importRoot, { recursive: true });

const inventoryAPI = require("./inventory");
const inventoryDB = inventoryAPI.inventoryDB;
const importsDB = new Datastore({
  filename: path.join(appData, appName, "server", "databases", "imports.db"),
  autoload: true,
});
importsDB.ensureIndex({ fieldName: "importKey", unique: true, sparse: true });

const allowed = new Set([".pdf", ".zip", ".jpg", ".jpeg", ".png", ".webp"]);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, importRoot),
  filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.has(ext)) return cb(new Error("Unsupported file type. Upload PDF, ZIP, JPG, PNG or WEBP."));
    cb(null, true);
  },
});

const cleanName = (value) => String(value || "").toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/g, "");
const imageExts = new Set([".jpg", ".jpeg", ".png", ".webp"]);

// Importing supplier documents and changing stock is restricted to the local app host.
app.use((req, res, next) => {
  const remote = String(req.socket && req.socket.remoteAddress || "");
  const isLoopback = remote === "::1" || remote === "127.0.0.1" || remote.startsWith("::ffff:127.");
  if (!isLoopback) return res.status(403).json({ error: "Document imports are available only on the main PharmaSpot computer." });
  next();
});

app.get("/", (_req, res) => res.json({ module: "document-import", supported: Array.from(allowed) }));

app.post("/upload", (req, res) => {
  upload.array("files", 20)(req, res, async (error) => {
    if (error) return res.status(400).json({ error: error.message });
    try {
      const files = [];
      for (const file of (req.files || [])) {
        const digest = crypto.createHash("sha256").update(fs.readFileSync(file.path)).digest("hex");
        const record = {
          id: path.basename(file.filename, path.extname(file.filename)),
          originalName: path.basename(file.originalname),
          storedName: file.filename,
          type: path.extname(file.originalname).toLowerCase(),
          size: file.size,
          sha256: digest,
          path: file.path,
        };
        if (record.type === ".zip") {
          const directory = await unzipper.Open.file(file.path);
          const extracted = [];
          let extractedBytes = 0;
          let extractedCount = 0;
          for (const entry of directory.files) {
            if (entry.type !== "File") continue;
            const ext = path.extname(entry.path).toLowerCase();
            if (!imageExts.has(ext)) continue;
            extractedCount += 1;
            const declaredSize = Number(entry.vars && entry.vars.uncompressedSize || 0);
            if (extractedCount > 200 || declaredSize > 10 * 1024 * 1024 || extractedBytes + declaredSize > 50 * 1024 * 1024) throw new Error("ZIP archive exceeds safe extraction limits.");
            const normalizedEntry = String(entry.path || "").replace(/\\/g, "/");
            const safeEntryPath = path.posix.normalize(normalizedEntry);
            if (!normalizedEntry || normalizedEntry.startsWith("/") || safeEntryPath === ".." || safeEntryPath.startsWith("../")) throw new Error("ZIP archive contains an unsafe file path.");
            const base = path.posix.basename(safeEntryPath);
            if (!base || base.startsWith(".")) continue;
            const targetName = crypto.randomUUID() + ext;
            const targetPath = path.join(importRoot, targetName);
            let actualBytes = 0;
            await new Promise((resolve, reject) => {
              const output = fs.createWriteStream(targetPath, { flags: "wx" });
              const limiter = new Transform({
                transform(chunk, encoding, callback) {
                  actualBytes += chunk.length;
                  if (actualBytes > 10 * 1024 * 1024 || extractedBytes + actualBytes > 50 * 1024 * 1024) return callback(new Error("ZIP archive exceeds safe extraction limits."));
                  callback(null, chunk);
                }
              });
              const fail = error => { output.destroy(); fs.unlink(targetPath, () => reject(error)); };
              entry.on("error", fail);
              limiter.on("error", fail);
              output.on("error", fail);
              output.on("finish", resolve);
              entry.pipe(limiter).pipe(output);
            });
            extractedBytes += actualBytes;
            const signature = fs.readFileSync(targetPath).subarray(0, 12);
            const validImage = (ext === ".jpg" || ext === ".jpeg") ? signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff
              : ext === ".png" ? signature.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
              : ext === ".webp" ? signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "WEBP" : false;
            if (!validImage) { fs.unlinkSync(targetPath); continue; }
            extracted.push({ originalName: base, storedName: targetName, suggestedName: cleanName(base) });
          }
          record.extractedImages = extracted;
        }
        files.push(record);
      }
      const products = await new Promise((resolve, reject) => inventoryDB.find({}, (err, docs) => err ? reject(err) : resolve(docs || [])));
      const images = files.flatMap(file => file.type === ".zip" ? (file.extractedImages || []) : imageExts.has(file.type) ? [{ originalName: file.originalName, storedName: file.storedName, suggestedName: cleanName(file.originalName) }] : []);
      const imageSuggestions = images.map(image => {
        const needle = image.suggestedName;
        const matches = products.map(product => ({ product, score: Math.max(cleanName(product.name).includes(needle) && needle ? 0.9 : 0, needle && needle.includes(cleanName(product.name)) ? 0.85 : 0) }))
          .filter(match => match.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map(match => ({ productId: match.product._id, productName: match.product.name, confidence: match.score }));
        return { ...image, matches };
      });
      res.json({
        files: files.map(({ path: _path, ...file }) => file),
        imageSuggestions,
        invoiceReviewRequired: files.some(file => file.type === ".pdf" || imageExts.has(file.type)),
        note: "Files are staged only. Review invoice line items and image matches before applying changes. PDF/image OCR is not enabled in this build.",
      });
    } catch (err) {
      console.error("Import upload failed:", err);
      res.status(400).json({ error: "Could not safely process the uploaded archive or files." });
    }
  });
});

app.post("/ocr/:storedName", async (req, res) => {
  const storedName = path.basename(String(req.params.storedName || ""));
  if (!storedName || storedName !== req.params.storedName || !/^[a-f0-9-]+\.(pdf|jpg|jpeg|png|webp)$/i.test(storedName)) {
    return res.status(400).json({ error: "Invalid staged invoice file." });
  }
  const filePath = path.join(importRoot, storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Staged invoice file not found." });
  try {
    const result = await extractInvoice(filePath);
    res.json({ ...result, sourceFile: storedName });
  } catch (error) {
    res.status(503).json({ error: error.message || "Invoice OCR could not be completed." });
  }
});
app.post("/assign-image", (req, res) => {
  const productId = Number(req.body.productId);
  const storedName = path.basename(String(req.body.storedName || ""));
  if (!Number.isSafeInteger(productId) || !storedName || storedName !== req.body.storedName) {
    return res.status(400).json({ error: "A valid product and image are required." });
  }
  const imagePath = path.join(importRoot, storedName);
  if (!fs.existsSync(imagePath)) return res.status(404).json({ error: "Staged image not found." });
  const finalName = crypto.randomUUID() + path.extname(storedName).toLowerCase();
  const finalPath = path.join(uploadsRoot, finalName);
  fs.copyFile(imagePath, finalPath, (copyError) => {
    if (copyError) return res.status(500).json({ error: "Could not save product image." });
    inventoryDB.update({ _id: productId }, { $set: { img: finalName } }, {}, (err, count) => {
      if (err || !count) {
        fs.unlink(finalPath, () => {});
        return res.status(err ? 500 : 404).json({ error: err ? "Could not update product." : "Product not found." });
      }
      res.json({ success: true, productId, image: finalName });
    });
  });
});

app.post("/commit-purchase", (req, res) => {
  const body = req.body || {};
  const supplier = String(body.supplier || "").trim();
  const invoiceNo = String(body.invoiceNo || "").trim();
  const currency = String(body.currency || "").toUpperCase();
  const allowedCurrencies = new Set(["PKR", "INR", "USD"]);
  const rows = Array.isArray(body.items) ? body.items : [];
  if (!supplier || !invoiceNo || !allowedCurrencies.has(currency) || !rows.length) {
    return res.status(400).json({ error: "Supplier, invoice number, supported currency and at least one line item are required." });
  }
  const rate = Number(body.exchangeRate || 1);
  const baseCurrency = String(body.baseCurrency || "PKR").toUpperCase();
  if (!["PKR", "INR", "USD"].includes(baseCurrency) || !Number.isFinite(rate) || rate <= 0) return res.status(400).json({ error: "A supported base currency and a positive exchange rate are required." });
  if (currency === baseCurrency && rate !== 1) return res.status(400).json({ error: "Exchange rate must be 1 when invoice and store currencies are the same." });
  const importKey = supplier.toLowerCase() + "|" + invoiceNo.toLowerCase();
  importsDB.findOne({ importKey }, (lookupError, duplicate) => {
    if (lookupError) return res.status(500).json({ error: "Could not check duplicate invoices." });
    if (duplicate) return res.status(409).json({ error: "This supplier invoice has already been imported.", importId: duplicate._id });
    let applied = [];
    const snapshots = [];
    const rollbackApplied = (done) => async.eachSeries(snapshots.slice().reverse(), (snapshot, next) => {
      inventoryDB.update({ _id: snapshot.before._id, quantity: snapshot.after.quantity, batches: snapshot.after.batches }, snapshot.before, {}, next);
    }, done);
    async.eachSeries(rows, (row, next) => {
      const productId = Number(row.productId);
      const quantity = Number(row.quantity);
      const purchasePrice = Number(row.purchasePrice);
      const salePrice = Number(row.salePrice);
      const batchNumber = String(row.batchNumber || "").trim();
      const expiryDate = String(row.expiryDate || "").trim();
      if (!Number.isSafeInteger(productId) || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(purchasePrice) || purchasePrice < 0 || !Number.isFinite(salePrice) || salePrice < 0 || !batchNumber || !expiryDate) {
        return next(new Error("Every row needs a valid product, quantity, purchase price, sale price, batch number and expiry date."));
      }
      inventoryDB.findOne({ _id: productId }, (findError, product) => {
        if (findError || !product) return next(findError || new Error("One selected product no longer exists."));
        const batch = {
          batchNumber,
          expiryDate,
          quantity,
          purchasePrice,
          salePrice,
          baseCurrency,
          basePurchasePrice: Number((purchasePrice * rate).toFixed(4)),
          baseSalePrice: Number((salePrice * rate).toFixed(4)),
          currency,
          exchangeRate: rate,
          supplier,
          invoiceNo,
          receivedAt: new Date().toISOString(),
        };
        const snapshot = { before: JSON.parse(JSON.stringify(product)), after: null };
        snapshots.push(snapshot);
        const batches = Array.isArray(product.batches) ? product.batches.concat([batch]) : [batch];
        const newQuantity = Number(product.quantity || 0) + quantity;
        const updateFields = {
          quantity: newQuantity,
          price: String(Number((salePrice * rate).toFixed(2))),
          supplier,
          purchasePrice: String(Number((purchasePrice * rate).toFixed(2))),
          expirationDate: expiryDate,
          batches,
        };
        inventoryDB.update({ _id: productId, quantity: Number(product.quantity || 0) }, { $set: updateFields }, {}, (updateError, count) => {
          if (updateError || !count) { snapshots.pop(); return next(updateError || new Error("Stock changed during purchase posting.")); }
          snapshot.after = { ...JSON.parse(JSON.stringify(product)), ...updateFields };
          applied.push({ productId, quantity, purchasePrice, salePrice, batchNumber, expiryDate });
          next();
        });
      });
    }, (error) => {
      if (error) return rollbackApplied((rollbackError) => res.status(400).json({ error: error.message, rolledBack: !rollbackError, rollbackError: rollbackError ? "Stock rollback needs manual reconciliation." : undefined }));
      importsDB.insert({
        importKey,
        supplier,
        invoiceNo,
        currency,
        baseCurrency,
        exchangeRate: rate,
        items: applied,
        sourceFiles: Array.isArray(body.sourceFiles) ? body.sourceFiles.filter(file => file && /^[a-f0-9-]+\.(pdf|zip|jpg|jpeg|png|webp)$/i.test(file.storedName || "")).map(file => ({ originalName: String(file.originalName || "").slice(0, 200), storedName: file.storedName })) : [],
        createdAt: new Date().toISOString(),
        status: "posted",
      }, (saveError, record) => {
        if (saveError) return rollbackApplied((rollbackError) => res.status(500).json({ error: "Import history could not be saved; stock changes were rolled back.", rolledBack: !rollbackError, rollbackError: rollbackError ? "Stock rollback needs manual reconciliation." : undefined }));
        const invoiceTotal = rows.reduce((sum, row) => sum + Number(row.quantity) * Number(row.purchasePrice), 0);
        supplierLedger.getSupplier(supplier, true)
          .then(distributor => supplierLedger.recordLedger({
            supplier: distributor, type: "purchase", currency, amount: invoiceTotal,
            reference: invoiceNo, importId: record._id, note: "Supplier invoice stock receipt",
            eventKey: "purchase:" + record._id
          }))
          .then(() => res.json({ success: true, importId: record._id, appliedRows: applied.length, supplierLedger: "recorded" }))
          .catch((ledgerError) => {
            console.error("Supplier ledger write failed for import", record._id, ledgerError);
            importsDB.update({ _id: record._id }, { $set: { supplierLedgerStatus: "needs_repair" } }, {}, () => {});
            res.status(207).json({ success: true, importId: record._id, appliedRows: applied.length, supplierLedger: "needs_repair", warning: "Stock was posted, but distributor balance could not be updated. Review import history before paying this supplier." });
          });
      });
    });
  });
});

app.get("/file/:storedName", (req, res) => {
  const storedName = path.basename(String(req.params.storedName || ""));
  if (!storedName || storedName !== req.params.storedName) return res.sendStatus(400);
  const filePath = path.join(importRoot, storedName);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);
  res.sendFile(filePath);
});

app.get("/history", (_req, res) => {
  importsDB.find({}).sort({ createdAt: -1 }).limit(100).exec((err, docs) => {
    if (err) return res.status(500).json({ error: "Could not load import history." });
    res.json(docs || []);
  });
});

module.exports = app;
