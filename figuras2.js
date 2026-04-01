require('dotenv').config();
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
const Redis = require('ioredis');

// 🎨 Console colors & Env Config
const c = { g: '\x1b[32m', b: '\x1b[36m', y: '\x1b[33m', r: '\x1b[31m', p: '\x1b[35m', rst: '\x1b[0m' };
const logTime = () => `[${new Date().toLocaleTimeString('th-TH')}]`;
const isProd = process.env.NODE_ENV === 'production';

// 🛑 1. Stability: ป้องกันเซิร์ฟเวอร์ดับ (Uncaught/Unhandled)
process.on('uncaughtException', (err) => { 
    fs.appendFileSync("error.log", `${logTime()} [Uncaught Exception] ${err.stack}\n`);
    console.error(`${c.r}${logTime()} ⚠️ [CRASH PREVENTED] Error: ${err.message}${c.rst}`); 
});
process.on('unhandledRejection', (reason) => { 
    fs.appendFileSync("error.log", `${logTime()} [Unhandled Rejection] ${reason}\n`);
    console.error(`${c.r}${logTime()} ⚠️ [CRASH PREVENTED] Rejection: ${reason}${c.rst}`); 
});

const PORT = process.env.PORT || 8080; 
const LIMIT_BYTES = 35 * 1024 * 1024; // 35MB
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; 

// 🗄️ MySQL Database setup
const dbPool = mysql.createPool({
    host: process.env.DB_HOST, 
    user: process.env.DB_USER, 
    password: process.env.DB_PASS, 
    database: process.env.DB_NAME, 
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

// ⚡ 2. Performance: FastSend ลดภาระ Loop
function fastSend(connections, data, excludeWs = null) {
    if (!connections) return;
    for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN && ws !== excludeWs) {
            ws.send(data, { binary: true }, () => {}); 
        }
    }
}

// 🚀 3. Scale: Redis Integration (Base64 Broadcast)
let pub, sub;
const REDIS_URL = process.env.REDIS_URL;

if (REDIS_URL) {
    pub = new Redis(REDIS_URL);
    sub = new Redis(REDIS_URL);

    pub.on("connect", () => {
        console.log(`${c.g}${logTime()} ✅ Redis Publisher Connected${c.rst}`);
    });
    
    pub.on("error", (err) => {
        console.error(`${c.r}${logTime()} ❌ Redis Error: ${err.message}${c.rst}`);
    });

    // 🧪 ทดสอบง่ายสุด (เพิ่มชั่วคราวเช็คชัวร์)
    (async () => {
        try {
            await pub.set("test_connection", "ok", "EX", 60);
            const val = await pub.get("test_connection");
            console.log(`${c.g}${logTime()} 🧪 Redis Test SUCCESS: ${val}${c.rst}`);
        } catch (e) {
            console.error(`${c.r}${logTime()} ❌ Redis Test FAIL: ${e.message}${c.rst}`);
        }
    })();

    sub.subscribe("ws-broadcast");
    
    sub.on("message", (channel, msg) => {
        if (channel === "ws-broadcast") {
            try {
                // แปลง Base64 กลับเป็น Buffer
                const messageBuffer = Buffer.from(msg, "base64");
                if (messageBuffer.length >= 17) {
                    const uuidHex = messageBuffer.slice(1, 17).toString('hex');
                    const uuid = formatUuid(uuidHex);
                    fastSend(wsMap.get(uuid), messageBuffer); 
                }
            } catch (e) {
                if (!isProd) console.error("Redis Decode Error", e);
            }
        }
    });
} else {
    console.log(`${c.y}${logTime()} ⚠️ Running in Single-Server Mode (No Redis)${c.rst}`);
}

function broadcast(bufferData) {
    if (pub) {
        pub.publish("ws-broadcast", bufferData.toString("base64"));
    }
}

// 🧹 Auto-GC & RAM Leak Cleanup
setInterval(() => { 
    if (global.gc) global.gc(); 
    const now = Date.now();
    for (let [id, data] of server_ids.entries()) {
        if (now - data.time > 60000) server_ids.delete(id); 
    }
}, 5 * 60 * 1000); 

setInterval(() => {
    const now = Date.now();
    for (const [token, data] of tokens.entries()) {
        if (now - (data.lastActive || now) > 60 * 60 * 1000) tokens.delete(token);
    }
}, 60 * 60 * 1000);

// ⚡ Active Kick (Sync Database ทุก 30 วิ)
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
            }
        }
    } catch (e) {} 
}
setInterval(syncBlacklistAndKick, 30000); 
syncBlacklistAndKick();

// ==========================================
// 🌐 REST API
// ==========================================
app.get('/api/motd', (req, res) => res.status(200).send("§b§l💎 BIGAVTAR §a§lONLINE"));
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
        
        const response = await fastAxios.get("https://sessionserver.mojang.com/session/minecraft/hasJoined", { params: { username: sessionData.username, serverId: sid } });
        server_ids.delete(sid); 
        
        const token = crypto.randomBytes(16).toString('hex');
        const hexUuid = response.data.id;
        
        tokens.set(token, { 
            uuid: formatUuid(hexUuid), hexUuid: hexUuid, username: response.data.name,
            clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            projectInfo: req.headers['user-agent'] || 'Unknown Tool', lastActive: Date.now() 
        });
        
        if (!isProd) console.log(`${c.b}${logTime()} ⚡ [LOGIN] ${c.y}${response.data.name}${c.rst}`);
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
        
        if (pub) broadcast(buffer);
        else fastSend(wsMap.get(userInfo.uuid), buffer);
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
                
                if (pub) broadcast(buffer);
                else fastSend(wsMap.get(userInfo.uuid), buffer);
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
            
            if (pub) broadcast(buffer);
            else fastSend(wsMap.get(userInfo.uuid), buffer);
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
        res.setHeader('Content-Type', 'application/json'); 
        res.sendFile(avatarFile);
    } catch (e) { res.status(404).end(); }
});

app.get('/api/:uuid', async (req, res) => {
    const uuidStr = req.params.uuid;
    if (["motd", "version", "auth", "limits", "stats-secret"].includes(uuidStr)) return res.status(404).end();

    const uuid = formatUuid(uuidStr);
    if (!uuid) return res.status(404).end();

    const data = { uuid: uuid, rank: "normal", equipped: [], lastUsed: new Date().toISOString(), version: "0.1.5", banned: false };
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

// 🧠 4. Health Check แบบ Production
app.get('/health', (req, res) => {
    res.json({
        status: "ok",
        uptime: process.uptime(),
        memory_heapUsed_MB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });
});

app.get('/ping', (req, res) => res.send('ok'));
app.use(express.json());

// ==========================================
// 📊 ADMIN DASHBOARD
// ==========================================
app.get('/admin', (req, res) => {
    if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).send("<h1 style='color:red;text-align:center;margin-top:50px;'>⛔ 403 FORBIDDEN - ACCESS DENIED</h1>");
    res.status(200).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>BIGAVTAR Command Center</title>
            <style>
                body { background: #0a0a0c; color: #0ff; font-family: 'Segoe UI', monospace; display: flex; flex-direction: column; align-items: center; padding: 40px; margin: 0; }
                .container { width: 100%; max-width: 1000px; background: rgba(0, 255, 255, 0.03); padding: 30px; border-radius: 15px; border: 1px solid rgba(0, 255, 255, 0.3); box-shadow: 0 0 30px rgba(0, 255, 255, 0.1); }
                h1 { text-shadow: 0 0 15px #0ff; text-align: center; margin-top: 0; }
                .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 30px; }
                .card { background: #111; padding: 20px; border-radius: 10px; text-align: center; border: 1px solid #333; }
                .card span { display: block; font-size: 2em; font-weight: bold; color: #fff; text-shadow: 0 0 10px #fff; }
                .card small { color: #0ff; text-transform: uppercase; font-size: 0.8em; letter-spacing: 1px; }
                table { width: 100%; border-collapse: collapse; background: #0d0d12; border-radius: 8px; overflow: hidden; }
                th, td { padding: 15px; text-align: left; border-bottom: 1px solid #222; color: #ccc; }
                th { background: rgba(0, 255, 255, 0.1); color: #0ff; }
                .ip { color: #ffeb3b; letter-spacing: 1px; }
                .proj { color: #03a9f4; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>⚡ BIGAVTAR COMMAND CENTER</h1>
                <div class="grid">
                    <div class="card"><span id="s-online">0</span><small>Players Online</small></div>
                    <div class="card"><span id="s-avatars">0</span><small>Saved Avatars</small></div>
                    <div class="card"><span id="s-ram">0</span><small>RAM (MB)</small></div>
                    <div class="card"><span id="s-uptime">0h 0m</span><small>Uptime</small></div>
                </div>
                <table>
                    <thead>
                        <tr><th>Username</th><th>IP Address</th><th>Project / Version</th></tr>
                    </thead>
                    <tbody id="pTable">
                        <tr><td colspan="3" style="text-align:center;">Loading...</td></tr>
                    </tbody>
                </table>
            </div>
            <script>
                async function update() {
                    try {
                        const res = await fetch('/api/stats-secret?pw=${ADMIN_PASSWORD}');
                        const d = await res.json();
                        document.getElementById('s-online').innerText = d.stats.online;
                        document.getElementById('s-avatars').innerText = d.stats.avatars;
                        document.getElementById('s-ram').innerText = d.stats.ram;
                        document.getElementById('s-uptime').innerText = d.stats.uptime;
                        const tb = document.getElementById('pTable');
                        if (d.players.length === 0) {
                            tb.innerHTML = '<tr><td colspan="3" style="text-align:center;">No players online</td></tr>';
                        } else {
                            tb.innerHTML = d.players.map(p => '<tr><td><b style="color:#fff">' + p.name + '</b></td><td class="ip">' + p.ip + '</td><td class="proj">' + p.project + '</td></tr>').join('');
                        }
                    } catch(e) {}
                } 
                update(); 
                setInterval(update, 3000);
            </script>
        </body>
        </html>
    `);
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

// ==========================================
// ⚡ WEBSOCKET (LOW LATENCY + ANTI-SPAM)
// ==========================================
const server = http.createServer(app);
server.keepAliveTimeout = 60000;  
server.headersTimeout = 65000;

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
            if (ws.packetCount > 5000) return; 
            if (data.length > 1000000) return; 

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
                    userInfo.lastActive = Date.now(); 

                    const dataLen = data.length;
                    const newbuffer = Buffer.allocUnsafe(22 + (dataLen - 6));
                    newbuffer.writeUInt8(0, 0); 
                    Buffer.from(userInfo.hexUuid, 'hex').copy(newbuffer, 1); 
                    newbuffer.writeInt32BE(data.readInt32BE(1), 17); 
                    newbuffer.writeUInt8(data.readUInt8(5) !== 0 ? 1 : 0, 21); 
                    data.slice(6).copy(newbuffer, 22);
                    
                    if (pub) {
                        broadcast(newbuffer); 
                    } else {
                        const connections = wsMap.get(userInfo.uuid);
                        if (connections) fastSend(connections, newbuffer, newbuffer.readUInt8(21) === 1 ? null : ws);
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

// 🛑 Graceful Shutdown
function shutdownSafely() {
    if (!isProd) console.log(`\n${c.y}⚠️ [SHUTDOWN] Closing connections safely...${c.rst}`);
    wss.clients.forEach(ws => ws.close(1001, 'Server Restarting'));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000); 
}
process.on('SIGTERM', shutdownSafely);
process.on('SIGINT', shutdownSafely);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${c.p}==========================================${c.rst}`);
    console.log(`${c.b}🚀 BIGAVTAR CLOUD - FULL PRODUCTION GRADE${c.rst}`);
    console.log(`${c.g}✅ Redis Base64 Broadcast & FastSend${c.rst}`);
    console.log(`${c.g}✅ Production Logging & Health Checks${c.rst}`);
    console.log(`${c.g}✅ ENV Secrets & RAM Cleanup${c.rst}`);
    console.log(`${c.p}==========================================${c.rst}\n`);
});
