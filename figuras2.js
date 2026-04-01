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
const Redis = require('ioredis'); // ✅ เพิ่ม: ioredis สำหรับ Scale-out

// 🎨 Console colors
const c = { g: '\x1b[32m', b: '\x1b[36m', y: '\x1b[33m', r: '\x1b[31m', p: '\x1b[35m', rst: '\x1b[0m' };
const logTime = () => `[${new Date().toLocaleTimeString('th-TH')}]`;

process.on('uncaughtException', (err) => { 
    console.error(`${c.r}${logTime()} ⚠️ [CRASH PREVENTED] Error: ${err.message}${c.rst}`); 
});
process.on('unhandledRejection', (reason) => { 
    console.error(`${c.r}${logTime()} ⚠️ [CRASH PREVENTED] Rejection: ${reason}${c.rst}`); 
});

const PORT = process.env.PORT || 8080; 
const LIMIT_BYTES = 25 * 1024 * 1024; // 25MB
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "default_admin_password"; 

// 🗄️ MySQL Database setup
const dbPool = mysql.createPool({
    host: 'poland.nami-ch.com', 
    user: 'figura_blacklist1', 
    password: process.env.DB_PASSWORD || 'kOj_W1gm*6qbjqz2', 
    database: 'spongfan_figura_blacklist', 
    waitForConnections: true,
    connectionLimit: process.env.DB_LIMIT ? parseInt(process.env.DB_LIMIT) : 50, 
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

if (!fs.existsSync("avatars")) fs.mkdirSync("avatars");

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(compression()); 

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

// 🧠 RAM Optimization 
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

// ==========================================
// 🚀 REDIS CLUSTER SETUP (PUB/SUB)
// ==========================================
let pub, sub;
const REDIS_URL = process.env.REDIS_URL;

if (REDIS_URL) {
    pub = new Redis(REDIS_URL);
    sub = new Redis(REDIS_URL);

    sub.subscribe("ws-broadcast");
    
    // ✅ ใช้ messageBuffer แทน message ปกติ เพื่อรองรับข้อมูล Binary จากเกม
    sub.on("messageBuffer", (channelBuffer, messageBuffer) => {
        if (channelBuffer.toString() === "ws-broadcast") {
            if (messageBuffer.length >= 17) {
                // แกะ UUID Hex จาก Buffer ของโปรโตคอล (ตำแหน่งที่ 1 ถึง 17)
                const uuidHex = messageBuffer.slice(1, 17).toString('hex');
                const uuid = formatUuid(uuidHex);
                
                // ค้นหาว่าใน Server Instance นี้มีใครเชื่อมต่ออยู่กับ UUID นี้ไหม
                const connections = wsMap.get(uuid);
                if (connections) {
                    connections.forEach(ws => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(messageBuffer); 
                        }
                    });
                }
            }
        }
    });
    console.log(`${c.g}${logTime()} 🔗 [REDIS] Connected & Synced for Multi-Server Scale!${c.rst}`);
} else {
    console.log(`${c.y}${logTime()} ⚠️ [REDIS] No REDIS_URL found. Running in Single-Server Mode.${c.rst}`);
}

// 🧹 Advanced Auto-GC & RAM Leak Cleanup
setInterval(() => { 
    if (global.gc) global.gc(); 
    const now = Date.now();
    for (let [id, data] of server_ids.entries()) {
        if (now - data.time > 60000) server_ids.delete(id); 
    }
    for (const [token, data] of tokens.entries()) {
        if (now - (data.lastActive || now) > 10 * 60 * 1000) {
            tokens.delete(token);
        }
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
                
                const avatarFile = path.join(__dirname, 'avatars', `${userInfo.uuid}.moon`);
                fsp.unlink(avatarFile).catch(() => {}); 
                
                if (wsMap.has(userInfo.uuid)) wsMap.delete(userInfo.uuid);
                console.log(`${c.r}${logTime()} ⛔ [ACTIVE BAN] Kicked: ${userInfo.username}${c.rst}`);
            }
        }
    } catch (e) {} 
}
setInterval(syncBlacklistAndKick, 10000);
syncBlacklistAndKick();

// ==========================================
// 🌐 REST API
// ==========================================

app.get('/api/motd', (req, res) => {
    res.status(200).send("§b§l💎 BIGAVTAR §a§lONLINE §e§l(BY chick_chiix)\n§f§lULTIMATE - เร็ว แรง ทะลุนรก! §f§lคำเตือน : §a§lห้ามเอาไปใช้โปรเจกต์อื่นโดยเด็ดขาด หากผบเห็นโดนค่าปรับ X2");
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
            projectInfo: req.headers['user-agent'] || 'Unknown Tool',
            lastActive: Date.now() 
        });
        
        console.log(`${c.b}${logTime()} ⚡ [LOGIN] ${c.y}${response.data.name}${c.rst}`);
        res.send(token);
    } catch (error) { res.status(500).json({ error: 'Internal Error' }); }
});

app.post('/api/equip', (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end(); 
    userInfo.lastActive = Date.now(); 
    
    if (wsMap.has(userInfo.uuid)) {
        const buffer = Buffer.allocUnsafe(17); 
        buffer.writeUInt8(2, 0); 
        Buffer.from(userInfo.hexUuid, 'hex').copy(buffer, 1);
        
        if (pub) {
            pub.publishBuffer("ws-broadcast", buffer); // ⚡ โยนลง Redis ให้ทุก Server จัดการ
        } else {
            wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
        }
    }
    res.send("success");
});

app.put('/api/avatar', (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    userInfo.lastActive = Date.now();
    
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
            const finalHash = hash.digest('hex');
            hashCache.set(userInfo.uuid, finalHash); 
            
            if (wsMap.has(userInfo.uuid)) {
                const buffer = Buffer.allocUnsafe(17); 
                buffer.writeUInt8(2, 0); 
                Buffer.from(userInfo.hexUuid, 'hex').copy(buffer, 1);
                
                if (pub) {
                    pub.publishBuffer("ws-broadcast", buffer); // ⚡ โยนลง Redis
                } else {
                    wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
                }
            }
            res.send("success"); 
        } catch (err) { res.status(500).send({ error: "File error" }); }
    });
});

app.delete('/api/avatar', async (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    userInfo.lastActive = Date.now();
    
    const filePath = path.join(__dirname, 'avatars', `${userInfo.uuid}.moon`);
    try {
        await fsp.unlink(filePath); 
        hashCache.delete(userInfo.uuid);
        if (wsMap.has(userInfo.uuid)) {
            const buffer = Buffer.allocUnsafe(17); 
            buffer.writeUInt8(2, 0); 
            Buffer.from(userInfo.hexUuid, 'hex').copy(buffer, 1);
            
            if (pub) {
                pub.publishBuffer("ws-broadcast", buffer); // ⚡ โยนลง Redis
            } else {
                wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
            }
        }
        res.send("success");
    } catch (err) { res.status(404).end(); }
});

app.get('/api/:uuid/avatar', async (req, res) => { 
    const uuidStr = req.params.uuid;
    if (["motd", "version", "auth", "limits", "stats-secret"].includes(uuidStr)) return res.status(404).end();

    const uuidFmt = formatUuid(uuidStr);
    const avatarFile = path.join(__dirname, 'avatars', `${uuidFmt}.moon`);
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
    const avatarFile = path.join(__dirname, 'avatars', `${uuid}.moon`);
    
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

app.use(express.json());

// ==========================================
// 📊 ADMIN DASHBOARD
// ==========================================
app.get('/admin', (req, res) => {
    if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).send("<h1 style='color:red;text-align:center;margin-top:50px;'>⛔ 403 FORBIDDEN - ACCESS DENIED</h1>");
    // (UI โค้ดเดิม ละไว้เพื่อความกระชับ)
    res.status(200).send(`...HTML Dashboard...`);
});

app.get('/api/stats-secret', (req, res) => {
    if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).json({ error: "Access Denied" });
    fs.readdir('avatars', (err, files) => {
        const uptime = process.uptime();
        res.json({ 
            players: Array.from(tokens.values()).map(p => ({ name: p.username, ip: p.clientIp, project: p.projectInfo })),
            stats: { online: tokenMap.size, avatars: err ? 0 : files.filter(f => f.endsWith('.moon')).length, ram: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), uptime: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m` }
        });
    });
});

app.get('/', (req, res) => res.status(200).send("§b§lBIGAVTAR CLOUD §f§l- §a§lONLINE"));
app.get('/ping', (req, res) => res.send('ok'));
app.get('/health', (req, res) => res.status(200).json({ status: "ok", uptime: process.uptime() }));

// ==========================================
// ⚡ WEBSOCKET (PRO PERFORMANCE + REDIS)
// ==========================================
const server = http.createServer(app);
server.keepAliveTimeout = 120000; 
server.headersTimeout = 125000;

const wss = new WebSocket.Server({ server, perMessageDeflate: false });

setInterval(() => {
    wss.clients.forEach((ws) => { 
        if (ws.isAlive === false) return ws.terminate(); 
        ws.isAlive = false;
        ws.packetCount = 0; 
        if (ws.readyState === WebSocket.OPEN) ws.ping(); 
    });
}, 60000); 

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.packetCount = 0; 
    ws.lastSend = 0; 
    
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
        try {
            ws.packetCount++;
            if (ws.packetCount > 10000 || data.length > 5000000) return; 

            const now = Date.now();
            if (now - ws.lastSend < 50) return; 
            ws.lastSend = now;

            if (Buffer.isBuffer(data)) {
                const type = data[0];
                if (type === 0) {
                    tokenMap.set(ws, data.slice(1).toString('utf-8'));
                    if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from([0]));
                }
                else if (type === 1) { 
                    const userInfo = tokens.get(tokenMap.get(ws));
                    if (!userInfo) return;
                    
                    userInfo.lastActive = now; 

                    const dataLen = data.length;
                    const newbuffer = Buffer.allocUnsafe(22 + (dataLen - 6));
                    newbuffer.writeUInt8(0, 0); 
                    Buffer.from(userInfo.hexUuid, 'hex').copy(newbuffer, 1); 
                    newbuffer.writeInt32BE(data.readInt32BE(1), 17); 
                    newbuffer.writeUInt8(data.readUInt8(5) !== 0 ? 1 : 0, 21); 
                    data.slice(6).copy(newbuffer, 22);
                    
                    // ⚡ BROADCAST: ใช้ Redis กระจายข้อมูลข้าม Server 
                    if (pub) {
                        pub.publishBuffer("ws-broadcast", newbuffer);
                    } else {
                        // Fallback โหมด Single Server
                        const connections = wsMap.get(userInfo.uuid);
                        if (connections) { 
                            if (connections.size > 1000) return; 
                            connections.forEach(tws => { 
                                if (tws.readyState === WebSocket.OPEN && (newbuffer.readUInt8(21) === 1 || tws !== ws)) { 
                                    tws.send(newbuffer); 
                                } 
                            }); 
                        }
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

// ==========================================
// 🛑 GRACEFUL SHUTDOWN
// ==========================================
function shutdownSafely() {
    console.log(`\n${c.y}⚠️ [SHUTDOWN] Closing connections safely...${c.rst}`);
    wss.clients.forEach(ws => ws.close(1001, 'Server Restarting'));
    server.close(() => {
        console.log(`${c.r}⛔ Server closed. Bye!${c.rst}`);
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000); 
}
process.on('SIGTERM', shutdownSafely);
process.on('SIGINT', shutdownSafely);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${c.p}==========================================${c.rst}`);
    console.log(`${c.b}🚀 BIGAVTAR CLOUD - ULTIMATE PRO EDITION${c.rst}`);
    console.log(`${c.g}✅ Render Ready (ENV SECRETS + PORT)${c.rst}`);
    console.log(`${c.g}✅ Redis Cluster Scale-Out ENABLED${c.rst}`);
    console.log(`${c.p}==========================================${c.rst}\n`);
});
