const crypto = require("crypto");

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}
function readBearerToken(headers) {
  const value = String(headers && headers.authorization || "");
  const match = value.match(/^Bearer ([a-f0-9]{64})$/i);
  return match ? match[1] : "";
}
function isSessionActive(session, now = Date.now()) {
  return !!session && Number.isFinite(Number(session.expiresAt)) && Number(session.expiresAt) > now;
}
module.exports = { hashSessionToken, readBearerToken, isSessionActive };
