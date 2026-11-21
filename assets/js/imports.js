let reconciliationPreviewPayload = null;
const $ = window.jQuery;
const Store = require("electron-store");
const store = new Store();
const appSettings = store.get("settings") || {};
const baseCurrency = appSettings.currencyCode || "PKR";
const networkSettings = appSettings.app === "Network Point of Sale Terminal";
const importApiHost = networkSettings ? (appSettings.ip || "localhost") : "localhost";
const importApiPort = appSettings.port || process.env.PORT || "3210";
const importApi = "http://" + importApiHost + ":" + importApiPort + "/api/";
let importProducts = [];
let stagedImages = [];
let stagedInvoiceFiles = [];

function loadImportProducts(done) {
  $.getJSON(importApi + "inventory/products")
    .done((products) => { importProducts = products || []; if (done) done(); })
    .fail(() => window.alert("Could not load product records. Check the server connection."));
}

function productOptions(selected) {
  return '<option value="">Select product</option>' + importProducts.map((product) =>
    '<option value="' + String(product._id) + '"' + (String(product._id) === String(selected || "") ? " selected" : "") + '>' +
    $("<div>").text(product.name || ("Product " + product._id)).html() + '</option>'
  ).join("");
}

function addPurchaseRow(values = {}) {
  const row = $('<tr>' +
    '<td><input class="form-control import-description" type="text" placeholder="Invoice item description"></td>' +
    '<td><select class="form-control import-product">' + productOptions(values.productId) + '</select></td>' +
    '<td><input class="form-control import-quantity" type="number" min="0.001" step="any" placeholder="Paid qty"></td>' +
    '<td><input class="form-control import-bonus" type="number" min="0" step="any" placeholder="Free qty (0)"></td>' +
    '<td><input class="form-control import-cost" type="number" min="0" step="0.01" placeholder="0.00"></td>' +
    '<td><input class="form-control import-sale" type="number" min="0" step="0.01" placeholder="0.00"></td>' +
    '<td><input class="form-control import-batch" type="text" placeholder="Batch"></td>' +
    '<td><input class="form-control import-expiry" type="text" placeholder="YYYY-MM-DD"></td>' +
    '<td><button type="button" class="btn btn-danger btn-xs remove-import-row" title="Remove line">×</button></td>' +
    '</tr>');
  $("#purchaseImportTable tbody").append(row);
  row.find(".import-description").val(values.sourceDescription || values.productName || values.description || "");
  row.find(".import-product").val(values.productId || "");
  row.find(".import-quantity").val(values.quantity ?? "");
  row.find(".import-bonus").val(values.bonusQuantity ?? values.freeQuantity ?? 0);
  row.find(".import-cost").val(values.purchasePrice ?? "");
  row.find(".import-sale").val(values.salePrice ?? "");
  row.find(".import-batch").val(values.batchNumber || "");
  row.find(".import-expiry").val(values.expiryDate || "");
}

function bestInvoiceProductMatch(description) {
  const normalize = value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const target = normalize(description);
  if (!target) return "";
  const targetTokens = target.split(/\s+/).filter(token => token.length > 2);
  const ranked = importProducts.map(product => {
    const name = normalize(product.name);
    if (!name) return { product, score: 0 };
    if (target === name || target.includes(name) || name.includes(target)) return { product, score: 0.95 };
    const tokens = name.split(/\s+/).filter(token => token.length > 2);
    const overlap = tokens.filter(token => targetTokens.includes(token)).length;
    return { product, score: tokens.length ? overlap / Math.max(tokens.length, targetTokens.length, 1) : 0 };
  }).sort((a, b) => b.score - a.score);
  return ranked.length && ranked[0].score >= 0.72 ? String(ranked[0].product._id) : "";
}

function updateImportExchangeRate() {
  if ($("#importCurrency").val() === baseCurrency) {
    $("#importExchangeRate").val("1");
    return;
  }
  const configuredForeignPerBase = Number((appSettings.exchangeRates || {})[$("#importCurrency").val()] || 0);
  $("#importExchangeRate").val(configuredForeignPerBase > 0 ? (1 / configuredForeignPerBase).toFixed(6) : "");
}

function runInvoiceOcr(files) {
  const candidates = (files || []).flatMap(file =>
    file.type === ".zip" ? (file.extractedDocuments || file.extractedImages || []) : [file]
  );
  const supported = candidates.filter(file =>
    [".pdf", ".jpg", ".jpeg", ".png", ".webp"].includes(file.type || String(file.storedName || "").slice(String(file.storedName || "").lastIndexOf(".")).toLowerCase())
  );
  const panel = $("#invoiceOcrResults").empty();
  if (!supported.length) {
    panel.text("Files uploaded. No supported PDF or image invoice was found to read.");
    return;
  }
  panel.append($('<p class="text-muted"></p>').text("Reading invoice documents… OCR output is a draft. Check the extracted values against the original invoice."));
  supported.forEach(file => {
    $.ajax({ url: importApi + "imports/ocr/" + encodeURIComponent(file.storedName), method: "POST", timeout: 120000 })
      .done(result => {
        const fields = result.fields || {};
        const card = $('<div class="panel panel-default m-t-10"></div>');
        card.append($('<div class="panel-heading"></div>').text(file.originalName + " — OCR review draft"));
        const body = $('<div class="panel-body"></div>');
        body.append($("<p></p>").text(
          "Supplier: " + (fields.supplier || "Not detected") +
          " | Supplier ID: " + (fields.supplierIdentifier || "Not detected") +
          " | Invoice: " + (fields.invoiceNo || "Not detected") +
          " | Date: " + (fields.invoiceDate || "Not detected") +
          " | Currency: " + (fields.currency || "Not detected")
        ));
        if (fields.supplier && !$("#importSupplier").val()) $("#importSupplier").val(fields.supplier);
        if (fields.supplierIdentifier && !$("#importSupplierIdentifier").val()) $("#importSupplierIdentifier").val(fields.supplierIdentifier);
        if (fields.invoiceNo && !$("#importInvoiceNo").val()) $("#importInvoiceNo").val(fields.invoiceNo);
        if (fields.invoiceDate && /^\d{4}-\d{2}-\d{2}$/.test(fields.invoiceDate) && !$("#importInvoiceDate").val()) {
          $("#importInvoiceDate").val(fields.invoiceDate);
          if (!$("#importExchangeRateDate").data("user-selected")) $("#importExchangeRateDate").val(fields.invoiceDate);
        }
        if (fields.currency && ["PKR", "INR", "USD"].includes(fields.currency) && !$("#importCurrency").data("user-selected")) {
          $("#importCurrency").val(fields.currency);
          updateImportExchangeRate();
        }
        if (result.rows && result.rows.length) {
          const suggestions = $('<table class="table table-condensed table-bordered"><thead><tr><th>Invoice description</th><th>Match product</th><th>Paid qty</th><th>Bonus / free qty</th><th>Purchase</th><th>Sale</th><th>Batch</th><th>Expiry</th><th></th></tr></thead><tbody></tbody></table>');
          result.rows.forEach(invoiceRow => {
            const description = invoiceRow.productName || invoiceRow.description || "";
            const suggestedId = bestInvoiceProductMatch(description);
            const select = $('<select class="form-control input-sm"></select>').html(productOptions(suggestedId));
            const add = $('<button class="btn btn-success btn-xs" type="button">Add editable row</button>');
            add.on("click", () => {
              if (!select.val()) return window.alert("Choose the correct medicine for this invoice line first.");
              addPurchaseRow({
                sourceDescription: description,
                productId: select.val(),
                quantity: invoiceRow.quantity,
                bonusQuantity: invoiceRow.bonusQuantity ?? invoiceRow.freeQuantity ?? 0,
                purchasePrice: invoiceRow.purchasePrice ?? invoiceRow.unitPrice ?? "",
                salePrice: invoiceRow.salePrice ?? "",
                batchNumber: invoiceRow.batchNumber || "",
                expiryDate: invoiceRow.expiryDate || ""
              });
              add.prop("disabled", true).text("Added to draft");
            });
            const line = $("<tr></tr>").append(
              $("<td></td>").text(description || "Not detected"),
              $("<td></td>").append(select),
              $("<td></td>").text(invoiceRow.quantity ?? "Not detected"),
              $("<td></td>").text(invoiceRow.bonusQuantity ?? invoiceRow.freeQuantity ?? 0),
              $("<td></td>").text(invoiceRow.purchasePrice ?? invoiceRow.unitPrice ?? "Not detected"),
              $("<td></td>").text(invoiceRow.salePrice ?? "Not detected"),
              $("<td></td>").text(invoiceRow.batchNumber || "Not detected"),
              $("<td></td>").text(invoiceRow.expiryDate || "Not detected"),
              $("<td></td>").append(add)
            );
            suggestions.find("tbody").append(line);
          });
          body.append($('<p class="text-warning"></p>').text("Add each detected line to the editable purchase table. You can correct the description, product, paid quantity, bonus/free quantity, purchase price, sale price, batch and expiry before saving the draft."), suggestions);
        } else {
          body.append($('<p class="text-warning"></p>').text("No structured invoice lines were detected. Review the extracted text and enter each invoice line manually."));
        }
        body.append($('<pre style="white-space:pre-wrap;max-height:220px;overflow:auto"></pre>').text(result.text || "No readable text detected."));
        body.append($('<p class="text-warning"></p>').text(result.warning || "OCR values are not approved. Verify every field before saving or approving."));
        card.append(body); panel.append(card);
      })
      .fail(xhr => panel.append($('<p class="text-danger"></p>').text(file.originalName + ": " + (xhr.responseJSON?.error || "OCR failed."))));
  });
}
function uploadImportFiles(inputSelector, statusSelector, onSuccess, buttonSelector) {
  const input = document.querySelector(inputSelector);
  const button = buttonSelector ? $(buttonSelector) : $();
  const originalLabel = button.text();
  if (!input || !input.files || !input.files.length) {
    $(statusSelector).text("Select at least one file before uploading.");
    window.alert("Please select at least one file.");
    return;
  }
  const data = new FormData();
  Array.from(input.files).forEach(file => data.append("files", file));
  button.prop("disabled", true).text("Uploading…");
  $(statusSelector).text("Uploading and checking files…");
  $.ajax({
    url: importApi + "imports/upload",
    method: "POST",
    data,
    processData: false,
    contentType: false,
    timeout: 120000
  }).done(result => {
    if (!result || !Array.isArray(result.files)) {
      $(statusSelector).text("The server returned an invalid upload response.");
      return;
    }
    if (typeof onSuccess === "function") onSuccess(result);
  }).fail(xhr => {
    const message = xhr.responseJSON?.error || (xhr.status ? "Upload failed (HTTP " + xhr.status + ")." : "Upload failed. Check that the PharmaSpot server is running.");
    $(statusSelector).text(message);
  }).always(() => {
    button.prop("disabled", false).text(originalLabel);
  });
}
function renderReconciliationCounts(row, product) {
  const container = row.find(".reconciliation-counts").empty();
  row.data("stockSnapshot", product);
  const quantity = Number(product.quantity || 0);
  const batches = Array.isArray(product.batches) ? product.batches : [];
  const batchTotal = batches.reduce((sum, batch) => sum + Number(batch.quantity || 0), 0);
  if (!Number.isFinite(batchTotal) || batchTotal > quantity) {
    container.append($('<p class="text-danger"></p>').text("Batch quantities exceed product stock. Correct inventory before reconciliation."));
    row.data("stockSnapshot", null);
    reconciliationPreviewPayload = null;
    $("#commitReconciliation").prop("disabled", true);
    return;
  }
  batches.forEach((batch, index) => {
    const line = $('<div class="form-group"></div>');
    const label = $('<label></label>').text("Batch " + (batch.batchNumber || ("#" + (index + 1))) + " | Expiry " + (batch.expiryDate || "Not recorded") + " | System " + Number(batch.quantity || 0));
    const input = $('<input class="form-control reconciliation-batch-count" type="number" min="0" step="any">');
    input.attr("data-batch-index", index).attr("data-batch-number", batch.batchNumber || "").attr("data-expiry-date", batch.expiryDate || "").attr("data-system-quantity", Number(batch.quantity || 0)).val(Number(batch.quantity || 0));
    line.append(label, input); container.append(line);
  });
  const untracked = quantity - batchTotal;
  const line = $('<div class="form-group"></div>');
  const label = $('<label></label>').text((batches.length ? "Unbatched / legacy stock" : "Unbatched stock") + " | System " + untracked);
  const input = $('<input class="form-control reconciliation-untracked-count" type="number" min="0" step="any">').attr("data-system-quantity", untracked).val(untracked);
  line.append(label, input); container.append(line);
}
function addReconciliationRow() {
  loadImportProducts(() => {
    const row = $('<tr></tr>');
    const select = $('<select class="form-control reconciliation-product"></select>').html(productOptions());
    const counts = $('<div class="reconciliation-counts"></div>');
    select.on("change", function () {
      reconciliationPreviewPayload = null;
      $("#commitReconciliation").prop("disabled", true);
      $("#reconciliationPreview").empty();
      if (!this.value) { counts.empty(); row.data("stockSnapshot", null); return; }
      $.getJSON(importApi + "inventory/product/" + encodeURIComponent(this.value))
        .done(product => {
          if (!product) return counts.text("Product not found.");
          renderReconciliationCounts(row, product);
        })
        .fail(() => counts.text("Could not load product batches."));
    });
    row.append($('<td></td>').append(select), $('<td></td>').append(counts), $('<td></td>').append($('<button class="btn btn-default remove-reconciliation-row" type="button">Remove</button>')));
    $("#reconciliationTable tbody").append(row);
  });
}
function loadReconciliationHistory() {
  $.getJSON(importApi + "supplier-ledger/reconcile/history").done(records => {
    const list = $('<ul class="list-group"></ul>');
    (records || []).forEach(record => list.append($('<li class="list-group-item"></li>').text(new Date(record.createdAt).toLocaleString() + " — " + (record.changes || []).length + " product(s) — " + record.status)));
    if (!records || !records.length) list.append($('<li class="list-group-item"></li>').text("No stock reconciliations recorded."));
    $("#reconciliationHistory").empty().append($('<h4>Recent adjustments</h4>'), list);
  }).fail(() => $("#reconciliationHistory").text("Could not load reconciliation history."));
}
function previewReconciliation() {
  const items = [];
  let invalid = false;
  $("#reconciliationTable tbody tr").each(function () {
    const row = $(this), product = row.data("stockSnapshot");
    if (!product) { invalid = true; return; }
    const batchCounts = [];
    row.find(".reconciliation-batch-count").each(function () {
      const counted = this.value;
      if (counted === "" || !Number.isFinite(Number(counted)) || Number(counted) < 0) invalid = true;
      batchCounts.push({
        batchIndex: Number($(this).attr("data-batch-index")),
        batchNumber: $(this).attr("data-batch-number"),
        expiryDate: $(this).attr("data-expiry-date"),
        systemQuantity: Number($(this).attr("data-system-quantity")),
        countedQuantity: Number(counted)
      });
    });
    const untracked = row.find(".reconciliation-untracked-count").val();
    if (untracked === "" || !Number.isFinite(Number(untracked)) || Number(untracked) < 0) invalid = true;
    items.push({
      productId: product._id, systemQuantity: Number(product.quantity || 0),
      batchCounts, untrackedSystemQuantity: Number(row.find(".reconciliation-untracked-count").attr("data-system-quantity")),
      untrackedCount: Number(untracked)
    });
  });
  if (invalid || !items.length) return window.alert("Select each product and enter a valid physical count for every batch and unbatched quantity.");
  reconciliationPreviewPayload = null;
  $("#commitReconciliation").prop("disabled", true);
  $.ajax({ url: importApi + "supplier-ledger/reconcile/preview", method: "POST", contentType: "application/json", data: JSON.stringify({ items }) })
    .done(result => {
      reconciliationPreviewPayload = result.preview;
      const table = $('<table class="table table-bordered"><thead><tr><th>Product / batch</th><th>System</th><th>Counted</th><th>Difference</th></tr></thead><tbody></tbody></table>');
      (result.preview || []).forEach(row => {
        table.find("tbody").append($('<tr></tr>').append($('<td></td>').text(row.productName + " — total"), $('<td></td>').text(row.systemQuantity), $('<td></td>').text(row.countedQuantity), $('<td></td>').text(row.variance)));
        (row.countedBatches || []).forEach((batch, index) => {
          const before = (row.systemBatches || [])[index] || {};
          table.find("tbody").append($('<tr></tr>').append($('<td></td>').text("  " + (batch.batchNumber || "Batch") + " / " + (batch.expiryDate || "No expiry")), $('<td></td>').text(before.quantity || 0), $('<td></td>').text(batch.quantity), $('<td></td>').text(Number(batch.quantity || 0) - Number(before.quantity || 0))));
        });
        if (Number(row.untrackedSystemQuantity || 0) || Number(row.untrackedCount || 0)) table.find("tbody").append($('<tr></tr>').append($('<td></td>').text("  Unbatched stock"), $('<td></td>').text(row.untrackedSystemQuantity), $('<td></td>').text(row.untrackedCount), $('<td></td>').text(Number(row.untrackedCount) - Number(row.untrackedSystemQuantity))));
      });
      $("#reconciliationPreview").empty().append(table, $('<p class="text-warning"></p>').text(result.note || "Preview only; stock has not changed."));
      $("#commitReconciliation").prop("disabled", !result.preview || !result.preview.length);
    }).fail(xhr => $("#reconciliationPreview").text(xhr.responseJSON?.error || "Could not preview stock counts."));
}
function makeDraftField(label, className, value, type = "text", step) {
  const wrapper = $('<div class="form-group"></div>');
  wrapper.append($("<label></label>").text(label));
  const input = $('<input class="form-control">').addClass(className).attr("type", type).val(value == null ? "" : value);
  if (step) input.attr("step", step);
  wrapper.append(input);
  return wrapper;
}

function makeDraftLine(item = {}) {
  const row = $("<tr></tr>");
  const description = $('<input class="form-control input-sm draft-description" type="text">').val(item.sourceDescription || item.productName || item.description || "");
  const product = $('<select class="form-control input-sm draft-product"></select>').html(productOptions(item.productId));
  const quantity = $('<input class="form-control input-sm draft-quantity" type="number" min="0.001" step="any">').val(item.quantity ?? "");
  const bonus = $('<input class="form-control input-sm draft-bonus" type="number" min="0" step="any">').val(item.bonusQuantity ?? 0);
  const purchase = $('<input class="form-control input-sm draft-purchase" type="number" min="0" step="any">').val(item.purchasePrice ?? "");
  const sale = $('<input class="form-control input-sm draft-sale" type="number" min="0" step="any">').val(item.salePrice ?? "");
  const batch = $('<input class="form-control input-sm draft-batch" type="text">').val(item.batchNumber || "");
  const expiry = $('<input class="form-control input-sm draft-expiry" type="date">').val(item.expiryDate || "");
  const remove = $('<button class="btn btn-danger btn-xs" type="button" title="Remove invoice line">×</button>');
  remove.on("click", () => row.remove());
  row.append(
    $("<td></td>").append(description), $("<td></td>").append(product),
    $("<td></td>").append(quantity), $("<td></td>").append(bonus),
    $("<td></td>").append(purchase), $("<td></td>").append(sale),
    $("<td></td>").append(batch), $("<td></td>").append(expiry),
    $("<td></td>").append(remove)
  );
  return row;
}

function buildPendingPurchaseEditor(draft, refresh) {
  const card = $('<div class="list-group-item"></div>');
  card.append($("<strong></strong>").text(draft.supplier + " — invoice " + draft.invoiceNo));
  card.append($('<p class="small text-muted"></p>').text(
    (draft.items || []).length + " line(s) | " + new Date(draft.createdAt).toLocaleString() +
    " | " + draft.status + " | revision " + Number(draft.revision || 0)
  ));

  const toggle = $('<button class="btn btn-default btn-xs" type="button">Review / edit all fields</button>');
  const editor = $('<div class="m-t-15"></div>').hide();
  toggle.on("click", () => {
    editor.toggle();
    toggle.text(editor.is(":visible") ? "Hide draft details" : "Review / edit all fields");
  });

  const metadata = $('<div class="row"></div>');
  const supplierField = makeDraftField("Supplier / distributor", "draft-supplier", draft.supplier);
  const identifierField = makeDraftField("Supplier code / NTN", "draft-supplier-identifier", draft.supplierIdentifier);
  const invoiceField = makeDraftField("Invoice number", "draft-invoice-no", draft.invoiceNo);
  const invoiceDateField = makeDraftField("Invoice date", "draft-invoice-date", draft.invoiceDate, "date");
  const rateField = makeDraftField("Exchange rate (1 invoice unit = store units)", "draft-exchange-rate", draft.exchangeRate, "number", "any");
  const rateDateField = makeDraftField("Exchange-rate date", "draft-exchange-rate-date", draft.exchangeRateDate, "date");
  [supplierField, identifierField, invoiceField, invoiceDateField, rateField, rateDateField].forEach(field => {
    field.addClass("col-sm-4");
    metadata.append(field);
  });
  const currencyField = $('<div class="form-group col-sm-4"><label>Invoice currency</label><select class="form-control draft-currency"><option>PKR</option><option>INR</option><option>USD</option></select></div>');
  currencyField.find("select").val(draft.currency || "PKR");
  const baseField = $('<div class="form-group col-sm-4"><label>Store base currency (fixed)</label><input class="form-control" type="text" disabled></div>');
  baseField.find("input").val(draft.baseCurrency || baseCurrency);
  metadata.append(currencyField, baseField);

  const table = $('<div class="table-responsive"><table class="table table-bordered table-condensed"><thead><tr><th>Invoice description</th><th>Product</th><th>Paid qty</th><th>Bonus / free qty</th><th>Purchase price</th><th>Sale price</th><th>Batch</th><th>Expiry</th><th></th></tr></thead><tbody></tbody></table></div>');
  const body = table.find("tbody");
  (draft.items || []).forEach(item => body.append(makeDraftLine(item)));
  const addLine = $('<button class="btn btn-default btn-xs" type="button">Add invoice line</button>');
  addLine.on("click", () => body.append(makeDraftLine()));
  const save = $('<button class="btn btn-primary btn-sm pull-right" type="button">Save corrections (no stock change)</button>');
  const review = $('<label class="checkbox-inline m-t-10"><input type="checkbox" class="draft-reviewed"> I reviewed the supplier, invoice, currency, product mapping, every quantity and price, batch number and expiry against the original document.</label>');
  const approve = $('<button class="btn btn-success btn-sm m-t-10" type="button" disabled>Approve reviewed draft and post stock</button>');
  review.find("input").on("change", function () { approve.prop("disabled", !this.checked); });

  save.on("click", () => {
    const items = [];
    body.find("tr").each(function () {
      const row = $(this);
      items.push({
        sourceDescription: row.find(".draft-description").val(),
        productId: row.find(".draft-product").val(),
        quantity: row.find(".draft-quantity").val(),
        bonusQuantity: row.find(".draft-bonus").val(),
        purchasePrice: row.find(".draft-purchase").val(),
        salePrice: row.find(".draft-sale").val(),
        batchNumber: row.find(".draft-batch").val(),
        expiryDate: row.find(".draft-expiry").val()
      });
    });
    const payload = {
      supplier: editor.find(".draft-supplier").val(),
      supplierIdentifier: editor.find(".draft-supplier-identifier").val(),
      invoiceNo: editor.find(".draft-invoice-no").val(),
      invoiceDate: editor.find(".draft-invoice-date").val(),
      currency: editor.find(".draft-currency").val(),
      baseCurrency: draft.baseCurrency || baseCurrency,
      exchangeRate: editor.find(".draft-exchange-rate").val(),
      exchangeRateDate: editor.find(".draft-exchange-rate-date").val(),
      items
    };
    if (!window.confirm("Save these corrections to the pending draft? Inventory will not change.")) return;
    save.prop("disabled", true);
    $.ajax({
      url: importApi + "imports/update-purchase-draft/" + encodeURIComponent(draft._id),
      method: "POST",
      contentType: "application/json",
      data: JSON.stringify(payload)
    }).done(result => {
      window.alert(result.warning || result.message || "Draft corrections saved. No stock was changed.");
      refresh();
      loadAdminAuditTrail();
    }).fail(xhr => window.alert(xhr.responseJSON?.error || "Could not save draft corrections. No stock was posted."))
      .always(() => save.prop("disabled", false));
  });

  approve.on("click", () => {
    if (!review.find("input").prop("checked")) return;
    if (!window.confirm("I have reviewed every field against the original invoice. Approve invoice " + draft.invoiceNo + " and post its stock now?")) return;
    approve.prop("disabled", true);
    $.ajax({
      url: importApi + "imports/approve-purchase/" + encodeURIComponent(draft._id),
      method: "POST",
      contentType: "application/json",
      data: JSON.stringify({ confirm: true, reviewed: true })
    }).done(result => {
      window.alert(result.warning || ("Purchase approved. " + result.appliedRows + " line(s) posted."));
      loadPendingPurchaseDrafts();
      loadPurchaseImportHistory();
      loadDistributorAccounts();
      loadAdminAuditTrail();
    }).fail(xhr => {
      window.alert(xhr.responseJSON?.error || "Could not approve this purchase.");
      approve.prop("disabled", !review.find("input").prop("checked"));
    });
  });

  editor.append(
    $('<p class="text-warning"></p>').text("Review and correct every field below. OCR values are suggestions only. Saving corrections keeps the draft pending and does not change inventory."),
    metadata, table, addLine, $("<div class='clearfix'></div>"), save, $("<div class='clearfix'></div>"), review,
    $("<div class='clearfix'></div>"), approve
  );
  card.append(toggle, editor);
  return card;
}

function loadPendingPurchaseDrafts() {
  $.getJSON(importApi + "imports/pending-purchases").done(drafts => {
    const render = () => {
      const list = $('<div class="list-group"></div>');
      (drafts || []).forEach(draft => list.append(buildPendingPurchaseEditor(draft, loadPendingPurchaseDrafts)));
      if (!list.children().length) list.text("No purchase drafts awaiting approval.");
      $("#pendingPurchaseDrafts").empty().append(list);
    };
    if ((drafts || []).length && !importProducts.length) return loadImportProducts(render);
    render();
  }).fail(xhr => $("#pendingPurchaseDrafts").text(xhr.status === 403 ? "Administrator account required to view pending approvals." : "Could not load pending purchase approvals."));
}
function loadPurchaseImportHistory() {
  $.getJSON(importApi + "imports/history").done(records => {
    const list = $('<div class="list-group"></div>');
    (records || []).filter(record => ["posted", "reversed", "reversing", "reversal_needs_reconciliation"].includes(record.status) && record.type !== "purchase_draft").forEach(record => {
      const item = $('<div class="list-group-item"></div>');
      item.append($('<strong></strong>').text(record.supplier + " — invoice " + record.invoiceNo + " — " + record.status));
      item.append($('<p class="small text-muted"></p>').text(new Date(record.createdAt).toLocaleString() + " | " + (record.items || []).length + " line(s)"));
      const reverse = $('<button class="btn btn-warning btn-xs" type="button">Reverse purchase</button>');
      reverse.prop("disabled", record.status !== "posted");
      if (record.status === "reversed") reverse.text("Already reversed");
      if (record.status === "reversing") reverse.text("Reversal in progress");
      if (record.status === "reversal_needs_reconciliation") reverse.text("Manual reconciliation required");
      reverse.on("click", () => {
        const reason = window.prompt("Enter the reason for reversing invoice " + record.invoiceNo + ". Reversal is blocked if any purchased batch has changed or been sold.");
        if (!reason || !reason.trim()) return;
        if (!window.confirm("Reverse this purchase and adjust stock and distributor balance?")) return;
        $.ajax({ url: importApi + "imports/reverse-purchase/" + encodeURIComponent(record._id), method: "POST", contentType: "application/json", data: JSON.stringify({ confirm: true, reason }) })
          .done(() => { window.alert("Purchase reversal completed."); loadPurchaseImportHistory(); loadDistributorAccounts(); loadAdminAuditTrail(); })
          .fail(xhr => { window.alert(xhr.responseJSON?.error || "Purchase reversal was blocked."); loadPurchaseImportHistory(); loadDistributorAccounts(); loadAdminAuditTrail(); });
      });
      item.append(reverse); list.append(item);
    });
    if (!list.children().length) list.text("No posted purchase invoices found.");
    $("#purchaseImportHistory").empty().append(list);
  }).fail(() => $("#purchaseImportHistory").text("Could not load purchase history."));
}
function loadAdminAuditTrail() {
  $.getJSON(importApi + "supplier-ledger/audit").done(events => {
    const list = $('<ul class="list-group"></ul>');
    (events || []).forEach(event => {
      const item = $('<li class="list-group-item"></li>');
      const summary = event.action + " — " + event.entityType + " " + event.entityId + " — " + event.actor + " — " + new Date(event.createdAt).toLocaleString();
      item.append($('<strong></strong>').text(summary));
      if (event.details && Object.keys(event.details).length) item.append($('<pre class="m-t-10"></pre>').text(JSON.stringify(event.details, null, 2)));
      if (event.actorVerification) item.append($('<small class="text-muted"></small>').text(event.actorVerification));
      list.append(item);
    });
    if (!events || !events.length) list.append($('<li class="list-group-item"></li>').text("No audit events recorded."));
    $("#adminAuditTrail").empty().append(list);
  }).fail(xhr => $("#adminAuditTrail").text(xhr.status === 403 ? "Administrator account required to view this audit trail." : "Could not load audit trail."));
}
function loadDistributorAccounts() {
  $.getJSON(importApi + "supplier-ledger/suppliers").done(accounts => {
    const table = $('<table class="table table-bordered"><thead><tr><th>Distributor</th><th>Currency balances</th></tr></thead><tbody></tbody></table>');
    (accounts || []).forEach(account => {
      const balances = Object.entries(account.balances || {}).map(([currency, value]) => currency + ": " + Number(value.balance || 0).toFixed(2)).join(" | ") || "No activity";
      table.find("tbody").append($('<tr></tr>').append($('<td></td>').text(account.name), $('<td></td>').text(balances)));
    });
    $("#distributorAccounts").empty().append(table);
  }).fail(() => $("#distributorAccounts").text("Could not load distributor accounts."));
  $.getJSON(importApi + "supplier-ledger/expiry?days=90").done(alerts => {
    const list = $('<ul class="list-group"></ul>');
    (alerts || []).forEach(item => list.append($('<li class="list-group-item"></li>').text(item.productName + " — batch " + item.batchNumber + " — " + item.expiryDate + " — qty " + item.quantity + (item.expired ? " (EXPIRED)" : ""))));
    if (!alerts || !alerts.length) list.append($('<li class="list-group-item"></li>').text("No batches expiring within 90 days."));
    $("#batchExpiryAlerts").empty().append(list);
  }).fail(() => $("#batchExpiryAlerts").text("Could not load expiry alerts."));
}
$(function () {
  const currentPharmaSpotUser = store.get("user") || {};
  const isPharmaSpotAdmin = Number(currentPharmaSpotUser.perm_users) === 1;
  const requestHeaders = {
    "X-Pharmaspot-User": currentPharmaSpotUser.username || "local-session",
    "X-Pharmaspot-User-Id": String(currentPharmaSpotUser._id || "")
  };
  if (currentPharmaSpotUser.sessionToken) requestHeaders.Authorization = "Bearer " + currentPharmaSpotUser.sessionToken;
  $.ajaxSetup({ headers: requestHeaders });
  if (currentPharmaSpotUser && Number(currentPharmaSpotUser.perm_products) === 0) $("#documentImportButton").hide();
  if (!isPharmaSpotAdmin) {
    $("#postPurchaseImport").hide();
    $("a[href=\"#distributorPane\"], a[href=\"#reconciliationPane\"]").closest("li").hide();
  }
  $("#documentImportButton").on("click", () => loadImportProducts(() => {}));
  $("#refreshDistributorAccounts").on("click", loadDistributorAccounts);
  $("#refreshAdminAudit").on("click", loadAdminAuditTrail);
  $("#addReconciliationRow").on("click", addReconciliationRow);
  $("#reconciliationTable").on("click", ".remove-reconciliation-row", function () { $(this).closest("tr").remove(); reconciliationPreviewPayload = null; $("#commitReconciliation").prop("disabled", true); $("#reconciliationPreview").empty(); });
  $("#previewReconciliation").on("click", previewReconciliation);
  $("a[href=\"#reconciliationPane\"]").on("shown.bs.tab", function () { loadReconciliationHistory(); if (!$("#reconciliationTable tbody tr").length) addReconciliationRow(); });
  $("#commitReconciliation").on("click", function () {
    if (!reconciliationPreviewPayload || !reconciliationPreviewPayload.length) return;
    if (!window.confirm("Apply these stock-count adjustments? This will change inventory and create an audit record.")) return;
    const items = reconciliationPreviewPayload.map(row => ({ productId: row.productId, systemQuantity: row.systemQuantity, untrackedSystemQuantity: row.untrackedSystemQuantity, untrackedCount: row.untrackedCount, batchCounts: (row.countedBatches || []).map((batch, index) => ({ batchIndex: batch.batchIndex, batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, systemQuantity: (row.systemBatches || [])[index]?.quantity, countedQuantity: batch.quantity })) }));
    $.ajax({ url: importApi + "supplier-ledger/reconcile/commit", method: "POST", contentType: "application/json", data: JSON.stringify({ confirm: true, items }) })
      .done(result => { window.alert("Stock reconciliation saved. " + result.updated + " product(s) adjusted."); reconciliationPreviewPayload = null; $("#commitReconciliation").prop("disabled", true); $("#reconciliationPreview").empty(); $("#reconciliationTable tbody").empty(); loadReconciliationHistory(); })
      .fail(xhr => { window.alert(xhr.responseJSON?.error || "Reconciliation failed. Preview stock again."); reconciliationPreviewPayload = null; $("#commitReconciliation").prop("disabled", true); });
  });
  $("a[href=\"#distributorPane\"]").on("shown.bs.tab", function () { loadDistributorAccounts(); loadPendingPurchaseDrafts(); loadPurchaseImportHistory(); loadAdminAuditTrail(); });
  $("#saveDistributorPayment").on("click", function () {
    const payload = { supplier: $("#distributorPaymentName").val(), amount: $("#distributorPaymentAmount").val(), currency: $("#distributorPaymentCurrency").val(), reference: $("#distributorPaymentReference").val() };
    if (!payload.supplier || !(Number(payload.amount) > 0)) return window.alert("Enter a distributor and a valid payment amount.");
    if (!window.confirm("Record this payment in the distributor ledger?")) return;
    $.ajax({ url: importApi + "supplier-ledger/payment", method: "POST", contentType: "application/json", data: JSON.stringify(payload) })
      .done(() => { window.alert("Distributor payment recorded."); $("#distributorPaymentAmount,#distributorPaymentReference").val(""); loadDistributorAccounts(); loadAdminAuditTrail(); })
      .fail(xhr => window.alert(xhr.responseJSON?.error || "Could not record payment."));
  });
  $("#importCurrency").on("change", function () {
    $(this).data("user-selected", true);
    updateImportExchangeRate();
  });
  $("#importExchangeRateDate").on("change", function () { $(this).data("user-selected", true); });
  $("#documentImportModal").on("shown.bs.modal", () => loadImportProducts(() => {
    if (!$("#purchaseImportTable tbody tr").length) addPurchaseRow();
  }));
  $("#importCurrency").val(baseCurrency);
  $("#importExchangeRate").val("1");
  if (!$("#importExchangeRateDate").val()) $("#importExchangeRateDate").val(new Date().toISOString().slice(0, 10));
  $("#currencyCode").on("change", function () {
    const symbols = { PKR: "Rs", INR: "₹", USD: "$" };
    $("#symbol").val(symbols[this.value] || this.value);
  });
  $("#addPurchaseImportRow").on("click", addPurchaseRow);
  $("#purchaseImportTable").on("click", ".remove-import-row", function () { $(this).closest("tr").remove(); });
  $("#uploadInvoiceFiles").on("click", () => uploadImportFiles("#invoiceFiles", "#invoiceUploadStatus", result => {
    stagedInvoiceFiles = result.files || [];
    $("#invoiceUploadStatus").text((result.files.length || 0) + " file(s) uploaded. Preparing invoice extraction…");
    loadImportProducts(() => {
      if (!$("#purchaseImportTable tbody tr").length) addPurchaseRow();
      runInvoiceOcr(stagedInvoiceFiles);
    });
  }, "#uploadInvoiceFiles"));
  $("#postPurchaseImport").on("click", function () {
    const items = [];
    $("#purchaseImportTable tbody tr").each(function () {
      const row = $(this);
      items.push({
        sourceDescription: row.find(".import-description").val(),
        productId: row.find(".import-product").val(),
        quantity: row.find(".import-quantity").val(),
        bonusQuantity: row.find(".import-bonus").val() || 0,
        purchasePrice: row.find(".import-cost").val(),
        salePrice: row.find(".import-sale").val(),
        batchNumber: row.find(".import-batch").val(),
        expiryDate: row.find(".import-expiry").val()
      });
    });
    if (!items.length || items.some(item =>
      !item.productId || item.quantity === "" || item.purchasePrice === "" || item.salePrice === "" ||
      !String(item.batchNumber || "").trim() || !String(item.expiryDate || "").trim()
    )) {
      window.alert("Complete every invoice line before posting stock.");
      return;
    }
    if (!window.confirm("Submit this purchase as a draft for approval? Inventory will not change yet.")) return;
    $.ajax({
      url: importApi + "imports/commit-purchase",
      method: "POST",
      contentType: "application/json",
      data: JSON.stringify({
        supplier: $("#importSupplier").val(),
        supplierIdentifier: $("#importSupplierIdentifier").val(),
        invoiceNo: $("#importInvoiceNo").val(),
        invoiceDate: $("#importInvoiceDate").val(),
        currency: $("#importCurrency").val(),
        baseCurrency,
        sourceFiles: stagedInvoiceFiles,
        exchangeRate: $("#importExchangeRate").val(),
        exchangeRateDate: $("#importExchangeRateDate").val(),
        items
      }),
      success: result => {
        if (!result.draftId) return window.alert("Purchase draft was not created.");
        if (!window.confirm("Review the supplier, invoice and all batch details. Approve this draft and post stock now?")) {
          window.alert("Purchase saved as pending approval. No stock was changed.");
          return;
        }
        $.ajax({
          url: importApi + "imports/approve-purchase/" + encodeURIComponent(result.draftId),
          method: "POST",
          contentType: "application/json",
          data: JSON.stringify({ confirm: true, reviewed: true }),
          success: posted => {
            window.alert(posted.success ? "Purchase approved and posted. " + posted.appliedRows + " product line(s) added to stock." : "Purchase approval did not complete.");
            $("#purchaseImportTable tbody").empty();
            $("#importSupplier,#importSupplierIdentifier,#importInvoiceNo,#importInvoiceDate").val("");
            $("#invoiceOcrResults").empty();
            stagedInvoiceFiles = [];
            $("#importExchangeRateDate").val(new Date().toISOString().slice(0, 10));
            $("#importExchangeRateDate").data("user-selected", false);
            loadImportProducts(() => addPurchaseRow());
          },
          error: xhr => window.alert(xhr.responseJSON?.error || "Could not approve purchase. Draft remains available for review.")
        });
      },
      error: xhr => window.alert(xhr.responseJSON?.error || "Could not post this purchase.")
    });
  });
  $("#uploadProductImages").on("click", () => uploadImportFiles("#productImageFiles", "#imageMatchResults", result => {
    stagedImages = result.imageSuggestions || [];
    const container = $("#imageMatchResults").empty();
    if (!stagedImages.length) {
      container.text("No supported product images were found in the selected files.");
      return;
    }
    loadImportProducts(() => {
      stagedImages.forEach(image => {
        const match = image.matches && image.matches[0];
        const card = $('<div class="import-match"></div>');
        card.append($("<strong></strong>").text(image.originalName));
        const select = $('<select class="form-control m-t-10"></select>').html(productOptions(match?.productId));
        const assign = $('<button class="btn btn-success btn-sm m-t-10" type="button">Assign image</button>');
        assign.on("click", () => {
          if (!select.val()) return window.alert("Select the correct product first.");
          $.ajax({
            url: importApi + "imports/assign-image",
            method: "POST",
            contentType: "application/json",
            data: JSON.stringify({ productId: select.val(), storedName: image.storedName }),
            success: () => { assign.prop("disabled", true).text("Image assigned"); },
            error: xhr => window.alert(xhr.responseJSON?.error || "Could not assign image.")
          });
        });
        card.append(select, assign);
        container.append(card);
      });
    });
  }, "#uploadProductImages"));
});
