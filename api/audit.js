const Datastore = require("@seald-io/nedb");
const path = require("path");
const dbPath = path.join(process.env.APPDATA, process.env.APPNAME, "server", "databases", "admin-audit.db");
const auditDB = new Datastore({ filename: dbPath, autoload: true });
const usersDB = new Datastore({ filename: path.join(process.env.APPDATA, process.env.APPNAME, "server", "databases", "users.db"), autoload: true });
auditDB.ensureIndex({ fieldName: "eventKey", unique: true, sparse: true });

function writeAudit(req, action, entityType, entityId, details) {
  return new Promise((resolve, reject) => {
    const actor = String(req && req.headers && req.headers["x-pharmaspot-user"] || "local-session").slice(0, 120);
    const event = {
      eventKey: require("crypto").randomUUID(),
      actor,
      actorUserId: String(req && req.headers && req.headers["x-pharmaspot-user-id"] || "").slice(0, 40),
      actorVerification: "local app user label; local API does not issue cryptographic sessions",
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
function authorizeAdmin(req) {
  return new Promise((resolve, reject) => {
    const id = Number(req && req.headers && req.headers["x-pharmaspot-user-id"]);
    if (!Number.isSafeInteger(id) || id <= 0) return resolve(null);
    usersDB.findOne({ _id: id }, (err, user) => {
      if (err) return reject(err);
      if (!user || Number(user.perm_users) !== 1 || !String(user.status || "").startsWith("Logged In_")) return resolve(null);
      resolve({ id: user._id, username: user.username });
    });
  });
}
module.exports = { auditDB, writeAudit, authorizeAdmin };
