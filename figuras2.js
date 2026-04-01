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
const compression = require('compression'); 
const Redis = require('ioredis');

const c = { g: '\x1b[32m', b: '\x1b[36m', y: '\x1b[33m', r: '\x1b[31m', p: '\x1b[35m', rst: '\x1b[0m' };
const logTime = () => `[${new Date().toLocaleTimeString('th-TH')}]`;

process.on('uncaughtException', (err) => { 
    console.error(`${c.r}${logTime()} ⚠️ Error: ${err.message}${c.rst}`); 
});

const PORT = process.env.PORT || 8080; 
const LIMIT_BYTES = 35 * 1024 * 1024; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; 

const avatarsDir = path.join(__dirname, 'avatars');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

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
app.use(compression());

// 🔥 [FIX] แก้ไขปัญหาเครื่องหมาย // ซ้อนกันใน URL ที่ทำให้เกม Disconnected
app.use((req, res, next) => {
    if (req.url.includes('//')) {
        req.url = req.url.replace(/\/{2,}/g, '/');
    }
    next();
});

const tokens = new Map();
const tokenMap = new Map(); 
const wsMap = new Map(); 

// 🚀 Redis Publisher/Subscriber (ใช้ ioredis)
const pub = new Redis(process.env.REDIS_URL);
const sub = new Redis(process.env.REDIS_URL);

sub.subscribe("ws-broadcast");
sub.on("message", (channel, msg) => {
    const buffer = Buffer.from(msg, "base64");
    if (buffer.length >= 17) {
        const uuidHex = buffer.slice(1, 17).toString('hex');
        const uuid = `${uuidHex.slice(0,8)}-${uuidHex.slice(8,12)}-${uuidHex.slice(12,16)}-${uuidHex.slice(16,20)}-${uuidHex.slice(20)}`;
        if (wsMap.has(uuid)) {
            wsMap.get(uuid).forEach(ws => { if (ws.readyState === 1) ws.send(buffer); });
        }
    }
});

// ==========================================
// 🌐 API ROUTES
// ==========================================

app.get('/api/auth/id', (req, res) => {
    const serverID = crypto.randomBytes(16).toString('hex');
    res.send(serverID);
});

app.get('/api/motd', (req, res) => res.send("§b§l💎 BIGAVTAR §a§lONLINE"));

app.get('/api/:uuid/avatar', async (req, res) => { 
    const avatarFile = path.join(avatarsDir, `${req.params.uuid}.moon`);
    try {
        await fsp.access(avatarFile); 
        res.setHeader('Content-Type', 'application/json'); 
        res.sendFile(avatarFile);
    } catch (e) { res.status(404).end(); }
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
            if (Buffer.isBuffer(data) && data[0] === 0) {
                tokenMap.set(ws, data.slice(1).toString('utf-8'));
                ws.send(Buffer.from([0]));
            }
        } catch (e) {}
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`${c.g}🚀 BIGAVTAR CLOUD OMEGA LIVE ON PORT ${PORT}${c.rst}`);
});
