const currencies = new Set(["PKR", "INR", "USD"]);
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("Amounts must be finite non-negative numbers.");
  return Number(n.toFixed(2));
}
function summarizeLedger(entries) {
  const summary = {};
  for (const entry of entries || []) {
    const currency = String(entry.currency || "");
    if (!currencies.has(currency)) continue;
    const value = summary[currency] || { purchases: 0, payments: 0, reversals: 0, balance: 0 };
    const amount = Number(entry.amount) || 0;
    if (entry.type === "purchase") { value.purchases += amount; value.balance += amount; }
    else if (entry.type === "payment") { value.payments += amount; value.balance -= amount; }
    else if (entry.type === "purchase_reversal") { value.reversals += amount; value.balance -= amount; }
    summary[currency] = value;
  }
  return summary;
}
module.exports = { currencies, money, summarizeLedger };
