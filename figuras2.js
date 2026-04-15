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
const os = require('os'); 
const { EventEmitter } = require('events');

// 🌟 [ENTERPRISE SECURITY MODULES]
const helmet = require('helmet');
const compression = require('compression');
const hpp = require('hpp');

// 🚀 ปลดล็อกขีดจำกัด Event Listeners รองรับ Scalability
EventEmitter.defaultMaxListeners = 15000;

// 🎨 ตัวแปรจัดการสี
const c = { g: '\x1b[32m', b: '\x1b[36m', y: '\x1b[33m', r: '\x1b[31m', p: '\x1b[35m', rst: '\x1b[0m' };
const logTime = () => `[${new Date().toLocaleTimeString('th-TH')}]`;
const startTime = Date.now();

// 📝 ระบบ Logging แบบ Production
const logFile = fs.createWriteStream(path.join(__dirname, 'server.log'), { flags: 'a' });
const logger = {
    info: (msg) => { console.log(msg); logFile.write(`INFO ${logTime()}: ${msg.replace(/\x1b\[[0-9;]*m/g, '')}\n`); },
    error: (msg) => { console.error(msg); logFile.write(`ERROR ${logTime()}: ${msg.replace(/\x1b\[[0-9;]*m/g, '')}\n`); }
};

process.on('uncaughtException', (err) => { logger.error(`${c.r}[Fatal Protected] ${err.stack}${c.rst}`); });
process.on('unhandledRejection', (reason) => { logger.error(`${c.r}[Promise Protected] ${reason}${c.rst}`); });

// ==========================================
// ⚙️ SERVER CONFIG (V22 MASTERCRAFT)
// ==========================================
const PORT = 80; 
const LIMIT_BYTES = 35 * 1024 * 1024; // ลิมิตขนาด 35MB
const ENABLE_WHITELIST = true; 
const TOKEN_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 ชั่วโมง

const DISCORD_WEBHOOK_URL = "https://ptb.discord.com/api/webhooks/1493712415831887955/-DO5NvlZUp83EDkr7JQb13QHdrTNeveugQwXy2Ni74fxxbbw4PYcuQHqoUgs2Q7cOaz-"; 
const API_URL = "https://bigavatar.dpdns.org/api.php"; 
const API_KEY = "b9a23abea9240f3f2fc325a3e623f8f0"; 

const SERVER_ZONE = "TH"; 
const ZONE_INFO = {
    "TH": { webFlag: "🇹🇭", mcFlag: "[TH]", name: "Thailand", ping: "< 20 ms" },
    "SG": { webFlag: "🇸🇬", mcFlag: "[SG]", name: "Singapore", ping: "20-50 ms" },
    "JP": { webFlag: "🇯🇵", mcFlag: "[JP]", name: "Japan", ping: "80-120 ms" }
};
const currentZone = ZONE_INFO[SERVER_ZONE] || ZONE_INFO["TH"];

const MOTD_MESSAGE = 
    `§8§m                                        §r\n` +
    `  §3§l✦ §b§lB§3§lI§b§lG§3§lA§b§lV§3§lA§b§lT§3§lA§b§lR §f§lC§7§lL§f§lO§7§lU§f§lD §b§l✦\n` +
    `§8§m                                        §r\n` +
    `§a ✔ §aสถานะ: §fออนไลน์ (Figura 2.0)\n` +
    `§e ⚑ §eโซนเซิร์ฟเวอร์: §f${currentZone.mcFlag} ${currentZone.name} §7(Ping ${currentZone.ping})\n` +
    `§d ⚙ §dระบบป้องกัน: §fAnti-Crash & DDoS Protection ใช้งานอยู่\n` +
    `§c ➤ §cรายละเอียดเพิ่มเติมที่: §nhttps://dash.faydar.eu.cc\n` +
    `§8§m                                        §r`;

const SYNC_INTERVAL_MS = 15000;    
const WS_PING_INTERVAL_MS = 25000; 
const DASHBOARD_PASS = "admin123"; 

const avatarsDir = path.join(__dirname, "avatars");
const backupDir = path.join(__dirname, "avatars_backup");
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

const app = express();
app.set('trust proxy', 1);

// ==========================================
// 🛡️ MIDDLEWARES
// ==========================================
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false })); 
app.use(hpp()); 

app.use(compression({ 
    threshold: 512, filter: (req, res) => req.headers['content-type'] === 'application/octet-stream' ? false : compression.filter(req, res)
}));

app.use((req, res, next) => {
    if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/'); 
    res.setTimeout(30000, () => res.status(408).end()); 
    next(); 
});

app.use(express.raw({ limit: '35mb', type: '*/*' })); 

const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, message: { error: "Rate Limit Exceeded" } });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: "Uploads Limited" } }); 

app.use('/api/', (req, res, next) => { 
    if (req.path === '/avatar' && req.method === 'PUT') return uploadLimiter(req, res, next); 
    next(); 
}, apiLimiter);

// ==========================================
// 🧠 LRU CACHE CLASS
// ==========================================
class LRUCache {
    constructor(limit) { this.map = new Map(); this.limit = limit; }
    get(key) {
        if (!this.map.has(key)) return undefined;
        const val = this.map.get(key);
        this.map.delete(key); this.map.set(key, val);
        return val;
    }
    set(key, val) {
        if (this.map.has(key)) this.map.delete(key);
        else if (this.map.size >= this.limit) this.map.delete(this.map.keys().next().value);
        this.map.set(key, val);
    }
    delete(key) { return this.map.delete(key); }
    has(key) { return this.map.has(key); }
}

// ==========================================
// 🗄️ STATE MANAGEMENT
// ==========================================
const server_ids = new LRUCache(1000);
const tokens = new Map(); 
const wsMap = new Map(); 
let hashCache = new LRUCache(3000); 
let apiJsonCache = new LRUCache(3000); 
const userActivity = new Map(); 
const spamTracker = new Map();

let sqlBlacklist = new Set();
let sqlWhitelist = new Set();
let isSyncing = false; 
let isMaintenanceMode = false;
let lastMaintenanceState = false;

const dbFile = path.join(__dirname, 'statsDB.json');
let serverStats = { totalLogins: 0, totalUploads: 0, totalBytes: 0 };
if (fs.existsSync(dbFile)) { try { serverStats = JSON.parse(fs.readFileSync(dbFile)); } catch(e) {} }
const saveStatsDB = () => fsp.writeFile(dbFile, JSON.stringify(serverStats)).catch(()=>{});

const fastAxios = axios.create({
    timeout: 15000, 
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 1000 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 1000 }) 
});

const sendToDiscord = (message) => { if (DISCORD_WEBHOOK_URL) fastAxios.post(DISCORD_WEBHOOK_URL, { content: message }).catch(() => {}); };
const isValidUUID = (uuid) => /^[0-9a-fA-F-]{32,36}$/.test(uuid);
const formatUuid = (uuid) => {
    if (!uuid) return "";
    const clean = uuid.replace(/-/g, '').toLowerCase(); // บังคับตัวเล็กเสมอ
    return clean.length === 32 ? `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}` : uuid;
};

// 🌟 [ระบบใหม่] ฟังก์ชันกระจายข้อมูลหาคนดู (ลดโค้ดซ้ำและเพิ่มความเสถียร)
const broadcastToWatchers = (uuid, buffer, excludeWs = null) => {
    const watchers = wsMap.get(uuid);
    if (!watchers) return;
    watchers.forEach(tws => {
        if (tws === excludeWs) return; // ไม่ส่งกลับไปหาคนส่ง (กรณีไม่ใช่ Global)
        try {
            if (tws.readyState === WebSocket.OPEN && tws.bufferedAmount < 1048576) {
                tws.send(buffer, { binary: true });
            } else if (tws.readyState !== WebSocket.OPEN) {
                watchers.delete(tws); // เตะ Socket ที่ตายแล้วทิ้งทันที
            }
        } catch (e) { watchers.delete(tws); }
    });
};

// 🧹 Advanced GC 
const gcInterval = setInterval(async () => { 
    const now = Date.now();
    saveStatsDB(); 
    spamTracker.clear();

    for (const [tokenStr, userInfo] of tokens.entries()) {
        const isExpired = now - userInfo.createdAt > TOKEN_MAX_AGE_MS;
        const isInactive = userInfo.activeSockets.size === 0 && now - userInfo.lastAccess > 10 * 60 * 1000;
        
        if (isExpired || isInactive) { 
            userInfo.activeSockets.forEach(ws => ws.terminate()); 
            tokens.delete(tokenStr); 
            userActivity.delete(userInfo.username);
        }
    }

    try {
        const files = await fsp.readdir(avatarsDir);
        for (const file of files) {
            if (file.endsWith('.tmp')) {
                const stats = await fsp.stat(path.join(avatarsDir, file)).catch(()=>null);
                if (stats && (now - stats.mtimeMs > 5 * 60 * 1000)) await fsp.unlink(path.join(avatarsDir, file)).catch(()=>{});
            }
        }
    } catch (e) {}
}, 5 * 60 * 1000); 

setInterval(async () => {
    try {
        const files = await fsp.readdir(avatarsDir);
        for (const file of files) {
            if (file.endsWith('.moon')) await fsp.copyFile(path.join(avatarsDir, file), path.join(backupDir, file)).catch(()=>{});
        }
    } catch (e) {}
}, 60 * 60 * 1000);

// ⚡ Sync อัจฉริยะ (Heartbeat)
const syncInterval = setInterval(async () => {
    if (isSyncing) return; 
    isSyncing = true;
    try {
        const formData = new URLSearchParams({ key: API_KEY, action: 'get_lists' });
        const res = await fastAxios.post(API_URL, formData.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }});

        if (res.data && res.data.maintenance === true) {
            isMaintenanceMode = true;
        } else {
            isMaintenanceMode = false;
            if (res.data && !res.data.error) {
                sqlBlacklist = new Set(res.data.blacklist || []);
                if (ENABLE_WHITELIST && res.data.whitelist) sqlWhitelist = new Set(res.data.whitelist || []);
            }
        }

        if (isMaintenanceMode !== lastMaintenanceState) {
            lastMaintenanceState = isMaintenanceMode;
            if (isMaintenanceMode) sendToDiscord(`⚠️ **[ประกาศ]** เซิร์ฟเวอร์เข้าสู่ **โหมดปิดปรับปรุง (Maintenance)** 🛠️`);
            else sendToDiscord(`✅ **[ประกาศ]** เซิร์ฟเวอร์ **เปิดให้บริการปกติ** แล้ว! 🌍 โซน: ${currentZone.name}`);
        }

        const onlineData = [];
        for (const [tokenStr, userInfo] of tokens.entries()) {
            const uname = userInfo.usernameLower; 
            if (isMaintenanceMode || sqlBlacklist.has(uname) || (ENABLE_WHITELIST && !sqlWhitelist.has(uname))) {
                userInfo.activeSockets.forEach(ws => ws.terminate());
                tokens.delete(tokenStr);
                userActivity.delete(userInfo.username);
                fsp.unlink(path.join(avatarsDir, `${userInfo.uuid}.moon`)).catch(() => {}); 
                continue;
            }
            if (userInfo.activeSockets && userInfo.activeSockets.size > 0) {
                onlineData.push({ name: userInfo.username, activity: userActivity.get(userInfo.username) || "Idle", last_size: userInfo.lastSize || 0 });
            }
        }
        
        if (onlineData.length > 0 && !isMaintenanceMode) {
            const hbData = new URLSearchParams({ key: API_KEY, action: 'heartbeat', data: JSON.stringify(onlineData) });
            fastAxios.post(API_URL, hbData.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }}).catch(()=>{});
        }
    } catch (e) {} finally { isSyncing = false; }
}, SYNC_INTERVAL_MS); 

// ==========================================
// 🌐 API ROUTES
// ==========================================
app.get('/health', (req, res) => res.status(200).json({ status: 'UP', memory: process.memoryUsage().rss / 1024 / 1024, uptime: process.uptime() }));

app.get('/api/server-stats', (req, res) => {
    if (req.query.pass !== DASHBOARD_PASS) return res.status(403).json({ error: "Unauthorized" });
    const uptimeSecs = Math.floor((Date.now() - startTime) / 1000);
    res.json({
        totalLogins: serverStats.totalLogins, totalUploads: serverStats.totalUploads,
        totalBytesMB: (serverStats.totalBytes / 1024 / 1024).toFixed(2), ramUsageMB: (process.memoryUsage().rss / 1024 / 1024).toFixed(2),
        uptimeStr: `${Math.floor(uptimeSecs/3600)}h ${Math.floor((uptimeSecs%3600)/60)}m ${uptimeSecs%60}s`, zone: currentZone
    });
});

app.get('/api/motd', (req, res) => res.status(200).send(MOTD_MESSAGE));
app.get('/api/version', (req, res) => res.json({"release":"0.1.5", "prerelease":"0.1.5"}));
app.get('/api/limits', (req, res) => res.json({"rate": { "pingSize": 1048576, "pingRate": 4096, "equip": 0, "download": 999999999999, "upload": 99999999999 }, "limits": { "maxAvatarSize": LIMIT_BYTES, "maxAvatars": 100, "allowedBadges": { "special": Array(15).fill(0), "pride": Array(30).fill(0) } }}));

app.get('/api/auth/id', (req, res) => {
    const uname = req.query.username?.toLowerCase();
    if (!uname) return res.status(400).end();

    if (isMaintenanceMode) return res.status(403).send("§e⚠ เซิร์ฟเวอร์อยู่ในโหมดปิดปรับปรุงชั่วคราว");
    if (sqlBlacklist.has(uname)) return res.status(403).send("§c✖ บัญชีของคุณถูกระงับ (Banned)");
    if (ENABLE_WHITELIST && !sqlWhitelist.has(uname)) return res.status(403).send("§c✖ ไม่มีชื่อในระบบ (Not Whitelisted)");

    const serverID = crypto.randomBytes(16).toString('hex');
    server_ids.set(serverID, { username: req.query.username, time: Date.now() });
    res.send(serverID);
});

app.get('/api/auth/verify', async (req, res) => {
    try {
        const sid = req.query.id;
        const sessionData = server_ids.get(sid);
        if (!sessionData) return res.status(404).json({ error: 'Auth failed' });
        
        const response = await fastAxios.get("https://sessionserver.mojang.com/session/minecraft/hasJoined", { params: { username: sessionData.username, serverId: sid } });
        server_ids.delete(sid); 
        
        const token = crypto.randomBytes(16).toString('hex');
        const hexUuid = response.data.id;
        const premiumUuid = formatUuid(hexUuid);
        const hexUuidBuffer = Buffer.from(hexUuid, 'hex'); 

        tokens.set(token, { 
            uuid: premiumUuid, hexUuid: hexUuid, hexUuidBuffer: hexUuidBuffer, 
            username: response.data.name, usernameLower: response.data.name.toLowerCase(),
            lastSize: 0, lastAccess: Date.now(), createdAt: Date.now(),
            activeSockets: new Set() 
        });
        
        serverStats.totalLogins++; saveStatsDB();
        logger.info(`${c.b}⚡ [LOGIN] ${c.g}${response.data.name} ${c.p}[${premiumUuid}]${c.rst}`);
        res.send(token);
    } catch (error) { res.status(500).json({ error: 'Auth Error' }); }
});

const authMiddleware = (req, res, next) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    req.userInfo = userInfo;
    next();
};

app.post('/api/equip', authMiddleware, (req, res) => {
    req.userInfo.lastAccess = Date.now();
    userActivity.set(req.userInfo.username, "👕 สวมใส่โมเดล...");
    
    const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); 
    req.userInfo.hexUuidBuffer.copy(buffer, 1); 
    
    broadcastToWatchers(req.userInfo.uuid, buffer); // ✅ ใช้ฟังก์ชันใหม่ สั้นและคลีน
    res.send("success");
});

app.put('/api/avatar', authMiddleware, async (req, res) => {
    const userInfo = req.userInfo;
    userInfo.lastAccess = Date.now(); 
    
    const fileData = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const contentLength = fileData.length;

    if (contentLength === 0 || contentLength > LIMIT_BYTES) {
        if (contentLength > LIMIT_BYTES) {
            let strikes = (spamTracker.get(userInfo.username) || 0) + 1;
            spamTracker.set(userInfo.username, strikes);
            if (strikes >= 3) {
                sendToDiscord(`🚨 **[ระบบป้องกัน]** ผู้เล่น \`${userInfo.username}\` สแปมอัปโหลดไฟล์ใหญ่เกินกำหนด`);
                sqlBlacklist.add(userInfo.usernameLower); 
            }
            return res.status(413).end();
        }
        return res.status(400).send({ error: "Invalid file" });
    }

    userActivity.set(userInfo.username, "📤 กำลังอัปโหลดโมเดล...");
    const tempFile = path.join(avatarsDir, `${userInfo.uuid}_${Date.now()}.tmp`);
    const finalFile = path.join(avatarsDir, `${userInfo.uuid}.moon`);

    try {
        await fsp.writeFile(tempFile, fileData); 
        const hash = crypto.createHash('sha256').update(fileData).digest('hex');
        
        await fsp.rename(tempFile, finalFile); 
        
        hashCache.set(userInfo.uuid, hash); 
        apiJsonCache.delete(userInfo.uuid); 
        saveCache(); 

        serverStats.totalUploads++; serverStats.totalBytes += contentLength; saveStatsDB();
        userActivity.set(userInfo.username, "✅ โมเดลพร้อมใช้งาน");
        
        const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); 
        userInfo.hexUuidBuffer.copy(buffer, 1); 
        
        broadcastToWatchers(userInfo.uuid, buffer); // ✅ ใช้ฟังก์ชันใหม่
        res.send("success"); 
    } catch (err) {
        fsp.unlink(tempFile).catch(()=>{});
        logger.error(`${c.r}[Upload Error] ${err.message}${c.rst}`);
        if (!res.headersSent) res.status(500).send({ error: "Upload failed" });
    }
});

app.delete('/api/avatar', authMiddleware, async (req, res) => {
    const userInfo = req.userInfo;
    try {
        userInfo.lastAccess = Date.now();
        userActivity.set(userInfo.username, "🗑️ ลบโมเดล");
        await fsp.unlink(path.join(avatarsDir, `${userInfo.uuid}.moon`)); 
        
        hashCache.delete(userInfo.uuid); apiJsonCache.delete(userInfo.uuid); saveCache();
        
        const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); 
        userInfo.hexUuidBuffer.copy(buffer, 1); 
        
        broadcastToWatchers(userInfo.uuid, buffer); // ✅ ใช้ฟังก์ชันใหม่
        res.send("success");
    } catch (err) { res.status(404).end(); }
});

app.get('/api/:uuid/avatar', async (req, res) => { 
    const uuidStr = req.params.uuid;
    if (["motd", "version", "auth", "limits", "stats-secret"].includes(uuidStr) || !isValidUUID(uuidStr)) return res.status(404).end();
    
    const avatarFile = path.join(avatarsDir, `${formatUuid(uuidStr)}.moon`);
    try {
        await fsp.access(avatarFile); 
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.sendFile(avatarFile);
    } catch (e) { res.status(404).end(); }
});

app.get('/api/:uuid', async (req, res) => {
    const uuidStr = req.params.uuid;
    if (["motd", "version", "auth", "limits", "stats-secret"].includes(uuidStr) || !isValidUUID(uuidStr)) return res.status(404).end();
    const uuid = formatUuid(uuidStr);

    if (apiJsonCache.has(uuid)) { return res.json(apiJsonCache.get(uuid)); }

    const data = { uuid: uuid, rank: "normal", equipped: [], lastUsed: new Date().toISOString(), equippedBadges: { special: Array(15).fill(0), pride: Array(30).fill(0) }, version: "0.1.5", banned: false };
    let fileHash = hashCache.get(uuid);
    
    if (!fileHash) {
        try {
            const fileBuffer = await fsp.readFile(path.join(avatarsDir, `${uuid}.moon`));
            fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
            hashCache.set(uuid, fileHash);
        } catch (e) {}
    }
    if (fileHash) data.equipped.push({ id: 'avatar', owner: uuid, hash: fileHash });
    
    apiJsonCache.set(uuid, data);
    res.json(data);
});

app.get('/', (req, res) => { res.status(200).send(MOTD_MESSAGE); });

app.use((err, req, res, next) => {
    logger.error(`${c.r}[API Error] ${err.stack}${c.rst}`);
    res.status(500).json({ error: 'Internal Server Error' });
});

// ==========================================
// ⚡ WEBSOCKET (V22 MASTERCRAFT ENGINE)
// ==========================================
const server = http.createServer(app);
server.keepAliveTimeout = 120000;  
server.headersTimeout = 125000;    

const wss = new WebSocket.Server({ server, perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 });

const FREE_RAM_MB = Math.floor(os.freemem() / 1024 / 1024);
const MAX_WS = Math.max(500, Math.min(5000, Math.floor(FREE_RAM_MB / 1.5))); 
const RATE_LIMIT_WS_MSGS = 50; 

setInterval(() => { wss.clients.forEach(ws => { ws.msgCount = 0; }); }, 1000);

wss.on('connection', (ws) => {
    if (wss.clients.size > MAX_WS) return ws.terminate();

    ws.isAlive = true; 
    ws.isAuthenticated = false; 
    ws.missedPings = 0; 
    ws.msgCount = 0; 
    ws.watchedUuids = new Set(); 
    
    const authTimeout = setTimeout(() => {
        if (!ws.isAuthenticated) ws.terminate();
    }, 5000);

    ws.on('pong', () => { ws.isAlive = true; ws.missedPings = 0; }); 

    ws.on('message', (data) => {
        try {
            ws.msgCount++;
            if (ws.msgCount > RATE_LIMIT_WS_MSGS) return ws.terminate(); 

            if (!Buffer.isBuffer(data) || data.length < 1 || data.length > 1048576) return; 

            const type = data[0];
            if (type === 0) {
                const tokenStr = data.slice(1).toString('utf-8');
                
                // 🛡️ ป้องกันแฮกเกอร์ส่ง Token ยาวเกินเหตุเพื่อก่อกวน
                if (tokenStr.length > 100) return ws.terminate(); 

                const userInfo = tokens.get(tokenStr);

                if (userInfo) {
                    clearTimeout(authTimeout); 
                    ws.isAuthenticated = true;
                    ws.userInfo = userInfo; 
                    userInfo.activeSockets.add(ws); 
                    
                    if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from([0]), { binary: true });
                } else {
                    ws.terminate(); 
                }
            }
            else if (type === 1) { 
                if (!ws.isAuthenticated || data.length < 10 || !ws.userInfo) return; 
                const userInfo = ws.userInfo;
                userInfo.lastAccess = Date.now(); 
                
                const newbuffer = Buffer.allocUnsafe(22 + (data.length - 6));
                newbuffer.writeUInt8(0, 0); 
                userInfo.hexUuidBuffer.copy(newbuffer, 1); 
                try {
                    newbuffer.writeInt32BE(data.readInt32BE(1), 17); 
                    const isGlobal = data.readUInt8(5) !== 0 ? 1 : 0;
                    newbuffer.writeUInt8(isGlobal, 21); 
                    data.slice(6).copy(newbuffer, 22);
                    
                    // ✅ ใช้ฟังก์ชันใหม่ในการบรอดคาสต์ โค้ดสั้นลง และลดการพัง
                    broadcastToWatchers(userInfo.uuid, newbuffer, isGlobal === 1 ? null : ws);
                    
                } catch (bufferErr) {}
            }
            else if (type === 2 || type === 3) {
                if (!ws.isAuthenticated || data.length < 17) return; 
                const uuidHex = data.slice(1, 17).toString('hex');
                const uuid = formatUuid(uuidHex);
                
                if (type === 2) { 
                    ws.watchedUuids.add(uuid); 
                    if (!wsMap.has(uuid)) wsMap.set(uuid, new Set()); 
                    wsMap.get(uuid).add(ws); 
                } else { 
                    ws.watchedUuids.delete(uuid);
                    if (wsMap.has(uuid)) wsMap.get(uuid).delete(ws); 
                }
            }
        } catch (e) {} 
    });
    
    ws.on('error', () => {}); 
    
    ws.on('close', () => {
        clearTimeout(authTimeout);

        if (ws.userInfo) {
            ws.userInfo.activeSockets.delete(ws);
        }

        ws.watchedUuids.forEach(uuid => {
            const watchers = wsMap.get(uuid);
            if (watchers) {
                watchers.delete(ws);
                if (watchers.size === 0) wsMap.delete(uuid);
            }
        });
    });
});

const wsPingInterval = setInterval(() => { 
    wss.clients.forEach((ws) => { 
        if (!ws.isAlive) {
            ws.missedPings++;
            if (ws.missedPings >= 6) return ws.terminate();
        } else { ws.missedPings = 0; }
        ws.isAlive = false; 
        if (ws.readyState === WebSocket.OPEN) ws.ping(); 
    }); 
}, WS_PING_INTERVAL_MS); 

wss.on('close', () => clearInterval(wsPingInterval));

const shutdown = () => {
    logger.info(`\n${c.y}⚠️ กำลังเซฟข้อมูลและปิดเซิร์ฟเวอร์อย่างปลอดภัย...${c.rst}`);
    clearInterval(syncInterval); clearInterval(gcInterval); clearInterval(wsPingInterval);
    saveStatsDB();
    
    wss.close(() => { server.close(() => { logger.info(`${c.g}✅ ปิดเซิร์ฟเวอร์เสร็จสมบูรณ์${c.rst}`); process.exit(0); }); });
};
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

server.listen(PORT, '0.0.0.0', () => {
    logger.info(`\n${c.p}==========================================${c.rst}`);
    logger.info(`${c.b}✨ BIGAVATAR CLOUD (V22 MASTERCRAFT EDITION)${c.rst}`);
    logger.info(`${c.g}✅ API Link: ${API_URL}${c.rst}`);
    logger.info(`${c.g}🌍 Server Region: ${currentZone.name} ${currentZone.mcFlag}${c.rst}`);
    logger.info(`${c.y}🛠️ Code Refactored: DRY Principles Applied${c.rst}`);
    logger.info(`${c.y}🛡️ WS Token Limit & UUID Lowercasing: ACTIVE${c.rst}`);
    logger.info(`${c.y}🛡️ Strict Anti-Crash Data Pipeline: ACTIVE${c.rst}`);
    logger.info(`${c.y}📈 Dynamic Max WS Limit: ${MAX_WS} (Based on RAM)${c.rst}`);
    logger.info(`${c.p}==========================================${c.rst}\n`);
    
    sendToDiscord(`🚀 **[SYSTEM START]** เซิร์ฟเวอร์ Figura ออนไลน์แล้วพร้อมระบบ V22 Mastercraft! 🌍 โซน: ${currentZone.name}`);
});
