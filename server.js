const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const access = require('./access');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Admin (access mode) ────────────────────────────────────
// Only reachable from inside the container (node cli.js ...). Requests coming
// through the Easypanel proxy carry X-Forwarded-For and are rejected.

function isLocalAdminRequest(req) {
    const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return (addr === '127.0.0.1' || addr === '::1') && !req.headers['x-forwarded-for'];
}

app.use('/admin', (req, res, next) => {
    if (!isLocalAdminRequest(req)) return res.status(404).end();
    next();
});

app.get('/admin/mode', (req, res) => {
    res.json({ mode: access.getMode(), turn: access.hasTurn(), broadcaster: !!broadcaster, clients: io.engine.clientsCount });
});

app.post('/admin/mode/:mode', (req, res) => {
    try {
        const mode = access.setMode(req.params.mode);
        console.log(`[access] mode changed to "${mode}"`);
        if (mode === 'remote' && !access.hasTurn()) {
            console.warn('[access] remote mode without TURN: connections behind CGNAT/4G will fail (set TURN_URLS + TURN_SECRET)');
        }
        // Every client picks up the new ICE config; the camera drops all current
        // peer connections so nobody keeps a stream negotiated under the old mode.
        io.emit('config', access.getClientConfig());
        res.json({ mode, turn: access.hasTurn() });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Signaling ──────────────────────────────────────────────

let broadcaster = null; // socket id of the camera
let broadcasterIp = null;

io.on('connection', (socket) => {
    socket.data.ip = access.clientIp(socket);
    console.log(`[connect] ${socket.id} (${socket.data.ip})`);
    socket.emit('config', access.getClientConfig());

    // Camera registers as broadcaster
    socket.on('register-broadcaster', () => {
        broadcaster = socket.id;
        broadcasterIp = socket.data.ip;
        console.log(`[broadcaster] ${socket.id}`);
        socket.emit('broadcaster-registered');
        // Notify any waiting viewers
        socket.broadcast.emit('broadcaster-available');
    });

    // Viewer wants to watch
    socket.on('request-offer', () => {
        if (!broadcaster) {
            socket.emit('no-broadcaster');
            return;
        }
        if (access.getMode() === 'local' && !access.sameNetwork(socket.data.ip, broadcasterIp)) {
            console.log(`[access] denied ${socket.id}: ${socket.data.ip} is not on the camera's network`);
            socket.emit('access-denied', { mode: 'local' });
            return;
        }
        console.log(`[viewer] ${socket.id} requesting offer from broadcaster`);
        // Ask broadcaster to create an offer for this viewer
        io.to(broadcaster).emit('viewer-joined', { viewerId: socket.id });
    });

    // Relay: broadcaster → viewer
    socket.on('offer', ({ viewerId, sdp }) => {
        console.log(`[offer] ${socket.id} → ${viewerId}`);
        io.to(viewerId).emit('offer', { sdp: access.filterSdp(sdp) });
    });

    // Relay: viewer → broadcaster
    socket.on('answer', ({ sdp }) => {
        if (broadcaster) {
            console.log(`[answer] ${socket.id} → ${broadcaster}`);
            io.to(broadcaster).emit('answer', { viewerId: socket.id, sdp: access.filterSdp(sdp) });
        }
    });

    // Relay ICE candidates both ways
    socket.on('ice-candidate', ({ candidate, target }) => {
        // Resolve 'broadcaster' alias so viewers can send without knowing the ID
        const resolvedTarget = target === 'broadcaster' ? broadcaster : target;
        const allowed = access.filterCandidate(candidate);
        if (resolvedTarget && allowed) {
            io.to(resolvedTarget).emit('ice-candidate', { candidate: allowed, from: socket.id });
        }
    });

    socket.on('camera-flip', () => {
        if (broadcaster) {
            io.to(broadcaster).emit('camera-flip');
        }
    });

    socket.on('night-mode', ({ enabled }) => {
        if (broadcaster) {
            console.log(`[night-mode] ${enabled ? 'ON' : 'OFF'}`);
            io.to(broadcaster).emit('night-mode-toggle', { enabled });
        }
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log(`[disconnect] ${socket.id}`);
        if (socket.id === broadcaster) {
            broadcaster = null;
            broadcasterIp = null;
            io.emit('broadcaster-left');
            console.log('[broadcaster] left');
        } else {
            // Notify broadcaster that a viewer left
            if (broadcaster) {
                io.to(broadcaster).emit('viewer-left', { viewerId: socket.id });
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`\n🎥 Kamera server running on port ${PORT}`);
    console.log(`   Camera:  http://localhost:${PORT}/camera.html`);
    console.log(`   Viewer:  http://localhost:${PORT}/`);
    console.log(`   Access:  ${access.getMode()}${access.getMode() === 'remote' && !access.hasTurn() ? ' (no TURN configured)' : ''}\n`);
});
