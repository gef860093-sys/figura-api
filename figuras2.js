const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// ================== CONFIG ==================
const PORT = process.env.PORT || 8080;
const LIMIT_BYTES = 25 * 1024 * 1024;

// ================== APP ==================
const app = express();
app.use(express.json());

// ================== FOLDER ==================
if (!fs.existsSync("avatars")) fs.mkdirSync("avatars");

// ================== DATABASE ==================
const dbPool = mysql.createPool({
    host: 'poland.nami-ch.com',
    user: 'figura_blacklist1',
    password: 'kOj_W1gm*6qbjqz2',
    database: 'spongfan_figura_blacklist',
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

// ================== MEMORY ==================
const tokens = new Map();
const wsMap = new Map();

// ================== HEALTH CHECK ==================
app.get('/', (req, res) => res.send("OK"));
app.get('/ping', (req, res) => res.send("pong"));

// ================== API ==================
app.get('/api/version', (req, res) => {
    res.json({ version: "1.0.0" });
});

// ================== AVATAR ==================
app.put('/api/avatar', (req, res) => {
    const uuid = req.headers['uuid'];
    if (!uuid) return res.status(401).end();

    const file = path.join(__dirname, 'avatars', `${uuid}.moon`);
    const stream = fs.createWriteStream(file);

    req.pipe(stream);

    req.on('end', () => {
        res.send("uploaded");
    });
});

// ================== WEBSOCKET ==================
const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.isAlive = true;

    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', (msg) => {
        // basic echo
        ws.send(msg);
    });

    ws.on('close', () => {});
});

// ================== KEEP ALIVE ==================
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// ================== ERROR HANDLING ==================
process.on('uncaughtException', err => console.error(err));
process.on('unhandledRejection', err => console.error(err));

// ================== TIMEOUT ==================
server.timeout = 120000;

// ================== START ==================
server.listen(PORT, '0.0.0.0', () => {
    console.log("Server running on port " + PORT);
});
