(() => {
    'use strict';

    // ── DOM Elements ─────────────────────────────────
    const setupScreen = document.getElementById('setupScreen');
    const cameraPreview = document.getElementById('cameraPreview');
    const topBar = document.getElementById('topBar');
    const bottomBar = document.getElementById('bottomBar');
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');
    const localVideo = document.getElementById('localVideo');
    const statusBadge = document.getElementById('statusBadge');
    const statusText = document.getElementById('statusText');
    const viewerNum = document.getElementById('viewerNum');
    const btnGoToViewer = document.getElementById('btnGoToViewer');
    const btnFlip = document.getElementById('btnFlip');

    // ── State ────────────────────────────────────────
    const socket = io();
    let localStream = null;
    const peerConnections = {}; // viewerId → RTCPeerConnection
    let viewerCount = 0;
    let currentFacingMode = 'environment'; // Start with back camera

    const ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
    ];

    // ── UI Events ────────────────────────────────────

    // Switch to Viewer
    btnGoToViewer.addEventListener('click', () => {
        window.location.href = '/';
    });

    // ── Start Camera ─────────────────────────────────
    btnStart.addEventListener('click', async () => {
        try {
            btnStart.disabled = true;
            btnStart.textContent = 'Abrindo câmera…';

            localStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: currentFacingMode },
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                },
                audio: true,
            });

            localVideo.srcObject = localStream;

            // Show camera UI
            setupScreen.style.display = 'none';
            cameraPreview.style.display = 'block';
            topBar.style.display = 'flex';
            bottomBar.style.display = 'flex';

            // Register as broadcaster
            socket.emit('register-broadcaster');
            setStatus('connecting', 'Aguardando viewer…');

        } catch (err) {
            console.error('Failed to get media:', err);
            btnStart.disabled = false;
            btnStart.textContent = 'Iniciar Câmera';
            alert('Não foi possível acessar a câmera. Verifique as permissões.');
        }
    });

    // ── Stop Camera ──────────────────────────────────
    btnStop.addEventListener('click', () => {
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }

        // Close all peer connections
        Object.keys(peerConnections).forEach(id => {
            peerConnections[id].close();
            delete peerConnections[id];
        });

        viewerCount = 0;
        viewerNum.textContent = '0';

        // Reset UI
        cameraPreview.style.display = 'none';
        topBar.style.display = 'none';
        bottomBar.style.display = 'none';
        setupScreen.style.display = 'flex';
        btnStart.disabled = false;
        btnStart.textContent = 'Iniciar Câmera';

        socket.disconnect();
        socket.connect();
    });

    // ── Flip Camera ──────────────────────────────────
    btnFlip.addEventListener('click', async () => {
        if (!localStream) return;

        try {
            // Toggle facing mode
            currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';

            // Get new stream
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: currentFacingMode },
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                },
                audio: true
            });

            const newVideoTrack = newStream.getVideoTracks()[0];
            const oldVideoTrack = localStream.getVideoTracks()[0];

            // Replace track in all peer connections
            const promises = Object.values(peerConnections).map(pc => {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    return sender.replaceTrack(newVideoTrack);
                }
            });

            await Promise.all(promises);

            // Update local preview
            localVideo.srcObject = newStream;

            // Stop old tracks
            localStream.getTracks().forEach(track => track.stop());
            localStream = newStream;

            console.log('Camera flipped to:', currentFacingMode);

        } catch (err) {
            console.error('Failed to flip camera:', err);
            alert('Erro ao trocar de câmera.');
        }
    });

    // ── Signaling Events ─────────────────────────────

    // A viewer joined — create offer for them
    socket.on('viewer-joined', async ({ viewerId }) => {
        console.log(`Viewer joined: ${viewerId}`);
        const pc = createPeerConnection(viewerId);
        peerConnections[viewerId] = pc;

        // Add local tracks
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        }

        // Create and send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { viewerId, sdp: pc.localDescription });

        viewerCount++;
        viewerNum.textContent = viewerCount;
        setStatus('live', 'Ao Vivo');
    });

    // Viewer sent answer
    socket.on('answer', async ({ viewerId, sdp }) => {
        const pc = peerConnections[viewerId];
        if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        }
    });

    // ICE candidate from viewer
    socket.on('ice-candidate', ({ candidate, from }) => {
        const pc = peerConnections[from];
        if (pc && candidate) {
            pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
        }
    });

    // Viewer left
    socket.on('viewer-left', ({ viewerId }) => {
        console.log(`Viewer left: ${viewerId}`);
        if (peerConnections[viewerId]) {
            peerConnections[viewerId].close();
            delete peerConnections[viewerId];
        }
        viewerCount = Math.max(0, viewerCount - 1);
        viewerNum.textContent = viewerCount;

        if (viewerCount === 0) {
            setStatus('connecting', 'Aguardando viewer…');
        }
    });

    // ── RTCPeerConnection Factory ────────────────────
    function createPeerConnection(viewerId) {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                socket.emit('ice-candidate', {
                    candidate: e.candidate,
                    target: viewerId,
                });
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`ICE state [${viewerId}]: ${pc.iceConnectionState}`);
            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                pc.close();
                delete peerConnections[viewerId];
                viewerCount = Math.max(0, viewerCount - 1);
                viewerNum.textContent = viewerCount;
                if (viewerCount === 0) {
                    setStatus('connecting', 'Aguardando viewer…');
                }
            }
        };

        return pc;
    }

    // ── UI Helpers ───────────────────────────────────
    function setStatus(type, text) {
        statusBadge.className = `status-badge ${type}`;
        statusText.textContent = text;
    }

    // Keep screen awake (Wake Lock API)
    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                await navigator.wakeLock.request('screen');
                console.log('Wake lock acquired');
            }
        } catch (err) {
            console.warn('Wake lock failed:', err);
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && localStream) {
            requestWakeLock();
        }
    });
})();
