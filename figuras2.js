require('dotenv').config();
const express = require('express');
const http = require('http'); 
const WebSocket = require('ws');
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

const PORT = process.env.PORT || 8080; 
const LIMIT_BYTES = 35 * 1024 * 1024; // ✅ ขยายรองรับไฟล์ใหญ่
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; 

// ✅ ใช้ Absolute Path เพื่อป้องกันปัญหาหาโฟลเดอร์ไม่เจอ
const avatarsDir = path.join(__dirname, 'avatars');
if (!fs.existsSync(avatarsDir)) {
    fs.mkdirSync(avatarsDir, { recursive: true });
}

const dbPool = mysql.createPool({
    host: process.env.DB_HOST, 
    user: process.env.DB_USER, 
    password: process.env.DB_PASS, 
    database: process.env.DB_NAME, 
    waitForConnections: true,
    connectionLimit: 50
});

const app = express();
app.use(cors());
app.use(compression());

const tokens = new Map();
const tokenMap = new Map(); 
const wsMap = new Map(); 
const hashCache = new Map();

function formatUuid(uuid) { 
    if (!uuid || uuid.length !== 32) return uuid || "";
    return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

// 🌐 API สำหรับดึงไฟล์โมเดล (จุดที่ทำให้เกิด ?)
app.get('/api/:uuid/avatar', async (req, res) => { 
    const uuidStr = req.params.uuid;
    if (["motd", "version", "auth", "limits"].includes(uuidStr)) return res.status(404).end();
    
    const avatarFile = path.join(avatarsDir, `${formatUuid(uuidStr)}.moon`);
    try {
        await fsp.access(avatarFile); 
        res.setHeader('Content-Type', 'application/json'); 
        res.sendFile(avatarFile);
    } catch (e) {
        res.status(404).end(); // ❌ ถ้าไฟล์หายจะส่ง 404 ทำให้เกมขึ้น ?
    }
});

app.get('/api/:uuid', async (req, res) => {
    const uuid = formatUuid(req.params.uuid);
    const data = { uuid: uuid, rank: "normal", equipped: [], lastUsed: new Date().toISOString(), version: "0.1.5" };
    const avatarFile = path.join(avatarsDir, `${uuid}.moon`);
    
    try {
        await fsp.access(avatarFile);
        const fileBuffer = await fsp.readFile(avatarFile);
        const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        data.equipped.push({ id: 'avatar', owner: uuid, hash: fileHash });
        res.json(data);
    } catch (e) {
        res.json(data); // ส่งข้อมูลเปล่าถ้าไม่มีไฟล์
    }
});

// ... ส่วนอื่นๆ ของโค้ด (WebSocket/Auth) เหมือนเดิม ...
app.get('/ping', (req, res) => res.send('ok'));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
// (ใส่ระบบ WebSocket ของคุณต่อที่นี่)

server.listen(PORT, '0.0.0.0', () => {
    console.log(`${c.g}${logTime()} 🚀 BIGAVTAR CLOUD LIVE ON PORT ${PORT}${c.rst}`);
});
