require('dotenv').config(); // ✅ โหลด ENV (ถ้ามี)
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
const compression = require('compression'); 

// 🎨 Console colors
const c = { g: '\x1b[32m', b: '\x1b[36m', y: '\x1b[33m', r: '\x1b[31m', p: '\x1b[35m', rst: '\x1b[0m' };
const logTime = () => `[${new Date().toLocaleTimeString('th-TH')}]`;

process.on('uncaughtException', (err) => { 
    console.error(`${c.r}${logTime()} ⚠️ [CRASH PREVENTED] Error: ${err.message}${c.rst}`); 
});
process.on('unhandledRejection', (reason) => { 
    console.error(`${c.r}${logTime()} ⚠️ [CRASH PREVENTED] Rejection: ${reason}${c.rst}`); 
});

// ✅ แก้ไข: ใช้ PORT จาก Render Environment
const PORT = process.env.PORT || 8080; 
// ✅ แก้ไข: ขยายลิมิตเป็น 35MB สำหรับโมเดลขนาดใหญ่
const LIMIT_BYTES = 35 * 1024 * 1024; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "k0936738325@";

// 🗄️ MySQL Database setup
const dbPool = mysql.createPool({
    host: 'poland.nami-ch.com', 
    user: 'figura_blacklist1', 
    password: process.env.DB_PASSWORD || 'kOj_W1gm*6qbjqz2', 
    database: 'spongfan_figura_blacklist', 
    waitForConnections: true,
    connectionLimit: 50, 
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

// ✅ แก้ไข: ตรวจสอบและสร้างโฟลเดอร์เก็บสกินให้ชัวร์
const avatarsDir = path.join(__dirname, 'avatars');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(compression()); // ✅ เพิ่ม Gzip บีบอัดข้อมูลให้ส่งโมเดลเร็วขึ้น

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 2000, 
    message: { error: "Too many requests, please try again later." }
});
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

const fastAxios = axios.create({
    timeout: 7000, 
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 100, rejectUnauthorized: false })
});

function formatUuid(uuid) { 
    if (!uuid || uuid.length !== 32) return uuid || "";
    return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

// 🧹 Auto-GC Server Cleanup ทุก 5 นาที
setInterval(() => { 
    if (global.gc) global.gc(); 
    const now = Date.now();
    for (let [id, data] of server_ids.entries()) {
        if (now - data.time > 60000) server_ids.delete(id); 
    }
}, 5 * 60 * 1000);

// ==========================================
// ⚡ ระบบ ACTIVE KICK 
// ==========================================
async function syncBlacklistAndKick() {
    try {
        const [rows] = await dbPool.query('SELECT username FROM figura_blacklist');
        sqlBlacklist = new Set(rows.map(r => r.username.toLowerCase()));

        for (const [ws, tokenStr] of tokenMap.entries()) {
            const userInfo = tokens.get(tokenStr);
            if (userInfo && sqlBlacklist.has(userInfo.username.toLowerCase())) {
                ws.terminate(); 
                tokens.delete(tokenStr);
                tokenMap.delete(ws);
                hashCache.delete(userInfo.uuid);
                
                const avatarFile = path.join(avatarsDir, `${userInfo.uuid}.moon`);
                fsp.unlink(avatarFile).catch(() => {}); 
                
                if (wsMap.has(userInfo.uuid)) wsMap.delete(userInfo.uuid);
                console.log(`${c.r}${logTime()} ⛔ [ACTIVE BAN] Kicked: ${userInfo.username}${c.rst}`);
            }
        }
    } catch (e) {} 
}
setInterval(syncBlacklistAndKick, 30000); 
syncBlacklistAndKick();

// ==========================================
// 🌐 REST API
// ==========================================

app.get('/api/motd', (req, res) => {
    res.status(200).send("§b§l💎 BIGAVTAR §a§lONLINE §e§l(BY chick_chiix)\n§f§lULTIMATE - เร็ว แรง ทะลุนรก!");
});

app.get('/api/version', (req, res) => res.json({"release":"0.1.5", "prerelease":"0.1.5"}));

app.get('/api/limits', (req, res) => {
    res.json({
        "rate": { "pingSize": 1048576, "pingRate": 4096, "equip": 0, "download": 999999999999, "upload": 99999999999 },
        "limits": { "maxAvatarSize": LIMIT_BYTES, "maxAvatars": 100, "allowedBadges": { "special": Array(15).fill(0), "pride": Array(30).fill(0) } }
    });
});

app.get('/api/auth/id', (req, res) => {
    if (sqlBlacklist.has(req.query.username.toLowerCase())) return res.status(403).send("BANNED");
    const serverID = crypto.randomBytes(16).toString('hex');
    server_ids.set(serverID, { username: req.query.username, time: Date.now() });
    res.send(serverID);
});

app.get('/api/auth/verify', async (req, res) => {
    try {
        const sid = req.query.id;
        const sessionData = server_ids.get(sid);
        if (!sessionData || sqlBlacklist.has(sessionData.username.toLowerCase())) return res.status(404).json({ error: 'Auth failed' });
        
        const response = await fastAxios.get("https://sessionserver.mojang.com/session/minecraft/hasJoined", {
            params: { username: sessionData.username, serverId: sid }
        });
        
        server_ids.delete(sid); 
        const token = crypto.randomBytes(16).toString('hex');
        const hexUuid = response.data.id;
        
        tokens.set(token, { 
            uuid: formatUuid(hexUuid), 
            hexUuid: hexUuid, 
            username: response.data.name,
            clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            projectInfo: req.headers['user-agent'] || 'Unknown Tool'
        });
        
        console.log(`${c.b}${logTime()} ⚡ [LOGIN] ${c.y}${response.data.name}${c.rst}`);
        res.send(token);
    } catch (error) { res.status(500).json({ error: 'Internal Error' }); }
});

app.post('/api/equip', (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end(); 
    
    if (wsMap.has(userInfo.uuid)) {
        const buffer = Buffer.allocUnsafe(17); 
        buffer.writeUInt8(2, 0); 
        Buffer.from(userInfo.hexUuid, 'hex').copy(buffer, 1);
        wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
    }
    res.send("success");
});

app.put('/api/avatar', (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    
    let contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > LIMIT_BYTES) return res.status(413).end();

    const tempFile = path.join(avatarsDir, `${userInfo.uuid}.moon.tmp`);
    const finalFile = path.join(avatarsDir, `${userInfo.uuid}.moon`);
    const writeStream = fs.createWriteStream(tempFile);
    const hash = crypto.createHash('sha256');

    req.on('data', chunk => { hash.update(chunk); writeStream.write(chunk); });
    req.on('end', () => writeStream.end());
    req.on('aborted', () => { writeStream.destroy(); fsp.unlink(tempFile).catch(()=>{}); });

    writeStream.on('finish', async () => {
        try {
            await fsp.rename(tempFile, finalFile);
            const finalHash = hash.digest('hex');
            hashCache.set(userInfo.uuid, finalHash); 
            
            if (wsMap.has(userInfo.uuid)) {
                const buffer = Buffer.allocUnsafe(17); 
                buffer.writeUInt8(2, 0); 
                Buffer.from(userInfo.hexUuid, 'hex').copy(buffer, 1);
                wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
            }
            res.send("success"); 
        } catch (err) { res.status(500).send({ error: "File error" }); }
    });
});

app.get('/api/:uuid/avatar', async (req, res) => { 
    const uuidStr = req.params.uuid;
    if (["motd", "version", "auth", "limits", "stats-secret"].includes(uuidStr)) return res.status(404).end();

    const uuidFmt = formatUuid(uuidStr);
    const avatarFile = path.join(avatarsDir, `${uuidFmt}.moon`);
    try {
        await fsp.access(avatarFile); 
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Content-Type', 'application/json'); 
        res.sendFile(avatarFile);
    } catch (e) { res.status(404).end(); }
});

app.get('/api/:uuid', async (req, res) => {
    const uuidStr = req.params.uuid;
    if (["motd", "version", "auth", "limits", "stats-secret"].includes(uuidStr)) return res.status(404).end();

    const uuid = formatUuid(uuidStr);
    if (!uuid) return res.status(404).end();

    const data = {
        uuid: uuid, rank: "normal", equipped: [], lastUsed: new Date().toISOString(),
        equippedBadges: { special: Array(15).fill(0), pride: Array(30).fill(0) },
        version: "0.1.5", banned: false
    };

    let fileHash = hashCache.get(uuid);
    const avatarFile = path.join(avatarsDir, `${uuid}.moon`);
    
    if (!fileHash) {
        try {
            await fsp.access(avatarFile);
            const hash = crypto.createHash('sha256');
            const fileBuffer = await fsp.readFile(avatarFile);
            fileHash = hash.update(fileBuffer).digest('hex');
            hashCache.set(uuid, fileHash);
        } catch (e) {}
    }
    
    if (fileHash) data.equipped.push({ id: 'avatar', owner: uuid, hash: fileHash });
    res.json(data);
});

app.get('/ping', (req, res) => res.send('ok'));
app.get('/health', (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

app.get('/', (req, res) => {
    res.status(200).send("§b§lBIGAVTAR CLOUD §f§l- §a§lONLINE");
});

// ==========================================
// ⚡ WEBSOCKET 
// ==========================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
        try {
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
                    newbuffer.writeUInt8(0, 0); 
                    Buffer.from(userInfo.hexUuid, 'hex').copy(newbuffer, 1); 
                    newbuffer.writeInt32BE(data.readInt32BE(1), 17); 
                    newbuffer.writeUInt8(data.readUInt8(5) !== 0 ? 1 : 0, 21); 
                    data.slice(6).copy(newbuffer, 22);
                    
                    const connections = wsMap.get(userInfo.uuid);
                    if (connections) { 
                        connections.forEach(tws => { 
                            if (tws.readyState === WebSocket.OPEN && (newbuffer.readUInt8(21) === 1 || tws !== ws)) { 
                                tws.send(newbuffer); 
                            } 
                        }); 
                    }
                }
                else if (type === 2 || type === 3) {
                    const uuidHex = data.slice(1, 17).toString('hex');
                    const uuid = formatUuid(uuidHex);
                    if (type === 2) { 
                        if (!wsMap.has(uuid)) wsMap.set(uuid, new Set()); 
                        wsMap.get(uuid).add(ws); 
                    } else { 
                        if (wsMap.has(uuid)) wsMap.get(uuid).delete(ws); 
                    }
                }
            }
        } catch (e) {} 
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${c.b}🚀 BIGAVTAR CLOUD - READY FOR PRODUCTION${c.rst}`);
    console.log(`${c.g}✅ Port: ${PORT} | Limit: 35MB${c.rst}\n`);
});
