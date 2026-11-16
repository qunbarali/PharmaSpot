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

function addPurchaseRow() {
  const row = $('<tr>' +
    '<td><select class="form-control import-product">' + productOptions() + '</select></td>' +
    '<td><input class="form-control import-quantity" type="number" min="0.001" step="any" placeholder="Qty"></td>' +
    '<td><input class="form-control import-cost" type="number" min="0" step="0.01" placeholder="0.00"></td>' +
    '<td><input class="form-control import-sale" type="number" min="0" step="0.01" placeholder="0.00"></td>' +
    '<td><input class="form-control import-batch" type="text" placeholder="Batch"></td>' +
    '<td><input class="form-control import-expiry" type="text" placeholder="31-Dec-2027"></td>' +
    '<td><button type="button" class="btn btn-danger btn-xs remove-import-row" title="Remove line">×</button></td>' +
    '</tr>');
  $("#purchaseImportTable tbody").append(row);
}

function runInvoiceOcr(files) {
  const supported = (files || []).filter(file => [".pdf", ".jpg", ".jpeg", ".png", ".webp"].includes(file.type));
  if (!supported.length) return;
  const panel = $("#invoiceOcrResults").empty().append($('<p class="text-muted"></p>').text("Reading invoice documents… OCR suggestions must be checked against the original."));
  supported.forEach(file => {
    $.ajax({ url: importApi + "imports/ocr/" + encodeURIComponent(file.storedName), method: "POST" })
      .done(result => {
        const card = $('<div class="panel panel-default m-t-10"></div>');
        card.append($('<div class="panel-heading"></div>').text(file.originalName + " — OCR draft"));
        const body = $('<div class="panel-body"></div>');
        body.append($('<p></p>').text("Invoice number: " + (result.fields.invoiceNo || "Not detected") + " | Date: " + (result.fields.invoiceDate || "Not detected") + " | Currency: " + (result.fields.currency || "Not detected")));
        if (result.fields.invoiceNo && !$("#importInvoiceNo").val()) $("#importInvoiceNo").val(result.fields.invoiceNo);
        if (result.fields.currency && ["PKR", "INR", "USD"].includes(result.fields.currency) && !$("#importCurrency").data("user-selected")) $("#importCurrency").val(result.fields.currency).trigger("change");
        if (result.rows && result.rows.length) {
          const suggestions = $('<table class="table table-condensed table-bordered"><thead><tr><th>OCR description</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr></thead><tbody></tbody></table>');
          result.rows.forEach(row => suggestions.find("tbody").append($("<tr></tr>").append($("<td></td>").text(row.description), $("<td></td>").text(row.quantity), $("<td></td>").text(row.unitPrice), $("<td></td>").text(row.lineTotal))));
          body.append($('<p class="text-warning"></p>').text("Detected line suggestions only. Match each item to the correct medicine and verify batch, expiry and prices before approval."), suggestions);
        }
        body.append($('<pre style="white-space:pre-wrap;max-height:220px;overflow:auto"></pre>').text(result.text || "No readable text detected."));
        body.append($('<p class="text-warning"></p>').text(result.warning || "Verify all OCR values before posting."));
        card.append(body); panel.append(card);
      })
      .fail(xhr => panel.append($('<p class="text-danger"></p>').text(file.originalName + ": " + (xhr.responseJSON?.error || "OCR failed."))));
  });
}
function uploadImportFiles(inputSelector, statusSelector, onSuccess) {
  const input = document.querySelector(inputSelector);
  if (!input || !input.files || !input.files.length) {
    window.alert("Please select at least one file.");
    return;
  }
  const data = new FormData();
  Array.from(input.files).forEach(file => data.append("files", file));
  $(statusSelector).text("Uploading and checking files…");
  $.ajax({
    url: importApi + "imports/upload",
    method: "POST",
    data,
    processData: false,
    contentType: false,
    success: onSuccess,
    error: xhr => $(statusSelector).text(xhr.responseJSON?.error || "Upload failed.")
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
function loadPendingPurchaseDrafts() {
  $.getJSON(importApi + "imports/pending-purchases").done(drafts => {
    const list = $('<div class="list-group"></div>');
    (drafts || []).forEach(draft => {
      const item = $('<div class="list-group-item"></div>');
      item.append($('<strong></strong>').text(draft.supplier + " — invoice " + draft.invoiceNo));
      item.append($('<p class="small text-muted"></p>').text((draft.items || []).length + " line(s) | " + new Date(draft.createdAt).toLocaleString()));
      const approve = $('<button class="btn btn-success btn-xs" type="button">Approve and post</button>');
      approve.on("click", () => {
        if (!window.confirm("Approve invoice " + draft.invoiceNo + " from " + draft.supplier + " and update stock and supplier balance?")) return;
        $.ajax({ url: importApi + "imports/approve-purchase/" + encodeURIComponent(draft._id), method: "POST", contentType: "application/json", data: JSON.stringify({ confirm: true }) })
          .done(result => { window.alert("Purchase approved. " + result.appliedRows + " line(s) posted."); loadPendingPurchaseDrafts(); loadPurchaseImportHistory(); loadDistributorAccounts(); loadAdminAuditTrail(); })
          .fail(xhr => window.alert(xhr.responseJSON?.error || "Could not approve this purchase."));
      });
      item.append(approve); list.append(item);
    });
    if (!list.children().length) list.text("No purchase drafts awaiting approval.");
    $("#pendingPurchaseDrafts").empty().append(list);
  }).fail(xhr => $("#pendingPurchaseDrafts").text(xhr.status === 403 ? "Administrator account required to view pending approvals." : "Could not load pending purchase approvals."));
}
function loadPurchaseImportHistory() {
  $.getJSON(importApi + "imports/history").done(records => {
    const list = $('<div class="list-group"></div>');
    (records || []).filter(record => ["posted", "reversed"].includes(record.status) && record.type !== "purchase_draft").forEach(record => {
      const item = $('<div class="list-group-item"></div>');
      item.append($('<strong></strong>').text(record.supplier + " — invoice " + record.invoiceNo + " — " + record.status));
      item.append($('<p class="small text-muted"></p>').text(new Date(record.createdAt).toLocaleString() + " | " + (record.items || []).length + " line(s)"));
      const reverse = $('<button class="btn btn-warning btn-xs" type="button">Reverse purchase</button>');
      reverse.prop("disabled", record.status !== "posted");
      if (record.status === "reversed") reverse.text("Already reversed");
      reverse.on("click", () => {
        const reason = window.prompt("Enter the reason for reversing invoice " + record.invoiceNo + ". Reversal is blocked if any purchased batch has changed or been sold.");
        if (!reason || !reason.trim()) return;
        if (!window.confirm("Reverse this purchase and adjust stock and distributor balance?")) return;
        $.ajax({ url: importApi + "imports/reverse-purchase/" + encodeURIComponent(record._id), method: "POST", contentType: "application/json", data: JSON.stringify({ confirm: true, reason }) })
          .done(() => { window.alert("Purchase reversal completed."); loadPurchaseImportHistory(); loadDistributorAccounts(); loadAdminAuditTrail(); })
          .fail(xhr => window.alert(xhr.responseJSON?.error || "Purchase reversal was blocked."));
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
      const summary = event.action + " — " + event.entityType + " " + event.entityId + " — " + event.actor + " — " + new Date(event.createdAt).toLocaleString();
      list.append($('<li class="list-group-item"></li>').text(summary));
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
  $.ajaxSetup({ headers: { "X-Pharmaspot-User": currentPharmaSpotUser.username || "local-session", "X-Pharmaspot-User-Id": String(currentPharmaSpotUser._id || "") } });
  if (currentPharmaSpotUser && Number(currentPharmaSpotUser.perm_products) === 0) $("#documentImportButton").hide();
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
    if (this.value === baseCurrency) { $("#importExchangeRate").val("1"); return; }
    const configuredForeignPerBase = Number((appSettings.exchangeRates || {})[this.value] || 0);
    $("#importExchangeRate").val(configuredForeignPerBase > 0 ? (1 / configuredForeignPerBase).toFixed(6) : "");
  });
  $("#documentImportModal").on("shown.bs.modal", () => loadImportProducts(() => {
    if (!$("#purchaseImportTable tbody tr").length) addPurchaseRow();
  }));
  $("#importCurrency").val(baseCurrency);
  $("#importExchangeRate").val("1");
  $("#currencyCode").on("change", function () {
    const symbols = { PKR: "Rs", INR: "₹", USD: "$" };
    $("#symbol").val(symbols[this.value] || this.value);
  });
  $("#addPurchaseImportRow").on("click", addPurchaseRow);
  $("#purchaseImportTable").on("click", ".remove-import-row", function () { $(this).closest("tr").remove(); });
  $("#uploadInvoiceFiles").on("click", () => uploadImportFiles("#invoiceFiles", "#invoiceUploadStatus", result => {
    stagedInvoiceFiles = result.files || [];
    $("#invoiceUploadStatus").text(result.note || "Files staged. Enter and verify invoice details below.");
    runInvoiceOcr(stagedInvoiceFiles);
    loadImportProducts(() => { if (!$("#purchaseImportTable tbody tr").length) addPurchaseRow(); });
  }));
  $("#postPurchaseImport").on("click", function () {
    const items = [];
    $("#purchaseImportTable tbody tr").each(function () {
      const row = $(this);
      items.push({
        productId: row.find(".import-product").val(),
        quantity: row.find(".import-quantity").val(),
        purchasePrice: row.find(".import-cost").val(),
        salePrice: row.find(".import-sale").val(),
        batchNumber: row.find(".import-batch").val(),
        expiryDate: row.find(".import-expiry").val()
      });
    });
    if (!items.length || items.some(item => !item.productId || !item.quantity || !item.purchasePrice || !item.salePrice || !item.batchNumber || !item.expiryDate)) {
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
        invoiceNo: $("#importInvoiceNo").val(),
        currency: $("#importCurrency").val(),
        baseCurrency,
        sourceFiles: stagedInvoiceFiles,
        exchangeRate: $("#importExchangeRate").val(),
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
          data: JSON.stringify({ confirm: true }),
          success: posted => {
            window.alert(posted.success ? "Purchase approved and posted. " + posted.appliedRows + " product line(s) added to stock." : "Purchase approval did not complete.");
            $("#purchaseImportTable tbody").empty();
            $("#importSupplier,#importInvoiceNo").val("");
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
  }));
});
