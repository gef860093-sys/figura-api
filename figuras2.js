const express = require('express');
const http = require('http'); 
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const cors = require('cors');
const crypto = require('crypto');

const c = { g: '\x1b[32m', b: '\x1b[36m', r: '\x1b[31m', rst: '\x1b[0m' };
const logTime = () => `[${new Date().toLocaleTimeString('th-TH')}]`;

process.on('uncaughtException', (err) => {});
process.on('unhandledRejection', (reason) => {});

// ==========================================
// ⚙️ การตั้งค่าเซิร์ฟเวอร์ (นำไปรันบน IP ผู้เช่า)
// ==========================================
const PORT = 80; 

// 🌐 ลิงก์เชื่อมโยงไปยังเว็บหลักของคุณ (ตรวจสอบให้ตรงกับเว็บปัจจุบัน)
const API_URL = "https://bigavatar.dpdns.org/api.php"; 

// 🔑 นำ API Key จากหน้าแดชบอร์ดมาใส่ที่นี่ (แจกให้ผู้เช่าแต่ละคนไม่เหมือนกัน)
const API_KEY = "ใส่_API_KEY_จากหน้าเว็บที่นี่ครับ"; 

const ENABLE_WHITELIST = true; 
const LIMIT_BYTES = 10 * 1024 * 1024; 
const WELCOME_MSG = "§b§lขอขอบคุณที่ใช้บริการนะคับ §f§l- §a§lดูรายละเอียดเพิ่มเติมได้ที่: §e§nhttps://dash.faydar.eu.cc";
// ==========================================

const avatarsDir = path.join(__dirname, "avatars");
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir);

const app = express();
app.use(cors());

let sqlBlacklist = new Set();
let sqlWhitelist = new Set();
const tokens = new Map();
const tokenMap = new Map(); 
const wsMap = new Map();
const userActivity = new Map(); 

// ⚡ ซิงค์ข้อมูลกับเว็บ 1 วิ และส่งข้อมูล Heartbeat
async function syncAndMonitor() {
    try {
        const resList = await axios.post(API_URL, new URLSearchParams({key: API_KEY, action: 'get_lists'}).toString());
        if (resList.data && !resList.data.error) {
            sqlBlacklist = new Set(resList.data.blacklist);
            sqlWhitelist = new Set(resList.data.whitelist);
        }

        const onlineData = [];
        for (let [ws, tokenStr] of tokenMap.entries()) {
            const user = tokens.get(tokenStr);
            if (user) {
                const uname = user.username.toLowerCase();
                onlineData.push({ name: user.username, activity: userActivity.get(user.username) || "ในเกม", last_size: user.lastSize || 0 });
                // ถ้าหลุดจาก Whitelist เตะออกทันที
                if (sqlBlacklist.has(uname) || (ENABLE_WHITELIST && !sqlWhitelist.has(uname))) {
                    ws.terminate();
                }
            }
        }
        if (onlineData.length > 0) {
            await axios.post(API_URL, new URLSearchParams({key: API_KEY, action: 'heartbeat', data: JSON.stringify(onlineData)}).toString());
        }
    } catch (e) {}
}
setInterval(syncAndMonitor, 1000); 

app.put('/api/avatar', (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    
    const size = parseInt(req.headers['content-length'] || '0');
    userInfo.lastSize = size;
    
    if (size > LIMIT_BYTES) {
        userActivity.set(userInfo.username, "❌ ไฟล์ใหญ่เกิน 10MB!");
        return res.status(413).end();
    }
    
    userActivity.set(userInfo.username, "📤 กำลังอัปโหลดโมเดล...");
    const tempFile = path.join(__dirname, 'avatars', `${userInfo.uuid}.moon.tmp`);
    const finalFile = path.join(__dirname, 'avatars', `${userInfo.uuid}.moon`);
    const writeStream = fs.createWriteStream(tempFile);
    
    req.on('data', chunk => writeStream.write(chunk));
    req.on('end', () => writeStream.end());
    
    writeStream.on('finish', async () => {
        try {
            await fsp.rename(tempFile, finalFile);
            userActivity.set(userInfo.username, "✅ อัปโหลดสำเร็จ!");
            if (wsMap.has(userInfo.uuid)) {
                const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); Buffer.from(userInfo.hexUuid, 'hex').copy(buffer, 1);
                wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
            }
            res.send("success"); 
        } catch (err) { res.status(500).send({ error: "File error" }); }
    });
});

app.post('/api/equip', (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (userInfo) userActivity.set(userInfo.username, "👕 สวมใส่ชุด");
    if (userInfo && wsMap.has(userInfo.uuid)) {
        const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); Buffer.from(userInfo.hexUuid, 'hex').copy(buffer, 1);
        wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
    }
    res.send("success");
});

app.get('/api/motd', (req, res) => res.send(WELCOME_MSG));
app.get('/api/version', (req, res) => res.json({"release":"0.1.5", "prerelease":"0.1.5"}));
app.get('/api/auth/id', (req, res) => {
    const uname = req.query.username.toLowerCase();
    if (sqlBlacklist.has(uname) || (ENABLE_WHITELIST && !sqlWhitelist.has(uname))) return res.status(403).send("NO_PERMISSION");
    res.send(crypto.randomBytes(16).toString('hex'));
});
app.get('/api/auth/verify', async (req, res) => {
    try {
        const sid = req.query.id;
        const response = await axios.get(`https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${req.query.username}&serverId=${sid}`);
        const token = crypto.randomBytes(16).toString('hex');
        const hexUuid = response.data.id;
        tokens.set(token, { uuid: formatUuid(hexUuid), hexUuid: hexUuid, username: response.data.name, lastSize: 0 });
        console.log(`${c.b}${logTime()} ⚡ [LOGIN] ${c.g}${response.data.name}${c.rst}`);
        res.send(token);
    } catch (error) { res.status(500).json({ error: 'Auth Error' }); }
});
app.get('/api/:uuid/avatar', async (req, res) => { 
    const uuidStr = req.params.uuid;
    if (["motd", "version", "auth", "limits", "stats-secret"].includes(uuidStr)) return res.status(404).end();
    const avatarFile = path.join(__dirname, 'avatars', `${formatUuid(uuidStr)}.moon`);
    try {
        await fsp.access(avatarFile); 
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.sendFile(avatarFile);
    } catch (e) { res.status(404).end(); }
});
app.get('/api/:uuid', async (req, res) => {
    const uuid = formatUuid(req.params.uuid);
    if (!uuid) return res.status(404).end();
    const data = { uuid: uuid, rank: "normal", equipped: [], lastUsed: new Date().toISOString(), equippedBadges: { special: Array(15).fill(0), pride: Array(30).fill(0) }, version: "0.1.5", banned: false };
    const avatarFile = path.join(__dirname, 'avatars', `${uuid}.moon`);
    try {
        await fsp.access(avatarFile);
        const fileBuffer = await fsp.readFile(avatarFile);
        data.equipped.push({ id: 'avatar', owner: uuid, hash: crypto.createHash('sha256').update(fileBuffer).digest('hex') });
    } catch (e) {}
    res.json(data);
});
app.delete('/api/avatar', async (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    try {
        await fsp.unlink(path.join(__dirname, 'avatars', `${userInfo.uuid}.moon`)); 
        if (wsMap.has(userInfo.uuid)) {
            const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); Buffer.from(userInfo.hexUuid, 'hex').copy(buffer, 1);
            wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
        }
        res.send("success");
    } catch (err) { res.status(404).end(); }
});
app.get('/', (req, res) => res.status(200).send(WELCOME_MSG));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 🛡️ ป้องกันตัดสาย (Ping 5 วิ)
setInterval(() => { wss.clients.forEach((ws) => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }); }, 5000); 
wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            if (Buffer.isBuffer(data) && data[0] === 0) {
                tokenMap.set(ws, data.slice(1).toString('utf-8'));
                if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from([0]));
            }
            else if (Buffer.isBuffer(data) && data[0] === 2) {
                const uuidHex = data.slice(1, 17).toString('hex');
                const uuid = formatUuid(uuidHex);
                if (!wsMap.has(uuid)) wsMap.set(uuid, new Set()); wsMap.get(uuid).add(ws); 
            }
            else if (Buffer.isBuffer(data) && data[0] === 3) {
                const uuidHex = data.slice(1, 17).toString('hex');
                const uuid = formatUuid(uuidHex);
                if (wsMap.has(uuid)) wsMap.get(uuid).delete(ws);
            }
        } catch(e) {}
    });
    ws.on('close', () => { 
        const token = tokenMap.get(ws);
        if (token && tokens.has(token)) {
            const uuid = tokens.get(token).uuid;
            if (wsMap.has(uuid)) { wsMap.get(uuid).delete(ws); if (wsMap.get(uuid).size === 0) wsMap.delete(uuid); }
        }
        tokenMap.delete(ws); 
    });
});

function formatUuid(uuid) { 
    if (!uuid || uuid.length !== 32) return uuid || "";
    return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${c.b}==========================================${c.rst}`);
    console.log(`${c.g}🚀 BIGAVTAR CLOUD - RENTER EDITION${c.rst}`);
    console.log(`${c.b}🔑 Operating with API Key Security${c.rst}`);
    console.log(`${c.b}==========================================${c.rst}\n`);
});
