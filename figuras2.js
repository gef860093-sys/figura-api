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

// 🌟 [5-STAR SECURITY & PERFORMANCE MODULES]
const helmet = require('helmet');
const compression = require('compression');
const hpp = require('hpp');

// 🚀 ปลดล็อกขีดจำกัด Event Listeners รองรับ Scalability ระดับ 15,000+ CCU
EventEmitter.defaultMaxListeners = 15000;

// 🎨 ตัวแปรจัดการสี
const c = { g: '\x1b[32m', b: '\x1b[36m', y: '\x1b[33m', r: '\x1b[31m', p: '\x1b[35m', rst: '\x1b[0m' };
const logTime = () => `[${new Date().toLocaleTimeString('th-TH')}]`;
const startTime = Date.now();

// 🛡️ ป้องกันเซิร์ฟเวอร์ดับ 100% ไม่ว่าเจอ Error อะไรก็ตาม
process.on('uncaughtException', (err) => { console.error(`${c.r}${logTime()} [Fatal Protected] ${err.message}${c.rst}`); });
process.on('unhandledRejection', (reason) => { console.error(`${c.r}${logTime()} [Promise Protected] ${reason}${c.rst}`); });

// ==========================================
// ⚙️ SERVER CONFIG (V18 ULTRA-RESILIENT)
// ==========================================
const PORT = 80; 
const LIMIT_BYTES = 35 * 1024 * 1024; // ลิมิตขนาด 35MB
const ENABLE_WHITELIST = true; 

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
    `§a ✔ §aสถานะ: §fออนไลน์ (เสถียรภาพระดับสูงสุด)\n` +
    `§e ⚑ §eโซนเซิร์ฟเวอร์: §f${currentZone.mcFlag} ${currentZone.name} §7(Ping ${currentZone.ping})\n` +
    `§d ⚙ §dระบบป้องกัน: §fAnti-Crash & DDoS Protection ใช้งานอยู่\n` +
    `§c ➤ §cรายละเอียดเพิ่มเติมที่: §nhttps://dash.faydar.eu.cc\n` +
    `§8§m                                        §r`;

const SYNC_INTERVAL_MS = 15000;    
const WS_PING_INTERVAL_MS = 25000;
const DASHBOARD_PASS = "admin123"; 

const avatarsDir = path.join(__dirname, "avatars");
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

const app = express();
app.set('trust proxy', 1);

// ==========================================
// 🛡️ [SECURITY & SMART PERFORMANCE MIDDLEWARES]
// ==========================================
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false })); 
app.use(hpp()); 

app.use(compression({ 
    threshold: 512,
    filter: (req, res) => {
        if (req.headers['content-type'] === 'application/octet-stream') return false;
        return compression.filter(req, res);
    }
}));

app.use((req, res, next) => {
    if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/'); 
    next(); 
});

// ✅ [Fix 10] ป้องกัน Request ค้าง (Timeout)
app.use((req, res, next) => {
    res.setTimeout(15000, () => {
        res.status(408).end();
    });
    next();
});

// ❌ [Fix 6] ปิด express.raw({ limit: '32mb' }) เพื่อไม่ให้โหลดเข้า RAM ทั้งก้อน
// เราจะใช้ stream pipeline รับไฟล์แทนใน route PUT /api/avatar

// ✅ [Fix 5] ปรับ Rate Limit ให้พอดี ป้องกัน Bot ยิง
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 300, message: { error: "Rate Limit Exceeded" } });
app.use('/api/', apiLimiter);

// ==========================================
// 🗄️ STATE MANAGEMENT (SCALABLE ARCHITECTURE)
// ==========================================
const server_ids = new Map();
const tokens = new Map();
const tokenMap = new Map(); // ✅ [Fix 2] เปลื่ยนจาก WeakMap เป็น Map
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

const fastAxios = axios.create({
    timeout: 15000, 
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 256 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 256, rejectUnauthorized: false })
});

const sendToDiscord = (message) => { if (!DISCORD_WEBHOOK_URL) return; fastAxios.post(DISCORD_WEBHOOK_URL, { content: message }).catch(() => {}); };
const isValidUUID = (uuid) => /^[0-9a-fA-F-]{32,36}$/.test(uuid);

const formatUuid = (uuid) => { 
    if (!uuid) return "";
    const clean = uuid.replace(/-/g, '');
    if (clean.length !== 32) return uuid;
    return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
};

// 🧹 Advanced Garbage Collection
const gcInterval = setInterval(async () => { 
    const now = Date.now();
    for (let [id, data] of server_ids.entries()) { if (now - data.time > 60000) server_ids.delete(id); }
    spamTracker.clear(); 
    saveStatsDB(); 

    // ✅ [Fix 9] กัน hashCache โตไม่หยุดจน RAM leak
    if (hashCache.size > 5000) {
        hashCache.clear();
    }

    // ✅ [Fix 3] เคลียร์ wsMap และ Tokens ที่ค้าง (Sync)
    for (const [uuid, sockets] of wsMap.entries()) {
        if (sockets.size === 0) {
            wsMap.delete(uuid);
        }
    }

    for (const [tokenStr, userInfo] of tokens.entries()) {
        if (!wsMap.has(userInfo.uuid)) {
            if (now - userInfo.lastAccess > 10 * 60 * 1000) { 
                tokens.delete(tokenStr); 
                userActivity.delete(userInfo.username);
            }
        }
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

// ⚡ Sync อัจฉริยะ 
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
                const targetUser = tokens.get(tokenStr);
                tokens.delete(tokenStr);
                if (targetUser) userActivity.delete(targetUser.username);

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
app.get('/health', (req, res) => res.status(200).json({ status: 'UP', players: wsMap.size, memory: process.memoryUsage().rss / 1024 / 1024, uptime: process.uptime() }));

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
        wsMap.get(userInfo.uuid).forEach(ws => { 
            if (ws.readyState === 1 && ws.bufferedAmount < 1048576) {
                ws.send(buffer, { binary: true }); 
            }
        });
    }
    res.send("success");
});

// ✅ [Fix 6] ใช้ Stream แทนการโหลดลง RAM (ป้องกัน RAM ระเบิด)
app.put('/api/avatar', async (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    
    userInfo.lastAccess = Date.now(); 
    userActivity.set(userInfo.username, "📤 กำลังอัปโหลดโมเดล...");
    
    const tempFile = path.join(avatarsDir, `${userInfo.uuid}_${Date.now()}.tmp`);
    const finalFile = path.join(avatarsDir, `${userInfo.uuid}.moon`);

    try {
        // ใช้ stream รับไฟล์ตรงๆ เขียนลงดิสก์
        await pipeline(req, fs.createWriteStream(tempFile));

        const stats = await fsp.stat(tempFile);
        if (stats.size === 0 || stats.size > LIMIT_BYTES) {
            await fsp.unlink(tempFile).catch(()=>{});
            
            if (stats.size > LIMIT_BYTES) {
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

        // อ่านเพื่อสร้าง Hash อย่างปลอดภัย หลังจากที่เขียนเป็นไฟล์แล้ว
        const fileBuffer = await fsp.readFile(tempFile);
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        
        await fsp.rename(tempFile, finalFile); 
        
        hashCache.set(userInfo.uuid, hash); 
        apiJsonCache.delete(userInfo.uuid); 
        saveCache(); 

        serverStats.totalUploads++;
        serverStats.totalBytes += stats.size;
        saveStatsDB();

        userActivity.set(userInfo.username, "✅ โมเดลพร้อมใช้งาน");
        
        if (wsMap.has(userInfo.uuid)) {
            const buffer = Buffer.allocUnsafe(17); buffer.writeUInt8(2, 0); 
            userInfo.hexUuidBuffer.copy(buffer, 1); 
            wsMap.get(userInfo.uuid).forEach(ws => { 
                if (ws.readyState === 1 && ws.bufferedAmount < 1048576) {
                    ws.send(buffer, { binary: true }); 
                }
            });
        }
        res.send("success"); 
    } catch (err) {
        await fsp.unlink(tempFile).catch(()=>{});
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
            wsMap.get(userInfo.uuid).forEach(ws => { 
                if (ws.readyState === 1 && ws.bufferedAmount < 1048576) {
                    ws.send(buffer, { binary: true }); 
                }
            });
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
// ⚡ WEBSOCKET (ULTRA-RESILIENT ENGINE)
// ==========================================
const server = http.createServer(app);
server.keepAliveTimeout = 120000;  
server.headersTimeout = 125000;    

const wss = new WebSocket.Server({ 
    server, 
    perMessageDeflate: false, 
    maxPayload: 2 * 1024 * 1024, 
    clientTracking: true
});

// ✅ [Fix 8] ตั้งลิมิต WS สูงสุด กันโดนยิง
const MAX_WS = 5000;

wss.on('connection', (ws) => {
    if (wss.clients.size > MAX_WS) {
        ws.terminate();
        return;
    }

    ws.isAlive = true; 
    ws.missedPings = 0; 
    
    ws.on('pong', () => { 
        ws.isAlive = true; 
        ws.missedPings = 0; 
    }); 

    ws.on('message', (data) => {
        try {
            if (!Buffer.isBuffer(data) || data.length < 1 || data.length > 1048576) return; 

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
                const newbuffer = Buffer.allocUnsafe(22 + (dataLen - 6));
                newbuffer.writeUInt8(0, 0); 
                userInfo.hexUuidBuffer.copy(newbuffer, 1); 
                newbuffer.writeInt32BE(data.readInt32BE(1), 17); 
                
                const isGlobal = data.readUInt8(5) !== 0 ? 1 : 0;
                newbuffer.writeUInt8(isGlobal, 21); 
                data.slice(6).copy(newbuffer, 22);
                
                const connections = wsMap.get(userInfo.uuid);
                if (connections) { 
                    // ✅ [Fix 4] Broadcast พังเวลา ws error แก้ด้วยการเช็คและเตะทิ้งถ้า Error
                    connections.forEach(tws => { 
                        if (tws.readyState !== 1) {
                            connections.delete(tws);
                            return;
                        }
                        try {
                            if ((isGlobal === 1 || tws !== ws) && tws.bufferedAmount < 1048576) {
                                tws.send(newbuffer, { binary: true });
                            } 
                        } catch (err) {
                            connections.delete(tws);
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
        tokenMap.delete(ws); 

        if (tokenStr && tokens.has(tokenStr)) {
            const userInfo = tokens.get(tokenStr);
            const uuid = userInfo.uuid;
            if (wsMap.has(uuid)) { 
                wsMap.get(uuid).delete(ws); 
                // ✅ [Fix 1] นำ tokens.delete(tokenStr) ออก ให้ GC จัดการ เพื่อไม่ให้หลุดมั่ว
            }
        }
    });
});

// ✅ [Fix 7] ปรับ Ping logic ให้เสถียรขึ้น เตะคนผิดน้อยลง
const wsPingInterval = setInterval(() => { 
    wss.clients.forEach((ws) => { 
        if (!ws.isAlive) {
            ws.missedPings++;
            if (ws.missedPings >= 6) { 
                ws.terminate();
                return;
            }
        } else {
            ws.missedPings = 0;
        }
        ws.isAlive = false; 
        if (ws.readyState === 1) ws.ping(); 
    }); 
}, WS_PING_INTERVAL_MS); 

wss.on('close', () => clearInterval(wsPingInterval));

// 🏗️ Graceful Shutdown
const shutdown = () => {
    console.log(`\n${c.y}${logTime()} ⚠️ กำลังเซฟข้อมูลและปิดเซิร์ฟเวอร์อย่างปลอดภัย...${c.rst}`);
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
    console.log(`${c.b}✨ BIGAVATAR CLOUD (ULTRA-ENGINE)${c.rst}`);
    console.log(`${c.g}✅ API Link: ${API_URL}${c.rst}`);
    console.log(`${c.g}🌍 Server Region: ${currentZone.name} ${currentZone.mcFlag}${c.rst}`);
    console.log(`${c.y}🛡️ Atomic File Save (Fix Model Corruptions): ACTIVE${c.rst}`);
    console.log(`${c.y}🛡️ WS Payload Cap (Anti-Memory Crash): ACTIVE${c.rst}`);
    console.log(`${c.y}⚡ Lag-Spike Tolerance (No Disconnects): ACTIVE${c.rst}`);
    console.log(`${c.p}==========================================${c.rst}\n`);
    sendToDiscord(`🚀 **[SYSTEM START]** เซิร์ฟเวอร์ Figura ออนไลน์แล้ว! 🌍 โซน: ${currentZone.name}`);
});
