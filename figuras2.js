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
const isProd = process.env.NODE_ENV === 'production';

// 🛑 ป้องกันเซิร์ฟเวอร์ดับ
process.on('uncaughtException', (err) => { 
    fs.appendFileSync("error.log", `${logTime()} [Uncaught] ${err.stack}\n`);
    console.error(`${c.r}${logTime()} ⚠️ Error: ${err.message}${c.rst}`); 
});
process.on('unhandledRejection', (reason) => { 
    fs.appendFileSync("error.log", `${logTime()} [Rejection] ${reason}\n`);
    console.error(`${c.r}${logTime()} ⚠️ Rejection: ${reason}${c.rst}`); 
});

const PORT = process.env.PORT || 8080; 
const LIMIT_BYTES = 35 * 1024 * 1024; // ✅ รองรับ 35MB
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; 

// 📁 ตั้งค่าโฟลเดอร์เก็บสกิน (สำคัญ: ต้องใช้ Absolute Path เพื่อไม่ให้ไฟล์หาย)
const avatarsDir = path.join(__dirname, 'avatars');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

// 🗄️ MySQL Database
const dbPool = mysql.createPool({
    host: process.env.DB_HOST, 
    user: process.env.DB_USER, 
    password: process.env.DB_PASS, 
    database: process.env.DB_NAME, 
    waitForConnections: true,
    connectionLimit: 50
});

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(compression()); // ✅ บีบอัดข้อมูลให้ส่งโมเดลเร็วขึ้น

const apiLimiter = rateLimit({ windowMs: 60000, max: 2000 });
app.use('/api/', apiLimiter);

// 🧠 การจัดการหน่วยความจำ
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

function fastSend(connections, data, excludeWs = null) {
    if (!connections) return;
    for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN && ws !== excludeWs) {
            ws.send(data, { binary: true }, () => {}); 
        }
    }
}

// 🚀 ระบบ Redis Scale-Out
let pub, sub;
if (process.env.REDIS_URL) {
    pub = new Redis(process.env.REDIS_URL);
    sub = new Redis(process.env.REDIS_URL);
    sub.subscribe("ws-broadcast");
    sub.on("message", (channel, msg) => {
        if (channel === "ws-broadcast") {
            const buffer = Buffer.from(msg, "base64");
            if (buffer.length >= 17) {
                const uuid = formatUuid(buffer.slice(1, 17).toString('hex'));
                fastSend(wsMap.get(uuid), buffer); 
            }
        }
    });
}

function broadcast(buffer) {
    if (pub) pub.publish("ws-broadcast", buffer.toString("base64"));
}

// ==========================================
// 🌐 API ROUTES
// ==========================================

app.get('/api/motd', (req, res) => res.send("§b§l💎 FIGURA CLOUD §a§lONLINE"));

app.get('/api/auth/verify', async (req, res) => {
    try {
        const sessionData = server_ids.get(req.query.id);
        if (!sessionData) return res.status(404).end();
        const response = await fastAxios.get("https://sessionserver.mojang.com/session/minecraft/hasJoined", { params: { username: sessionData.username, serverId: req.query.id } });
        const token = crypto.randomBytes(16).toString('hex');
        tokens.set(token, { uuid: formatUuid(response.data.id), hexUuid: response.data.id, username: response.data.name, lastActive: Date.now() });
        res.send(token);
    } catch (e) { res.status(500).end(); }
});

app.put('/api/avatar', (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    const finalFile = path.join(avatarsDir, `${userInfo.uuid}.moon`);
    const writeStream = fs.createWriteStream(finalFile);
    req.pipe(writeStream);
    req.on('end', () => {
        hashCache.delete(userInfo.uuid);
        res.send("success");
    });
});

app.get('/api/:uuid/avatar', async (req, res) => { 
    const avatarFile = path.join(avatarsDir, `${formatUuid(req.params.uuid)}.moon`);
    try {
        await fsp.access(avatarFile); 
        res.setHeader('Content-Type', 'application/json'); 
        res.sendFile(avatarFile);
    } catch (e) { res.status(404).end(); }
});

app.get('/api/:uuid', async (req, res) => {
    const uuid = formatUuid(req.params.uuid);
    const data = { uuid, rank: "normal", equipped: [], lastUsed: new Date().toISOString() };
    const avatarFile = path.join(avatarsDir, `${uuid}.moon`);
    try {
        const fileBuffer = await fsp.readFile(avatarFile);
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        data.equipped.push({ id: 'avatar', owner: uuid, hash });
        res.json(data);
    } catch (e) { res.json(data); }
});

app.get('/ping', (req, res) => res.send('ok'));

// ==========================================
// ⚡ WEBSOCKET
// ==========================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            if (!Buffer.isBuffer(data)) return;
            const type = data[0];
            if (type === 0) {
                tokenMap.set(ws, data.slice(1).toString('utf-8'));
                ws.send(Buffer.from([0]));
            } else if (type === 1) {
                const userInfo = tokens.get(tokenMap.get(ws));
                if (!userInfo) return;
                const newbuffer = Buffer.allocUnsafe(22 + (data.length - 6));
                newbuffer.writeUInt8(0, 0); 
                Buffer.from(userInfo.hexUuid, 'hex').copy(newbuffer, 1); 
                data.slice(6).copy(newbuffer, 22);
                if (pub) broadcast(newbuffer);
                else fastSend(wsMap.get(userInfo.uuid), newbuffer, ws);
            } else if (type === 2) {
                const uuid = formatUuid(data.slice(1, 17).toString('hex'));
                if (!wsMap.has(uuid)) wsMap.set(uuid, new Set());
                wsMap.get(uuid).add(ws);
            }
        } catch (e) {}
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${c.g}🚀 FIGURA CLOUD ENTERPRISE LIVE ON PORT ${PORT}${c.rst}\n`);
});
