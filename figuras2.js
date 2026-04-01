const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const cors = require('cors');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const rateLimit = require('express-rate-limit');

// ================= CONFIG =================
const PORT = process.env.PORT || 8080;
const LIMIT_BYTES = 25 * 1024 * 1024;
const ADMIN_PASSWORD = "k0936738325@";

// ================= SAFE LOG =================
process.on('uncaughtException', err => console.error("CRASH:", err));
process.on('unhandledRejection', err => console.error("REJECTION:", err));

// ================= DATABASE =================
const dbPool = mysql.createPool({
    host: 'poland.nami-ch.com',
    user: 'figura_blacklist1',
    password: 'kOj_W1gm*6qbjqz2',
    database: 'spongfan_figura_blacklist',
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

// ================= APP =================
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// ================= RATE LIMIT =================
app.use('/api/', rateLimit({
    windowMs: 60000,
    max: 2000
}));

// ================= FIX URL =================
app.use((req, res, next) => {
    if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
    next();
});

// ================= MEMORY =================
const server_ids = new Map();
const tokens = new Map();
const tokenMap = new Map();
const wsMap = new Map();
const hashCache = new Map();
let sqlBlacklist = new Set();

// ================= FOLDER =================
if (!fs.existsSync("avatars")) fs.mkdirSync("avatars");

// ================= FAST AXIOS =================
const fastAxios = axios.create({
    timeout: 7000,
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false })
});

// ================= KEEP DB ALIVE =================
setInterval(async () => {
    try { await dbPool.query('SELECT 1'); }
    catch (e) { console.error("DB reconnecting..."); }
}, 60000);

// ================= HEALTH =================
app.get('/', (req, res) => res.send("OK"));
app.get('/ping', (req, res) => res.send("pong"));

// ================= BASIC API =================
app.get('/api/version', (req, res) => res.json({ release: "0.1.5" }));

app.get('/api/auth/id', (req, res) => {
    const id = crypto.randomBytes(16).toString('hex');
    server_ids.set(id, { username: req.query.username, time: Date.now() });
    res.send(id);
});

app.get('/api/auth/verify', async (req, res) => {
    try {
        const sid = req.query.id;
        const session = server_ids.get(sid);
        if (!session) return res.status(404).end();

        const response = await fastAxios.get("https://sessionserver.mojang.com/session/minecraft/hasJoined", {
            params: { username: session.username, serverId: sid }
        });

        const token = crypto.randomBytes(16).toString('hex');
        tokens.set(token, {
            uuid: response.data.id,
            username: response.data.name
        });

        server_ids.delete(sid);
        res.send(token);
    } catch {
        res.status(500).end();
    }
});

// ================= AVATAR =================
app.put('/api/avatar', (req, res) => {
    const user = tokens.get(req.headers['token']);
    if (!user) return res.status(401).end();

    const file = path.join(__dirname, 'avatars', `${user.uuid}.moon`);
    const stream = fs.createWriteStream(file);

    req.pipe(stream);
    req.on('end', () => res.send("ok"));
});

// ================= WEBSOCKET =================
const server = http.createServer(app);

const wss = new WebSocket.Server({
    server,
    perMessageDeflate: false
});

// heartbeat
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('connection', ws => {
    ws.isAlive = true;

    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', data => {
        try {
            if (Buffer.isBuffer(data)) {
                const type = data[0];

                if (type === 0) {
                    tokenMap.set(ws, data.slice(1).toString());
                }

                if (type === 1) {
                    const token = tokenMap.get(ws);
                    const user = tokens.get(token);
                    if (!user) return;

                    if (wsMap.has(user.uuid)) {
                        wsMap.get(user.uuid).forEach(c => {
                            if (c.readyState === WebSocket.OPEN) {
                                c.send(data);
                            }
                        });
                    }
                }

                if (type === 2) {
                    const uuid = data.slice(1).toString('hex');
                    if (!wsMap.has(uuid)) wsMap.set(uuid, new Set());
                    wsMap.get(uuid).add(ws);
                }

                if (type === 3) {
                    const uuid = data.slice(1).toString('hex');
                    if (wsMap.has(uuid)) wsMap.get(uuid).delete(ws);
                }
            }
        } catch (e) {}
    });

    ws.on('close', () => tokenMap.delete(ws));
});

// ================= TIMEOUT =================
server.timeout = 120000;
server.keepAliveTimeout = 120000;

// ================= START =================
server.listen(PORT, '0.0.0.0', () => {
    console.log("🔥 SERVER RUNNING ON PORT", PORT);
});
