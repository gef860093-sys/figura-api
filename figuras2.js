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
const rateLimit = require('express-rate-limit'); 

const c = { g: '\x1b[32m', b: '\x1b[36m', y: '\x1b[33m', r: '\x1b[31m', p: '\x1b[35m', rst: '\x1b[0m' };
const logTime = () => `[${new Date().toLocaleTimeString('th-TH')}]`;

process.on('uncaughtException', (err) => {});
process.on('unhandledRejection', (reason) => {});

const PORT = 80; 
const LIMIT_BYTES = 10 * 1024 * 1024; 
const ENABLE_WHITELIST = true; 

// 🌐 API Bridge
const API_URL = "https://bigavatar.dpdns.org/api.php";
const API_KEY = "k0936738325@";

// 🌟 ข้อความหลัก (MOTD & Welcome Message) ที่จัดโค้ดสีใหม่ให้สวยงาม
const MOTD_MESSAGE = "§b§lขอขอบคุณที่ใช้บริการนะคับ §f§l- §a§lดูรายละเอียดเพิ่มเติมได้ที่: §e§nhttps://dash.faydar.eu.cc";

const avatarsDir = path.join(__dirname, "avatars");
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir);

const app = express();
app.set('trust proxy', 1);
app.use(cors());

const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 2000, message: { error: "Too many requests." } });
app.use('/api/', apiLimiter);

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
let sqlWhitelist = new Set();

const fastAxios = axios.create({
    timeout: 10000, 
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 100, rejectUnauthorized: false })
});

function formatUuid(uuid) { 
    if (!uuid || uuid.length !== 32) return uuid || "";
    return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

setInterval(() => { 
    const now = Date.now();
    for (let [id, data] of server_ids.entries()) {
        if (now - data.time > 60000) server_ids.delete(id); 
    }
}, 5 * 60 * 1000);

// ⚡ ซิงค์ข้อมูลกับ API อย่างรวดเร็ว (ทุกๆ 1 วินาที)
async function syncData() {
    try {
        const formData = new URLSearchParams();
        formData.append('key', API_KEY);
        formData.append('action', 'get_lists');

        const res = await axios.post(API_URL, formData.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 3000
        });

        if (res.data && !res.data.error) {
            sqlBlacklist = new Set(res.data.blacklist);
            if (ENABLE_WHITELIST) sqlWhitelist = new Set(res.data.whitelist);
        }

        for (const [ws, tokenStr] of tokenMap.entries()) {
            const userInfo = tokens.get(tokenStr);
            if (!userInfo) continue;

            const uname = userInfo.username.toLowerCase();
            if (sqlBlacklist.has(uname) || (ENABLE_WHITELIST && !sqlWhitelist.has(uname))) {
                ws.terminate(); 
                tokens.delete(tokenStr);
                tokenMap.delete(ws);
                hashCache.delete(userInfo.uuid);
                fsp.unlink(path.join(__dirname, 'avatars', `${userInfo.uuid}.moon`)).catch(() => {}); 
                if (wsMap.has(userInfo.uuid)) wsMap.delete(userInfo.uuid);
            }
        }
    } catch (e) {} 
}
setInterval(syncData, 1000);
syncData();

async function updateUUID(username, uuid) {
    try {
        const formData = new URLSearchParams();
        formData.append('key', API_KEY);
        formData.append('action', 'update_uuid');
        formData.append('username', username);
        formData.append('uuid', uuid);
        await axios.post(API_URL, formData.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    } catch(e) {}
}

// 🌟 นำข้อความ MOTD ที่ตั้งไว้ไปใช้ใน API
app.get('/api/motd', (req, res) => res.status(200).send(MOTD_MESSAGE));
app.get('/api/version', (req, res) => res.json({"release":"0.1.5", "prerelease":"0.1.5"}));
app.get('/api/limits', (req, res) => res.json({"rate": { "pingSize": 1048576, "pingRate": 4096, "equip": 0, "download": 999999999999, "upload": 99999999999 }, "limits": { "maxAvatarSize": LIMIT_BYTES, "maxAvatars": 100, "allowedBadges": { "special": Array(15).fill(0), "pride": Array(30).fill(0) } }}));

app.get('/api/auth/id', (req, res) => {
    const uname = req.query.username.toLowerCase();
    if (sqlBlacklist.has(uname)) return res.status(403).send("รอพิจารณาหรือ/ถาวร");
    if (ENABLE_WHITELIST && !sqlWhitelist.has(uname)) return res.status(403).send("ไปขอ whitelisted สำหรับทางโปรเจคเท่านั้น");

    const serverID = crypto.randomBytes(16).toString('hex');
    server_ids.set(serverID, { username: req.query.username, time: Date.now() });
    res.send(serverID);
});

app.get('/api/auth/verify', async (req, res) => {
    try {
        const sid = req.query.id;
        const sessionData = server_ids.get(sid);
        if (!sessionData) return res.status(404).json({ error: 'Auth failed' });
        
        const response = await fastAxios.get("https://sessionserver.mojang.com/session/minecraft/hasJoined", {
            params: { username: sessionData.username, serverId: sid }
        });
        
        server_ids.delete(sid); 
        const token = crypto.randomBytes(16).toString('hex');
        const hexUuid = response.data.id;
        const premiumUuid = formatUuid(hexUuid);
        const uname = response.data.name.toLowerCase();
        
        tokens.set(token, { 
            uuid: premiumUuid, hexUuid: hexUuid, username: response.data.name,
            clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            projectInfo: req.headers['user-agent'] || 'Unknown Tool'
        });
        
        updateUUID(uname, premiumUuid); 
        
        console.log(`${c.b}${logTime()} ⚡ [LOGIN] ${c.g}${response.data.name} ${c.p}[${premiumUuid}]${c.rst}`);
        res.send(token);
    } catch (error) { res.status(500).json({ error: 'Auth Error' }); }
});

app.post('/api/equip', (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end(); 
    if (wsMap.has(userInfo.uuid)) {
        const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); Buffer.from(userInfo.hexUuid, 'hex').copy(buffer, 1);
        wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
    }
    res.send("success");
});

app.put('/api/avatar', (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    
    let contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > LIMIT_BYTES) return res.status(413).end();

    const tempFile = path.join(__dirname, 'avatars', `${userInfo.uuid}.moon.tmp`);
    const finalFile = path.join(__dirname, 'avatars', `${userInfo.uuid}.moon`);
    const writeStream = fs.createWriteStream(tempFile);
    const hash = crypto.createHash('sha256');

    req.on('data', chunk => { hash.update(chunk); writeStream.write(chunk); });
    req.on('end', () => writeStream.end());
    req.on('aborted', () => { writeStream.destroy(); fsp.unlink(tempFile).catch(()=>{}); });

    writeStream.on('finish', async () => {
        try {
            await fsp.rename(tempFile, finalFile);
            hashCache.set(userInfo.uuid, hash.digest('hex')); 
            if (wsMap.has(userInfo.uuid)) {
                const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); Buffer.from(userInfo.hexUuid, 'hex').copy(buffer, 1);
                wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
            }
            res.send("success"); 
        } catch (err) { res.status(500).send({ error: "File error" }); }
    });
});

app.delete('/api/avatar', async (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    try {
        await fsp.unlink(path.join(__dirname, 'avatars', `${userInfo.uuid}.moon`)); 
        hashCache.delete(userInfo.uuid);
        if (wsMap.has(userInfo.uuid)) {
            const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); Buffer.from(userInfo.hexUuid, 'hex').copy(buffer, 1);
            wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
        }
        res.send("success");
    } catch (err) { res.status(404).end(); }
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
    const uuidStr = req.params.uuid;
    if (["motd", "version", "auth", "limits", "stats-secret"].includes(uuidStr)) return res.status(404).end();
    const uuid = formatUuid(uuidStr);
    if (!uuid) return res.status(404).end();

    const data = { uuid: uuid, rank: "normal", equipped: [], lastUsed: new Date().toISOString(), equippedBadges: { special: Array(15).fill(0), pride: Array(30).fill(0) }, version: "0.1.5", banned: false };
    let fileHash = hashCache.get(uuid);
    const avatarFile = path.join(__dirname, 'avatars', `${uuid}.moon`);
    
    if (!fileHash) {
        try {
            await fsp.access(avatarFile);
            const fileBuffer = await fsp.readFile(avatarFile);
            fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
            hashCache.set(uuid, fileHash);
        } catch (e) {}
    }
    if (fileHash) data.equipped.push({ id: 'avatar', owner: uuid, hash: fileHash });
    res.json(data);
});

// 🌟 ส่งข้อความตอบกลับเมื่อเข้าผ่านเบราว์เซอร์
app.get('/', (req, res) => { res.status(200).send(MOTD_MESSAGE); });

// ==========================================
// ⚡ WEBSOCKET (ป้องกันเกมตัดสาย)
// ==========================================
const server = http.createServer(app);
server.keepAliveTimeout = 120000; 
server.headersTimeout = 125000;

const wss = new WebSocket.Server({ server, perMessageDeflate: false });

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            if (data.length > LIMIT_BYTES + 5000000) return; 

            if (Buffer.isBuffer(data)) {
                const type = data[0];
                if (type === 0) {
                    tokenMap.set(ws, data.slice(1).toString('utf-8'));
                    if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from([0]));
                }
                else if (type === 1) { 
                    const userInfo = tokens.get(tokenMap.get(ws));
                    if (!userInfo) return;
                    
                    const dataLen = data.length;
                    const newbuffer = Buffer.allocUnsafe(22 + (dataLen - 6));
                    newbuffer.writeUInt8(0, 0); Buffer.from(userInfo.hexUuid, 'hex').copy(newbuffer, 1); 
                    newbuffer.writeInt32BE(data.readInt32BE(1), 17); newbuffer.writeUInt8(data.readUInt8(5) !== 0 ? 1 : 0, 21); 
                    data.slice(6).copy(newbuffer, 22);
                    
                    const connections = wsMap.get(userInfo.uuid);
                    if (connections) { connections.forEach(tws => { if (tws.readyState === WebSocket.OPEN && (newbuffer.readUInt8(21) === 1 || tws !== ws)) tws.send(newbuffer); }); }
                }
                else if (type === 2 || type === 3) {
                    const uuidHex = data.slice(1, 17).toString('hex');
                    const uuid = formatUuid(uuidHex);
                    if (type === 2) { if (!wsMap.has(uuid)) wsMap.set(uuid, new Set()); wsMap.get(uuid).add(ws); 
                    } else { if (wsMap.has(uuid)) wsMap.get(uuid).delete(ws); }
                }
            }
        } catch (e) {} 
    });
    
    ws.on('error', () => {}); 
    ws.on('close', () => {
        const token = tokenMap.get(ws);
        if (token && tokens.has(token)) {
            const uuid = tokens.get(token).uuid;
            if (wsMap.has(uuid)) { wsMap.get(uuid).delete(ws); if (wsMap.get(uuid).size === 0) wsMap.delete(uuid); }
        }
        tokenMap.delete(ws);
    });
});

// ⚡ ยิง Ping ทุก 10 วินาที เพื่อเลี้ยงสายไว้ให้ลื่นไหล ไม่มีหลุด
const interval = setInterval(() => { wss.clients.forEach((ws) => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }); }, 10000); 
wss.on('close', () => clearInterval(interval));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${c.p}==========================================${c.rst}`);
    console.log(`${c.b}🚀 BIGAVTAR CLOUD - PERFECT EDITION${c.rst}`);
    console.log(`${c.g}✅ API Link: ${API_URL}${c.rst}`);
    console.log(`${c.p}==========================================${c.rst}\n`);
});
