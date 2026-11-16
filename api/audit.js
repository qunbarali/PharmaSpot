const Datastore = require("@seald-io/nedb");
const path = require("path");
const dbPath = path.join(process.env.APPDATA, process.env.APPNAME, "server", "databases", "admin-audit.db");
const auditDB = new Datastore({ filename: dbPath, autoload: true });
auditDB.ensureIndex({ fieldName: "eventKey", unique: true, sparse: true });

function writeAudit(req, action, entityType, entityId, details) {
  return new Promise((resolve, reject) => {
    const actor = String(req && req.headers && req.headers["x-pharmaspot-user"] || "local-session").slice(0, 120);
    const event = {
      eventKey: require("crypto").randomUUID(),
      actor,
      actorVerification: "client-session-label; not an authentication credential",
      action: String(action).slice(0, 80),
      entityType: String(entityType).slice(0, 80),
      entityId: String(entityId || "").slice(0, 160),
      details: details || {},
      source: "PharmaSpot local API",
      createdAt: new Date().toISOString()
    };
    auditDB.insert(event, (err, saved) => err ? reject(err) : resolve(saved));
  });
}
module.exports = { auditDB, writeAudit };
