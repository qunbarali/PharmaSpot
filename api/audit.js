const Datastore = require("@seald-io/nedb");
const path = require("path");
const crypto = require("crypto");
const { hashSessionToken, readBearerToken, isSessionActive } = require("./session-utils");
const dbDir = path.join(process.env.APPDATA, process.env.APPNAME, "server", "databases");
const auditDB = new Datastore({ filename: path.join(dbDir, "admin-audit.db"), autoload: true });
const usersDB = new Datastore({ filename: path.join(dbDir, "users.db"), autoload: true });
const sessionsDB = new Datastore({ filename: path.join(dbDir, "user-sessions.db"), autoload: true });
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
auditDB.ensureIndex({ fieldName: "eventKey", unique: true, sparse: true });
sessionsDB.ensureIndex({ fieldName: "tokenHash", unique: true });

function issueSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const session = {
    tokenHash: hashSessionToken(token),
    userId: Number(userId),
    createdAt: new Date().toISOString(),
    expiresAt
  };
  return new Promise((resolve, reject) => {
    sessionsDB.insert(session, error => error ? reject(error) : resolve({
      token,
      expiresAt: new Date(expiresAt).toISOString()
    }));
  });
}

function authenticateUser(req) {
  const token = readBearerToken(req && req.headers);
  if (!token) return Promise.resolve(null);
  const tokenHash = hashSessionToken(token);
  return new Promise((resolve, reject) => {
    sessionsDB.findOne({ tokenHash }, (sessionError, session) => {
      if (sessionError) return reject(sessionError);
      if (!isSessionActive(session)) {
        if (session) sessionsDB.remove({ tokenHash }, {}, () => {});
        return resolve(null);
      }
      usersDB.findOne({ _id: session.userId }, (userError, user) => {
        if (userError) return reject(userError);
        if (!user || !String(user.status || "").startsWith("Logged In_")) return resolve(null);
        resolve(user);
      });
    });
  });
}

function revokeSession(req) {
  const token = readBearerToken(req && req.headers);
  if (!token) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    sessionsDB.remove({ tokenHash: hashSessionToken(token) }, {}, (error, count) =>
      error ? reject(error) : resolve(count > 0)
    );
  });
}

async function authorizeAdmin(req) {
  const user = await authenticateUser(req);
  if (!user || Number(user.perm_users) !== 1) return null;
  return { id: user._id, username: user.username };
}

async function writeAudit(req, action, entityType, entityId, details) {
  const user = await authenticateUser(req);
  if (!user) throw new Error("A valid signed-in user session is required to write administrator audit events.");
  const event = {
    eventKey: crypto.randomUUID(),
    actor: String(user.username || "unknown").slice(0, 120),
    actorUserId: String(user._id || "").slice(0, 40),
    actorVerification: "verified server-side bearer session",
    action: String(action).slice(0, 80),
    entityType: String(entityType).slice(0, 80),
    entityId: String(entityId || "").slice(0, 160),
    details: details || {},
    source: "PharmaSpot local API",
    createdAt: new Date().toISOString()
  };
  return new Promise((resolve, reject) => {
    auditDB.insert(event, (error, saved) => error ? reject(error) : resolve(saved));
  });
}

module.exports = { auditDB, usersDB, sessionsDB, issueSession, authenticateUser, revokeSession, writeAudit, authorizeAdmin };
