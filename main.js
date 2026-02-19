const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const os = require("os");
const path = require("path");
const fs = require("fs");

// ============ 配置常量 ============
const ENABLE_FILE_LOGGING = true;  // 设置为 false 可以关闭文件日志写入

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

// ============ 日志文件初始化 ============
let logStream = null;
let serverLogFile = null;
let clientLogFile = null;

if (ENABLE_FILE_LOGGING) {
    const logDir = path.join(__dirname, "logs");
    serverLogFile = path.join(logDir, "server.log");
    clientLogFile = path.join(logDir, "client.log");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(serverLogFile, "");
    fs.writeFileSync(clientLogFile, "");

    logStream = fs.createWriteStream(serverLogFile, { flags: "a" });
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = (chunk, encoding, cb) => {
        logStream.write(chunk, encoding);
        return originalStdoutWrite(chunk, encoding, cb);
    };

    process.stderr.write = (chunk, encoding, cb) => {
        logStream.write(chunk, encoding);
        return originalStderrWrite(chunk, encoding, cb);
    };
}

let broadcasters = {};

function getLocalIPv4Address() {
    const networkInterfaces = os.networkInterfaces();
    for (const interfaceName in networkInterfaces) {
        const networkInterface = networkInterfaces[interfaceName];
        for (const alias of networkInterface) {
            if (alias.family === "IPv4" && !alias.internal) {
                return alias.address;
            }
        }
    }
    return "127.0.0.1";
}

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("clientLog", (entry) => {
        if (!ENABLE_FILE_LOGGING) return;

        try {
            const payload = {
                ts: new Date().toISOString(),
                socketId: socket.id,
                address: socket.handshake && socket.handshake.address ? socket.handshake.address : "unknown",
                ...entry,
            };
            fs.appendFile(clientLogFile, JSON.stringify(payload) + "\n", () => {});
        } catch (e) {
            console.error("Log write failed:", e.message);
        }
    });

    socket.on("broadcaster", () => {
        broadcasters[socket.id] = socket;
        console.log("Broadcaster registered:", socket.id);
        socket.broadcast.emit("broadcaster");
    });

    socket.on("watcher", () => {
        console.log("Watcher connected:", socket.id);
        Object.values(broadcasters).forEach((broadcasterSocket) => {
            broadcasterSocket.emit("watcher", socket.id);
        });
    });

    socket.on("offer", (id, offer) => {
        io.to(id).emit("offer", socket.id, offer);
    });

    socket.on("answer", (id, answer) => {
        io.to(id).emit("answer", socket.id, answer);
    });

    socket.on("candidate", (id, candidate) => {
        // Chrome 75+ 用 mDNS (.local) 隐藏真实 IP，旧浏览器无法解析
        // 服务器端替换为发送者的真实 LAN IP
        if (candidate && candidate.candidate && candidate.candidate.includes('.local')) {
            let senderIP = socket.handshake.address;
            if (senderIP === '::1' || senderIP === '127.0.0.1' || senderIP === '::ffff:127.0.0.1') {
                senderIP = getLocalIPv4Address();
            } else {
                senderIP = senderIP.replace('::ffff:', '');
            }
            candidate = {
                ...candidate,
                candidate: candidate.candidate.replace(/[a-f0-9-]+\.local/g, senderIP)
            };
            console.log(`[mDNS-FIX] Replaced .local with ${senderIP}`);
        }
        io.to(id).emit("candidate", socket.id, candidate);
    });

    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
        delete broadcasters[socket.id];
        socket.broadcast.emit("clientDisconnected", socket.id);
    });
});

app.get("/ip", (req, res) => {
    res.json({ ip: getLocalIPv4Address() });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
