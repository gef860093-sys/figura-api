require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const cors = require('cors');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const Redis = require('ioredis');

const c = { g: '\x1b[32m', b: '\x1b[36m', y: '\x1b[33m', r: '\x1b[31m', p: '\x1b[35m', rst: '\x1b[0m' };
const logTime = () => `[${new Date().toLocaleTimeString('th-TH')}]`;

process.on('uncaughtException', (err) => console.error(`${c.r}${logTime()} ⚠️ [CRASH PREVENTED] Error: ${err.message}${c.rst}`));
process.on('unhandledRejection', (reason) => console.error(`${c.r}${logTime()} ⚠️ [CRASH PREVENTED] Rejection: ${reason}${c.rst}`));

const PORT = process.env.PORT || 8080;
const LIMIT_BYTES = 35 * 1024 * 1024;
const MC_SAFE_LIMIT = 31000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "k0936738325@";

const dbPool = mysql.createPool({
    host: process.env.DB_HOST || 'poland.nami-ch.com',
    user: process.env.DB_USER || 'figura_blacklist1',
    password: process.env.DB_PASSWORD || 'kOj_W1gm*6qbjqz2',
    database: process.env.DB_NAME || 'spongfan_figura_blacklist',
    waitForConnections: true,
    connectionLimit: 50
});

const avatarsDir = path.join(__dirname, 'avatars');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());
app.use(express.json());

app.use('/api/', rateLimit({ windowMs: 60000, max: 2000 }));
app.use((req, res, next) => {
    if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
    next();
});

const server_ids = new Map();
const tokens = new Map();
const tokenMap = new Map();
const wsMap = new Map();
const hashCache = new Map();
let sqlBlacklist = new Set();
const fastAxios = axios.create({ timeout: 7000 });

function formatUuid(uuid) {
    if (!uuid || uuid.length !== 32) return uuid || "";
    return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

let pub;
if (process.env.REDIS_URL) {
    pub = new Redis(process.env.REDIS_URL);
    const sub = new Redis(process.env.REDIS_URL);
    sub.subscribe("ws-broadcast");
    sub.on("message", (channel, msg) => {
        const buffer = Buffer.from(msg, "base64");
        const uuid = formatUuid(buffer.slice(1, 17).toString('hex'));
        if (wsMap.has(uuid)) {
            wsMap.get(uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
        }
    });
}

setInterval(() => {
    const now = Date.now();
    for (let [id, data] of server_ids.entries()) if (now - data.time > 60000) server_ids.delete(id);
}, 600000);

async function syncBlacklist() {
    try {
        const [rows] = await dbPool.query('SELECT username FROM figura_blacklist');
        sqlBlacklist = new Set(rows.map(r => r.username.toLowerCase()));
    } catch (e) {}
}
setInterval(syncBlacklist, 30000);
syncBlacklist();

app.get('/', (req, res) => res.send("BIGAVTAR CLOUD ONLINE"));
app.get('/api/motd', (req, res) => res.send("§b§l💎 BIGAVTAR ONLINE"));
app.get('/ping', (req, res) => res.send('ok'));

app.get('/api/auth/id', (req, res) => {
    const user = req.query.username?.toLowerCase();
    if (sqlBlacklist.has(user)) return res.status(403).send("BANNED");
    const sid = crypto.randomBytes(16).toString('hex');
    server_ids.set(sid, { username: req.query.username, time: Date.now() });
    res.send(sid);
});

app.get('/api/auth/verify', async (req, res) => {
    const sid = req.query.id;
    const session = server_ids.get(sid);
    if (!session) return res.status(404).end();
    try {
        const resp = await fastAxios.get("https://sessionserver.mojang.com/session/minecraft/hasJoined", { params: { username: session.username, serverId: sid } });
        const token = crypto.randomBytes(16).toString('hex');
        const userData = { uuid: formatUuid(resp.data.id), hexUuid: resp.data.id, username: resp.data.name, clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress, project: req.headers['user-agent'] || 'Figura' };
        tokens.set(token, userData);
        server_ids.delete(sid);
        res.send(token);
    } catch (e) { res.status(500).end(); }
});

app.put('/api/avatar', (req, res) => {
    const user = tokens.get(req.headers['token']);
    if (!user) return res.status(401).end();
    if (parseInt(req.headers['content-length'] || '0') > LIMIT_BYTES) return res.status(413).end();

    const filePath = path.join(avatarsDir, `${user.uuid}.moon`);
    const writeStream = fs.createWriteStream(filePath);
    req.pipe(writeStream);
    writeStream.on('finish', () => {
        hashCache.delete(user.uuid);
        const buffer = Buffer.allocUnsafe(17);
        buffer.writeUInt8(2, 0);
        Buffer.from(user.hexUuid, 'hex').copy(buffer, 1);
        if (pub) pub.publish("ws-broadcast", buffer.toString("base64"));
        if (wsMap.has(user.uuid)) wsMap.get(user.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
        res.send("success");
    });
});

app.get('/api/:uuid/avatar', async (req, res) => {
    const uuid = req.params.uuid;
    if (["motd", "version", "auth", "limits"].includes(uuid)) return res.status(404).end();
    const filePath = path.join(avatarsDir, `${formatUuid(uuid)}.moon`);
    try {
        await fsp.access(filePath);
        res.sendFile(filePath);
    } catch (e) { res.status(404).end(); }
});

app.get('/admin', (req, res) => {
    if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).send("Forbidden");
    res.send(`
        <html><body><h1>BIGAVTAR DASHBOARD</h1><div id="stats"></div>
        <script>
            async function update(){
                const res = await fetch('/api/stats-secret?pw=${ADMIN_PASSWORD}');
                const d = await res.json();
                document.getElementById('stats').innerHTML = 'Online: ' + d.stats.online + ' | RAM: ' + d.stats.ram + 'MB';
            }
            setInterval(update, 3000); update();
        </script></body></html>
    `);
});

app.get('/api/stats-secret', (req, res) => {
    if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).end();
    const ut = process.uptime();
    res.json({
        players: Array.from(tokens.values()).map(p => ({ name: p.username, ip: p.clientIp, project: p.project })),
        stats: { online: tokenMap.size, ram: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), uptime: Math.floor(ut/3600) + 'h' }
    });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);
    ws.on('message', (data) => {
        try {
            if (!Buffer.isBuffer(data)) return;
            const type = data[0];
            if (type === 0) {
                tokenMap.set(ws, data.slice(1).toString('utf-8'));
                ws.send(Buffer.from([0]));
            } else if (type === 1) {
                if (data.length > MC_SAFE_LIMIT) return; 
                const user = tokens.get(tokenMap.get(ws));
                if (!user) return;
                const relay = Buffer.allocUnsafe(22 + (data.length - 6));
                relay.writeUInt8(0, 0);
                Buffer.from(user.hexUuid, 'hex').copy(relay, 1);
                data.slice(6).copy(relay, 22);
                if (pub) pub.publish("ws-broadcast", relay.toString("base64"));
                if (wsMap.has(user.uuid)) {
                    wsMap.get(user.uuid).forEach(tws => { if (tws !== ws && tws.readyState === WebSocket.OPEN) tws.send(relay); });
                }
            } else if (type === 2) {
                const uuid = formatUuid(data.slice(1, 17).toString('hex'));
                if (!wsMap.has(uuid)) wsMap.set(uuid, new Set());
                wsMap.get(uuid).add(ws);
            }
        } catch (e) {}
    });
    ws.on('close', () => {
        const token = tokenMap.get(ws);
        const user = tokens.get(token);
        if (user && wsMap.has(user.uuid)) wsMap.get(user.uuid).delete(ws);
        tokenMap.delete(ws);
    });
});

setInterval(() => {
    wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000);

server.listen(PORT, '0.0.0.0', () => console.log('Server started'));
