const app = require("express")();
const server = require("http").Server(app);
const bodyParser = require("body-parser");
const Datastore = require("@seald-io/nedb");
const bcrypt = require("bcrypt");
const saltRounds = 10;
const validator = require("validator");
const path = require("path");
const { issueSession, authenticateUser, revokeSession } = require("./audit");
const dbPath = path.join(
    process.env.APPDATA,
    process.env.APPNAME,
    "server",
    "databases",
    "users.db",
);

app.use(bodyParser.json());

module.exports = app;

let usersDB = new Datastore({
    filename: dbPath,
    autoload: true,
});

usersDB.ensureIndex({ fieldName: "username", unique: true });

/**
 * GET endpoint: Get the welcome message for the Users API.
 *
 * @param {Object} req request object.
 * @param {Object} res response object.
 * @returns {void}
 */
app.get("/", function (req, res) {
    res.send("Users API");
});

/**
 * GET endpoint: Get user details by user ID.
 *
 * @param {Object} req request object with user ID as a parameter.
 * @param {Object} res response object.
 * @returns {void}
 */
app.get("/user/:userId", function (req, res) {
    if (!req.params.userId) {
        res.status(500).send("ID field is required.");
    } else {
        usersDB.findOne(
            {
                _id: parseInt(req.params.userId),
            },
            function (err, docs) {
                res.send(docs);
            },
        );
    }
});

/**
 * GET endpoint: Log out a user by updating the user status.
 *
 * @param {Object} req request object with user ID as a parameter.
 * @param {Object} res response object.
 * @returns {void}
 */
app.get("/logout/:userId", async function (req, res) {
    try {
        const authenticated = await authenticateUser(req);
        if (!authenticated || String(authenticated._id) !== String(req.params.userId)) {
            return res.status(401).json({ error: "A valid session for this user is required to log out." });
        }
        await revokeSession(req);
        usersDB.update(
            { _id: authenticated._id },
            { $set: { status: "Logged Out_" + new Date().toISOString() } },
            {},
            (error) => error ? res.status(500).json({ error: "Could not complete logout." }) : res.sendStatus(200)
        );
    } catch (_) {
        res.status(500).json({ error: "Could not complete logout." });
    }
});

/**
 * POST endpoint: Authenticate user credentials and issue an expiring session token.
 */
app.post("/login", async function (req, res) {
    const username = String(req.body && req.body.username || "");
    const password = String(req.body && req.body.password || "");
    if (!username || !password) return res.status(400).json({ auth: false });
    usersDB.findOne({ username: validator.escape(username) }, async function (findError, docs) {
        if (findError) return res.status(500).json({ auth: false, message: "Could not verify login." });
        if (!docs) return res.status(401).json({ auth: false });
        try {
            const valid = await bcrypt.compare(password, docs.password);
            if (!valid) return res.status(401).json({ auth: false });
            await new Promise((resolve, reject) => usersDB.update(
                { _id: docs._id },
                { $set: { status: "Logged In_" + new Date().toISOString() } },
                {},
                error => error ? reject(error) : resolve()
            ));
            const session = await issueSession(docs._id);
            const safeUser = { ...docs };
            delete safeUser.password;
            res.send({ ...safeUser, auth: true, sessionToken: session.token, sessionExpiresAt: session.expiresAt });
        } catch (_) {
            res.status(500).json({ auth: false, message: "Could not create a secure login session." });
        }
    });
});

/**
 * GET endpoint: Get details of all users.
 *
 * @param {Object} req request object.
 * @param {Object} res response object.
 * @returns {void}
 */
app.get("/all", function (req, res) {
    usersDB.find({}, function (err, docs) {
        res.send(docs);
    });
});

/**
 * DELETE endpoint: Delete a user by user ID.
 *
 * @param {Object} req request object with user ID as a parameter.
 * @param {Object} res response object.
 * @returns {void}
 */
app.delete("/user/:userId", function (req, res) {
    usersDB.remove(
        {
            _id: parseInt(req.params.userId),
        },
        function (err, numRemoved) {
            if (err) {
                console.error(err);
                res.status(500).json({
                    error: "Internal Server Error",
                    message: `An unexpected error occurred. ${err}`,
                });
            } else {
                res.sendStatus(200);
            }
        },
    );
});

/**
 * POST endpoint: Create or update a user.
 *
 * @param {Object} req request object with user data in the body.
 * @param {Object} res response object.
 * @returns {void}
 */
app.post("/post", function (req, res) {
    //encrypt password
    bcrypt
        .hash(req.body.password, saltRounds)
        .then((hash) => {
            req.body.password = hash;
            const perms = [
                "perm_products",
                "perm_categories",
                "perm_transactions",
                "perm_users",
                "perm_settings",
            ];

            for (const perm of perms) {
                if (!!req.body[perm]) {
                    req.body[perm] = req.body[perm] === "on" ? 1 : 0;
                } else {
                    //create missing permission only with new users
                    if(req.body.id==="")
                    {
                      req.body[perm] = 0;  
                    }
                    
                }
            }

            let User = {
                ...req.body,
                status: "",
            };
            delete User.id;
            delete User.pass;
            if (req.body.id === "") {
                User._id = Math.floor(Date.now() / 1000);
                usersDB.insert(User, function (err, user) {
                    if (err) {
                        console.error(err);
                        res.status(500).json({
                            error: "Internal Server Error",
                            message: `An unexpected error occurred. ${err}`,
                        });
                    }
                    else {
                        res.send( user);
                    }
                });
            } else {
                usersDB.update(
                    {
                        _id: parseInt(req.body.id),
                    },
                    {
                        $set: User,
                    },
                    {},
                    function (err, numReplaced, user) {
                        if (err) {
                        console.error(err);
                        res.status(500).json({
                            error: "Internal Server Error",
                            message: `An unexpected error occurred. ${err}`,
                        });
                    }
                        else {
                            res.sendStatus(200);
                        }
                    },
                );
            }
        })
        .catch((err) => 
        {
          
                console.error(err);
                res.status(500).json({
                    error: "Internal Server Error",
                    message: `An unexpected error occurred. ${err}`,
                });
        });
});

/**
 * GET endpoint: Check and initialize the default admin user if not exists.
 *
 * @param {Object} req request object.
 * @param {Object} res response object.
 * @returns {void}
 */
app.get("/check", function (req, res) {
    usersDB.findOne(
        {
            _id: 1,
        },
        function (err, docs) {
            if (!docs) {
                bcrypt
                    .hash("admin", saltRounds)
                    .then((hash) => {
                        let user = {
                            _id: 1,
                            username: "admin",
                            fullname: "Administrator",
                            perm_products: 1,
                            perm_categories: 1,
                            perm_transactions: 1,
                            perm_users: 1,
                            perm_settings: 1,
                            status: "",
                        };
                        user.password = hash;
                        usersDB.insert(user, function (err, user) {
                            if (err) {
                                console.error(err);
                                res.status(500).json({
                                    error: "Internal Server Error",
                                    message: `An unexpected error occurred. ${err}`,
                                });
                            }
                        });
                    })
                    .catch((err) => 
                        {
                            console.error(err);
                            res.sendStatus(500).json({
                                    error: "Internal Server Error",
                                    message: `An unexpected error occurred. ${err}`
                                });
                        });
            }
        },
    );
});