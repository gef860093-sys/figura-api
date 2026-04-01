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

// 🎨 Console colors
const c = { g: '\x1b[32m', b: '\x1b[36m', y: '\x1b[33m', r: '\x1b[31m', p: '\x1b[35m', rst: '\x1b[0m' };
const logTime = () => `[${new Date().toLocaleTimeString('th-TH')}]`;

process.on('uncaughtException', (err) => { 
    console.error(`${c.r}${logTime()} ⚠️ [CRASH PREVENTED] Error: ${err.message}${c.rst}`); 
});
process.on('unhandledRejection', (reason) => { 
    console.error(`${c.r}${logTime()} ⚠️ [CRASH PREVENTED] Rejection: ${reason}${c.rst}`); 
});

const PORT = 8080; 
const LIMIT_BYTES = 900000 * 1024 * 1024; // 25MB
const ADMIN_PASSWORD = "k0936738325@";

// 🗄️ MySQL Database setup
const dbPool = mysql.createPool({
    host: 'poland.nami-ch.com', 
    user: 'figura_blacklist1', 
    password: 'kOj_W1gm*6qbjqz2', 
    database: 'spongfan_figura_blacklist', 
    waitForConnections: true,
    connectionLimit: 20, 
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

if (!fs.existsSync("avatars")) fs.mkdirSync("avatars");

const app = express();
app.set('trust proxy', 1);
app.use(cors());

// 🛡️ ขยาย Rate Limit ให้รองรับเน็ตแรงๆ ได้แบบไม่โดนเตะ
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 2000, // ขยายเพดานเป็น 2,000 รีเควสต่อนาที
    message: { error: "Too many requests, please try again later." }
});
app.use('/api/', apiLimiter);

// 🛠️ แก้ไขบัค URL ซ้อน (เช่น //api//auth) ที่ทำให้ตัวเกมสับสน
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

// 🧹 Auto-GC Server Cleanup
setInterval(() => { 
    if (global.gc) global.gc(); 
    const now = Date.now();
    for (let [id, data] of server_ids.entries()) {
        if (now - data.time > 60000) server_ids.delete(id); 
    }
}, 10 * 60 * 1000);

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
// 🌐 REST API (FIXED ROUTING PATHS)
// ==========================================

// ✅ เรียง API ที่มีชื่อเฉพาะตัว (Static) ไว้ด้านบนสุด เพื่อป้องกันการทับซ้อนกับ Dynamic UUID

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
            projectInfo: req.headers['user-agent'] || 'Unknown Tool'
        });
        
        console.log(`${c.b}${logTime()} ⚡ [LOGIN] ${c.y}${response.data.name}${c.rst}`);
        res.send(token);
    } catch (error) { res.status(500).json({ error: 'Internal Error' }); }
});

// ✅ แก้ไข: กู้คืนระบบ Equip เพื่อลดบัค "Failed to set equipped Avatars"
app.post('/api/equip', (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end(); 
    
    // อัปเดตสถานะการสวมใส่ชุดให้คนในเกมเห็น
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
                wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
            }
            res.send("success"); 
        } catch (err) { res.status(500).send({ error: "File error" }); }
    });
});

app.delete('/api/avatar', async (req, res) => {
    const userInfo = tokens.get(req.headers['token']);
    if (!userInfo) return res.status(401).end();
    const filePath = path.join(__dirname, 'avatars', `${userInfo.uuid}.moon`);
    try {
        await fsp.unlink(filePath); 
        hashCache.delete(userInfo.uuid);
        if (wsMap.has(userInfo.uuid)) {
            const buffer = Buffer.allocUnsafe(17); 
            buffer.writeUInt8(2, 0); 
            Buffer.from(userInfo.hexUuid, 'hex').copy(buffer, 1);
            wsMap.get(userInfo.uuid).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(buffer); });
        }
        res.send("success");
    } catch (err) { res.status(404).end(); }
});

// ✅ แก้ไข: เพิ่มการเช็คตัวแปรที่ผิดปกติ (ป้องกันบัค uuid กลายเป็น motd/version/auth)
app.get('/api/:uuid/avatar', async (req, res) => { 
    const uuidStr = req.params.uuid;
    // ป้องกัน Reserved Words วิ่งเข้ามารบกวน
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
    // ป้องกัน Reserved Words วิ่งเข้ามารบกวน
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

// เปิดใช้ express.json() ทั่วไปสำหรับ Route Dashboard ด้านล่าง
app.use(express.json());

// ==========================================
// 📊 ADMIN DASHBOARD (Cyberpunk UI)
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
            players: Array.from(tokens.values()).map(p => ({ 
                name: p.username, ip: p.clientIp, project: p.projectInfo 
            })),
            stats: { 
                online: tokenMap.size, 
                avatars: err ? 0 : files.filter(f => f.endsWith('.moon')).length, 
                ram: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), 
                uptime: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m` 
            }
        });
    });
});

app.get('/', (req, res) => {
    res.status(200).send("§b§lBIGAVTAR CLOUD §f§l- §a§lONLINE");
});

// ==========================================
// ⚡ WEBSOCKET (FIXED ANTI-SPAM DISCONNECTS)
// ==========================================
const server = http.createServer(app);
server.keepAliveTimeout = 120000; 
server.headersTimeout = 125000;

const wss = new WebSocket.Server({ server, perMessageDeflate: false });

// 🛡️ ขยายเวลาตรวจสอบเพื่อให้เกมไม่ต้องส่ง Ping ถี่เกินไป
setInterval(() => {
    wss.clients.forEach((ws) => { 
        if (ws.isAlive === false) return ws.terminate(); 
        ws.isAlive = false;
        ws.packetCount = 0; 
        if (ws.readyState === WebSocket.OPEN) ws.ping(); 
    });
}, 60000); // เช็คทุก 1 นาที

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.packetCount = 0; 
    
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
        try {
            // ✅ แก้ไข: ขยายเพดานรับส่งให้กว้างขึ้นสุดๆ เพื่อไม่ให้คนเน็ตแรงโดนเตะ (ปล่อยให้วิ่งอิสระ)
            ws.packetCount++;
            if (ws.packetCount > 10000 || data.length > 5000000) return; // ถ้าส่งเกินหมื่นครั้งใน 1 นาที ให้แค่เมิน ไม่เตะทิ้ง

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
                    const uuid = `${uuidHex.slice(0,8)}-${uuidHex.slice(8,12)}-${uuidHex.slice(12,16)}-${uuidHex.slice(16,20)}-${uuidHex.slice(20)}`;
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
    console.log(`${c.b}🚀 BIGAVTAR CLOUD - OMEGA EDITION (BUG FREE)${c.rst}`);
    console.log(`${c.g}✅ API Path Fixed & Disconnect Bugs Destroyed!${c.rst}`);
    console.log(`${c.p}==========================================${c.rst}\n`);
});
