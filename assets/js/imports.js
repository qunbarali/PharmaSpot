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

$(function () {
  if (store.get("user") && Number(store.get("user").perm_products) === 0) $("#documentImportButton").hide();
  $("#documentImportButton").on("click", () => loadImportProducts(() => {}));
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
    if (!window.confirm("Post these purchase lines and increase stock? This action changes inventory.")) return;
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
        window.alert("Purchase imported. " + result.appliedRows + " product line(s) added to stock.");
        $("#purchaseImportTable tbody").empty();
        $("#importSupplier,#importInvoiceNo").val("");
        loadImportProducts(() => addPurchaseRow());
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
