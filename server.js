const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

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

// ── Signaling ──────────────────────────────────────────────

let broadcaster = null; // socket id of the camera

io.on('connection', (socket) => {
    console.log(`[connect] ${socket.id}`);

    // Camera registers as broadcaster
    socket.on('register-broadcaster', () => {
        broadcaster = socket.id;
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
        console.log(`[viewer] ${socket.id} requesting offer from broadcaster`);
        // Ask broadcaster to create an offer for this viewer
        io.to(broadcaster).emit('viewer-joined', { viewerId: socket.id });
    });

    // Relay: broadcaster → viewer
    socket.on('offer', ({ viewerId, sdp }) => {
        console.log(`[offer] ${socket.id} → ${viewerId}`);
        io.to(viewerId).emit('offer', { sdp });
    });

    // Relay: viewer → broadcaster
    socket.on('answer', ({ sdp }) => {
        if (broadcaster) {
            console.log(`[answer] ${socket.id} → ${broadcaster}`);
            io.to(broadcaster).emit('answer', { viewerId: socket.id, sdp });
        }
    });

    // Relay ICE candidates both ways
    socket.on('ice-candidate', ({ candidate, target }) => {
        // Resolve 'broadcaster' alias so viewers can send without knowing the ID
        const resolvedTarget = target === 'broadcaster' ? broadcaster : target;
        if (resolvedTarget) {
            io.to(resolvedTarget).emit('ice-candidate', { candidate, from: socket.id });
        }
    });

    socket.on('camera-flip', () => {
        if (broadcaster) {
            io.to(broadcaster).emit('camera-flip');
        }
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log(`[disconnect] ${socket.id}`);
        if (socket.id === broadcaster) {
            broadcaster = null;
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
    console.log(`   Viewer:  http://localhost:${PORT}/\n`);
});
