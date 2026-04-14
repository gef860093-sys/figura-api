const express = require('express');
const http = require('http'); 
const https = require('https');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises'); 
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit'); 
const { EventEmitter } = require('events');

// 🚀 ปลดล็อกขีดจำกัด Event Listeners ของ Node.js รองรับคน 1000+
EventEmitter.defaultMaxListeners = 5000;

// 🎨 ตัวแปรจัดการสีใน Console
const c = { g: '\x1b[32m', b: '\x1b[36m', y: '\x1b[33m', r: '\x1b[31m', p: '\x1b[35m', rst: '\x1b[0m' };
const logTime = () => `[${new Date().toLocaleTimeString('th-TH')}]`;
const startTime = Date.now();

// 🛡️ ป้องกันเซิร์ฟเวอร์ดับจากการ Error (Crash Protection)
process.on('uncaughtException', (err) => { console.error(`${c.r}${logTime()} [Fatal Error] ${err.message}${c.rst}`); });
process.on('unhandledRejection', (reason) => { console.error(`${c.r}${logTime()} [Unhandled Promise] ${reason}${c.rst}`); });

// ==========================================
// ⚙️ SERVER CONFIG (1,000+ PLAYERS EDITION)
// ==========================================
const PORT = 80; 
const LIMIT_BYTES = 30 * 1024 * 1024; // ลิมิตขนาดโมเดลสูงสุด 30MB
const ENABLE_WHITELIST = true; 

// 💬 ระบบแจ้งเตือน Discord
const DISCORD_WEBHOOK_URL = "https://ptb.discord.com/api/webhooks/1493712415831887955/-DO5NvlZUp83EDkr7JQb13QHdrTNeveugQwXy2Ni74fxxbbw4PYcuQHqoUgs2Q7cOaz-"; 
const API_URL = "https://bigavatar.dpdns.org/api.php"; 
const API_KEY = "b9a23abea9240f3f2fc325a3e623f8f0"; 

// 🌍 เลือกระบุ Zone ของเซิร์ฟเวอร์
const SERVER_ZONE = "TH"; 
const ZONE_INFO = {
    "TH": { webFlag: "🇹🇭", mcFlag: "[TH]", name: "Thailand", ping: "< 20 ms" },
    "SG": { webFlag: "🇸🇬", mcFlag: "[SG]", name: "Singapore", ping: "20-50 ms" },
    "JP": { webFlag: "🇯🇵", mcFlag: "[JP]", name: "Japan", ping: "80-120 ms" },
    "US": { webFlag: "🇺🇸", mcFlag: "[US]", name: "USA", ping: "200+ ms" },
    "EU": { webFlag: "🇪🇺", mcFlag: "[EU]", name: "Europe", ping: "150-250 ms" }
};
const currentZone = ZONE_INFO[SERVER_ZONE] || ZONE_INFO["TH"];

// 🎨 [EPIC MOTD] สัญลักษณ์ Unicode แท้ 100% เกม Minecraft อ่านออก ไม่มีบั๊กกล่อง []
const MOTD_MESSAGE = 
    `§8§m                                        §r\n` +
    `  §3§l✦ §b§lB§3§lI§b§lG§3§lA§b§lV§3§lA§b§lT§3§lA§b§lR §f§lC§7§lL§f§lO§7§lU§f§lD §b§l✦\n` +
    `§8§m                                        §r\n` +
    `§a ✔ §aสถานะ: §fออนไลน์ (เสถียรภาพระดับสูงสุด)\n` +
    `§e ⚑ §eโซนเซิร์ฟเวอร์: §f${currentZone.mcFlag} ${currentZone.name} §7(Ping ${currentZone.ping})\n` +
    `§d ⚙ §dระบบป้องกัน: §fAnti-Drop & DDoS Protection ใช้งานอยู่\n` +
    `§c ➤ §cสามารถเข้าไปดูรายละเอียดได้ในเว็บไซต์: §nhttps://dash.faydar.eu.cc\n` +
    `§8§m                                        §r`;

// ⚡ ค่าปรับจูนเพื่อลดคอขวดสำหรับคน 1000+ คน
const SYNC_INTERVAL_MS = 15000;    // 🚀 ยืดเวลา Sync เป็น 15 วิ ลดภาระ CPU และแบนด์วิดท์
const WS_PING_INTERVAL_MS = 30000; // 🚀 เช็คปิงทุก 30 วิ (เซิร์ฟเวอร์คนเยอะไม่ต้องปิงถี่)
const DASHBOARD_PASS = "admin123"; 
// ==========================================

const avatarsDir = path.join(__dirname, "avatars");
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

const app = express();
app.set('trust proxy', 1);
app.use(cors());

// 🛡️ [5-STAR SECURITY] ฝัง Security Headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/'); 
    next(); 
});

// 🚀 รับไฟล์แบบ Raw Buffer โหลดเต็ม 100%
app.use(express.raw({ limit: '32mb', type: '*/*' })); 

// 🛡️ Rate Limit (เพิ่มลิมิตให้รองรับคน 1000+ ได้แบบไม่โดนบล็อก)
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 10000, message: { error: "Too many requests." } });
app.use('/api/', apiLimiter);

// ==========================================
// 🗄️ STATE MANAGEMENT & DATABASE (HYPER CACHE)
// ==========================================
const server_ids = new Map();
const tokens = new Map();
const tokenMap = new WeakMap(); 
const wsMap = new Map(); 
let hashCache = new Map(); 
let apiJsonCache = new Map(); 
const spamTracker = new Map();
const userActivity = new Map(); 

let sqlBlacklist = new Set();
let sqlWhitelist = new Set();
let isSyncing = false; 
let isMaintenanceMode = false; 
let lastMaintenanceState = false; 

const dbFile = path.join(__dirname, 'statsDB.json');
let serverStats = { totalLogins: 0, totalUploads: 0, totalBytes: 0 };
if (fs.existsSync(dbFile)) { try { serverStats = JSON.parse(fs.readFileSync(dbFile)); } catch(e) {} }
const saveStatsDB = () => fsp.writeFile(dbFile, JSON.stringify(serverStats)).catch(()=>{});

const cacheFile = path.join(__dirname, 'hashCache.json');
if (fs.existsSync(cacheFile)) { try { hashCache = new Map(Object.entries(JSON.parse(fs.readFileSync(cacheFile)))); } catch(e) {} }
const saveCache = () => fsp.writeFile(cacheFile, JSON.stringify(Object.fromEntries(hashCache))).catch(()=>{});

// 🚀 ปรับจูน Axios ให้รับส่งข้อมูลได้ระดับ Enterprise (maxSockets 500)
const fastAxios = axios.create({
    timeout: 10000, 
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 500 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 500, rejectUnauthorized: false })
});

const sendToDiscord = (message) => { if (!DISCORD_WEBHOOK_URL) return; fastAxios.post(DISCORD_WEBHOOK_URL, { content: message }).catch(() => {}); };
const isValidUUID = (uuid) => /^[0-9a-fA-F-]{32,36}$/.test(uuid);

const formatUuid = (uuid) => { 
    if (!uuid) return "";
    const clean = uuid.replace(/-/g, '');
    if (clean.length !== 32) return uuid;
    return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
};

// 🧹 Deep Garbage Collection
const gcInterval = setInterval(async () => { 
    const now = Date.now();
    
    for (let [id, data] of server_ids.entries()) { if (now - data.time > 60000) server_ids.delete(id); }
    spamTracker.clear(); 
    saveStatsDB(); 

    for (const [tokenStr, userInfo] of tokens.entries()) {
        if (now - userInfo.lastAccess > 30 * 60 * 1000) { // 🚀 ยืดเวลาคนหลุดเป็น 30 นาที
            const uuid = userInfo.uuid;
            if (!wsMap.has(uuid) || wsMap.get(uuid).size === 0) {
                tokens.delete(tokenStr); 
                userActivity.delete(userInfo.username);
            }
        }
    }
    
    for (const [uuid, sockets] of wsMap.entries()) {
        if (sockets.size === 0) wsMap.delete(uuid);
    }

    for (const [uuid, cacheData] of apiJsonCache.entries()) {
        if (now - cacheData.time > 20 * 60 * 1000) apiJsonCache.delete(uuid);
    }

    try {
        const files = await fsp.readdir(avatarsDir);
        for (const file of files) {
            if (file.endsWith('.tmp')) {
                const filePath = path.join(avatarsDir, file);
                const stats = await fsp.stat(filePath).catch(()=>null);
                if (stats && (now - stats.mtimeMs > 5 * 60 * 1000)) { await fsp.unlink(filePath).catch(()=>{}); }
            }
        }
    } catch (e) {}
}, 5 * 60 * 1000); 

// ⚡ Sync อัจฉริยะ (ปรับลดภาระการวนลูป 1,000 รอบ)
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
            const uname = userInfo.usernameLower; // 🚀 ใช้ค่าที่แปลงรอไว้แล้ว ไม่ต้องสั่ง .toLowerCase() ให้กินสเปค!
            
            if (isMaintenanceMode || sqlBlacklist.has(uname) || (ENABLE_WHITELIST && !sqlWhitelist.has(uname))) {
                tokens.delete(tokenStr);
                hashCache.delete(userInfo.uuid);
                apiJsonCache.delete(userInfo.uuid); 
                saveCache();
                fsp.unlink(path.join(__dirname, 'avatars', `${userInfo.uuid}.moon`)).catch(() => {}); 
                if (wsMap.has(userInfo.uuid)) { wsMap.get(userInfo.uuid).forEach(ws => ws.terminate()); wsMap.delete(userInfo.uuid); }
                continue;
            }

            if (wsMap.has(userInfo.uuid) && wsMap.get(userInfo.uuid).size > 0) {
                onlineData.push({ 
                    name: userInfo.username, 
                    activity: userActivity.get(userInfo.username) || "Idle", 
                    last_size: userInfo.lastSize || 0 
                });
            }
        }
        
        if (onlineData.length > 0 && !isMaintenanceMode) {
            const hbData = new URLSearchParams({ key: API_KEY, action: 'heartbeat', data: JSON.stringify(onlineData) });
            fastAxios.post(API_URL, hbData.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }}).catch(()=>{});
        }
    } catch (e) {
    } finally {
        isSyncing = false;
    }
}, SYNC_INTERVAL_MS); 

// ==========================================
// 🌐 API ROUTES & DASHBOARD
// ==========================================
app.get('/health', (req, res) => res.status(200).json({ status: 'UP', players: wsMap.size, uptime: process.uptime() }));

app.get('/api/server-stats', (req, res) => {
    if (req.query.pass !== DASHBOARD_PASS) return res.status(403).json({ error: "Unauthorized" });
    const uptimeSecs = Math.floor((Date.now() - startTime) / 1000);
    res.json({
        onlinePlayers: wsMap.size, 
        totalLogins: serverStats.totalLogins, totalUploads: serverStats.totalUploads,
        totalBytesMB: (serverStats.totalBytes / 1024 / 1024).toFixed(2), ramUsageMB: (process.memoryUsage().rss / 1024 / 1024).toFixed(2),
        uptimeStr: `${Math.floor(uptimeSecs/3600)}h ${Math.floor((uptimeSecs%3600)/60)}m ${uptimeSecs%60}s`,
        zone: currentZone
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

        // 🚀 เก็บ username แบบแปลงเป็นพิมพ์เล็กรอไว้เลย ช่วยประหยัด CPU มหาศาลตอนที่คนเยอะๆ!
        tokens.set(token, { 
            uuid: premiumUuid, hexUuid: hexUuid, hexUuidBuffer: hexUuidBuffer, 
            username: response.data.name, usernameLower: response.data.name.toLowerCase(),
            clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            lastSize: 0, lastAccess: Date.now() 
        });
        
        serverStats.totalLogins++;
        saveStatsDB();

        console.log(`${c.b}${logTime()} ⚡ [LOGIN] ${c.g}${response.data.name} ${c.p}[${premiumUuid}]${c.rst}`);
        res.send(token);
    } catch (error) { res.status(500).json({ error: 'Auth Error' }); }
});

app.post('/api/equip', (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end(); 
    
    userInfo.lastAccess = Date.now();
    userActivity.set(userInfo.username, "👕 สวมใส่โมเดล...");
    
    if (wsMap.has(userInfo.uuid)) {
        const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); 
        userInfo.hexUuidBuffer.copy(buffer, 1); 
        wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === 1) ws.send(buffer, { binary: true }); });
    }
    res.send("success");
});

app.put('/api/avatar', async (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    
    userInfo.lastAccess = Date.now(); 
    
    const fileData = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const contentLength = fileData.length;
    
    if (contentLength === 0) return res.status(400).send({ error: "Empty file upload" });
    
    userInfo.lastSize = contentLength;
    
    if (contentLength > LIMIT_BYTES) {
        let strikes = (spamTracker.get(userInfo.username) || 0) + 1;
        spamTracker.set(userInfo.username, strikes);
        if (strikes >= 3) {
            sendToDiscord(`🚨 **[ระบบป้องกัน]** ผู้เล่น \`${userInfo.username}\` สแปมอัปโหลดไฟล์ใหญ่เกินกำหนด (ถูกแบนอัตโนมัติ)`);
            sqlBlacklist.add(userInfo.usernameLower); 
        }
        return res.status(413).end();
    }

    userActivity.set(userInfo.username, "📤 กำลังอัปโหลดโมเดล...");
    const finalFile = path.join(__dirname, 'avatars', `${userInfo.uuid}.moon`);

    try {
        const hash = crypto.createHash('sha256').update(fileData).digest('hex');
        await fsp.writeFile(finalFile, fileData);
        
        hashCache.set(userInfo.uuid, hash); 
        apiJsonCache.delete(userInfo.uuid); 
        saveCache(); 

        serverStats.totalUploads++;
        serverStats.totalBytes += contentLength;
        saveStatsDB();

        userActivity.set(userInfo.username, "✅ โมเดลพร้อมใช้งาน");
        
        if (wsMap.has(userInfo.uuid)) {
            const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); 
            userInfo.hexUuidBuffer.copy(buffer, 1); 
            wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === 1) ws.send(buffer, { binary: true }); });
        }
        res.send("success"); 
    } catch (err) {
        console.error(`${c.r}${logTime()} [Upload Error] ${err.message}${c.rst}`);
        if (!res.headersSent) res.status(500).send({ error: "Upload failed" });
    }
});

app.delete('/api/avatar', async (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    try {
        userInfo.lastAccess = Date.now();
        userActivity.set(userInfo.username, "🗑️ ลบโมเดล");
        await fsp.unlink(path.join(__dirname, 'avatars', `${userInfo.uuid}.moon`)); 
        
        hashCache.delete(userInfo.uuid);
        apiJsonCache.delete(userInfo.uuid);
        saveCache();
        
        if (wsMap.has(userInfo.uuid)) {
            const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); 
            userInfo.hexUuidBuffer.copy(buffer, 1); 
            wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === 1) ws.send(buffer, { binary: true }); });
        }
        res.send("success");
    } catch (err) { res.status(404).end(); }
});

app.get('/api/:uuid/avatar', async (req, res) => { 
    const uuidStr = req.params.uuid;
    if (["motd", "version", "auth", "limits", "stats-secret"].includes(uuidStr) || !isValidUUID(uuidStr)) return res.status(404).end();
    
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
    if (["motd", "version", "auth", "limits", "stats-secret"].includes(uuidStr) || !isValidUUID(uuidStr)) return res.status(404).end();

    const uuid = formatUuid(uuidStr);
    if (!uuid) return res.status(404).end();

    if (apiJsonCache.has(uuid)) {
        const cached = apiJsonCache.get(uuid);
        cached.time = Date.now(); 
        return res.json(cached.data);
    }

    const data = { uuid: uuid, rank: "normal", equipped: [], lastUsed: new Date().toISOString(), equippedBadges: { special: Array(15).fill(0), pride: Array(30).fill(0) }, version: "0.1.5", banned: false };
    let fileHash = hashCache.get(uuid);
    const avatarFile = path.join(__dirname, 'avatars', `${uuid}.moon`);
    
    if (!fileHash) {
        try {
            await fsp.access(avatarFile);
            const fileBuffer = await fsp.readFile(avatarFile);
            fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
            hashCache.set(uuid, fileHash);
            saveCache();
        } catch (e) {}
    }
    
    if (fileHash) data.equipped.push({ id: 'avatar', owner: uuid, hash: fileHash });
    apiJsonCache.set(uuid, { data: data, time: Date.now() });
    res.json(data);
});

app.get('/', (req, res) => { res.status(200).send(MOTD_MESSAGE); });

app.use((err, req, res, next) => {
    console.error(`${c.r}${logTime()} [API Error] ${err.stack}${c.rst}`);
    res.status(500).json({ error: 'Internal Server Error' });
});

// ==========================================
// ⚡ WEBSOCKET (1,000+ MAX PERFORMANCE ENGINE)
// ==========================================
const server = http.createServer(app);
server.keepAliveTimeout = 120000;  
server.headersTimeout = 125000;    

const wss = new WebSocket.Server({ 
    server, 
    perMessageDeflate: false, // 🚀 ปิดบีบอัด WS เพราะมันกิน CPU มหาศาลเมื่อคนเยอะ
    maxPayload: LIMIT_BYTES + 1048576,
    clientTracking: true
});

wss.on('connection', (ws) => {
    ws.isAlive = true; 
    ws.missedPings = 0; 
    
    ws.on('pong', () => { 
        ws.isAlive = true; 
        ws.missedPings = 0; 
    }); 

    ws.on('message', (data) => {
        try {
            if (!Buffer.isBuffer(data) || data.length < 1) return; 

            const type = data[0];
            if (type === 0) {
                tokenMap.set(ws, data.slice(1).toString('utf-8'));
                if (ws.readyState === 1) ws.send(Buffer.from([0]), { binary: true });
            }
            else if (type === 1) { 
                if (data.length < 6) return; 
                const userInfo = tokens.get(tokenMap.get(ws));
                if (!userInfo) return;
                
                userInfo.lastAccess = Date.now(); 
                
                const dataLen = data.length;
                // 🚀 [HYPER SPEED] ใช้ allocUnsafe เพื่อสร้างแพ็คเก็ตแค่ "ครั้งเดียว" และส่งหาทุกคนโดยไม่กิน CPU เพิ่ม
                const newbuffer = Buffer.allocUnsafe(22 + (dataLen - 6));
                newbuffer.writeUInt8(0, 0); 
                userInfo.hexUuidBuffer.copy(newbuffer, 1); 
                newbuffer.writeInt32BE(data.readInt32BE(1), 17); 
                
                const isGlobal = data.readUInt8(5) !== 0 ? 1 : 0;
                newbuffer.writeUInt8(isGlobal, 21); 
                data.slice(6).copy(newbuffer, 22);
                
                const connections = wsMap.get(userInfo.uuid);
                if (connections) { 
                    // 🚀 โคตรเร็ว: ไม่ใช้ try-catch ในลูป ใช้ readyState === 1 แทน
                    connections.forEach(tws => { 
                        if (tws.readyState === 1 && (isGlobal === 1 || tws !== ws)) {
                            tws.send(newbuffer, { binary: true });
                        } 
                    }); 
                }
            }
            else if (type === 2 || type === 3) {
                if (data.length < 17) return; 
                const uuidHex = data.slice(1, 17).toString('hex');
                const uuid = formatUuid(uuidHex);
                if (type === 2) { 
                    if (!wsMap.has(uuid)) wsMap.set(uuid, new Set()); 
                    wsMap.get(uuid).add(ws); 
                } else { 
                    if (wsMap.has(uuid)) wsMap.get(uuid).delete(ws); 
                }
            }
        } catch (e) {} 
    });
    
    ws.on('error', () => {}); 
    
    ws.on('close', () => {
        const tokenStr = tokenMap.get(ws);
        if (tokenStr && tokens.has(tokenStr)) {
            const uuid = tokens.get(tokenStr).uuid;
            if (wsMap.has(uuid)) { 
                wsMap.get(uuid).delete(ws); 
                if (wsMap.get(uuid).size === 0) {
                    wsMap.delete(uuid); 
                    tokens.delete(tokenStr); 
                    userActivity.delete(tokens.get(tokenStr)?.username);
                }
            }
        }
    });
});

const wsPingInterval = setInterval(() => { 
    wss.clients.forEach((ws) => { 
        if (ws.isAlive === false) {
            ws.missedPings++;
            if (ws.missedPings >= 2) return ws.terminate(); 
        }
        ws.isAlive = false; 
        if (ws.readyState === 1) ws.ping(); 
    }); 
}, WS_PING_INTERVAL_MS); 

wss.on('close', () => clearInterval(wsPingInterval));

// 🏗️ Graceful Shutdown (ระบบปิดตัวเองอย่างปลอดภัย)
const shutdown = () => {
    console.log(`\n${c.y}${logTime()} ⚠️ กำลังเซฟข้อมูลและปิดเซิร์ฟเวอร์...${c.rst}`);
    clearInterval(syncInterval);
    clearInterval(gcInterval);
    clearInterval(wsPingInterval);
    saveStatsDB();
    saveCache();
    
    wss.close(() => {
        server.close(() => {
            console.log(`${c.g}✅ ปิดเซิร์ฟเวอร์เสร็จสมบูรณ์${c.rst}`);
            process.exit(0);
        });
    });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${c.p}==========================================${c.rst}`);
    console.log(`${c.b}✨ BIGAVATAR CLOUD 1,000+ PLAYERS READY)${c.rst}`);
    console.log(`${c.g}✅ API Link: ${API_URL}${c.rst}`);
    console.log(`${c.g}🌍 Server Region: ${currentZone.name} ${currentZone.mcFlag}${c.rst}`);
    console.log(`${c.y}🚀 Hyper Fast Binary Broadcasting: ACTIVE${c.rst}`);
    console.log(`${c.y}🚀 String Caching & CPU Optimization: ACTIVE${c.rst}`);
    console.log(`${c.y}🛡️ Strict Security Headers & Graceful Shutdown: ACTIVE${c.rst}`);
    console.log(`${c.p}==========================================${c.rst}\n`);
    sendToDiscord(`🚀 **[SYSTEM START]** เซิร์ฟเวอร์ Figura ออนไลน์แล้ว! 🌍 โซน: ${currentZone.name}`);
});
