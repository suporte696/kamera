(() => {
    'use strict';

    // ── DOM Elements ─────────────────────────────────
    const waitingScreen = document.getElementById('waitingScreen');
    const videoContainer = document.getElementById('videoContainer');
    const topBar = document.getElementById('topBar');
    const bottomBar = document.getElementById('bottomBar');
    const remoteVideo = document.getElementById('remoteVideo');
    const statusBadge = document.getElementById('statusBadge');
    const statusText = document.getElementById('statusText');
    const btnMute = document.getElementById('btnMute');
    const btnFullscreen = document.getElementById('btnFullscreen');
    const btnNightVision = document.getElementById('btnNightVision');
    const btnGoToCamera = document.getElementById('btnGoToCamera');
    const btnRotate = document.getElementById('btnRotate');
    const btnFlipRemote = document.getElementById('btnFlipRemote');

    // ── State ────────────────────────────────────────
    const socket = io();
    let pc = null;
    let isMuted = true; // Start muted for autoplay
    let reconnectTimer = null;
    let nightVisionEnabled = false;
    let rotation = 90; // Default to vertical as requested

    const ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
    ];

    // ── Socket Events ────────────────────────────────

    socket.on('connect', () => {
        console.log('Connected to signaling server');
        socket.emit('request-offer');
    });

    // Broadcaster is available — request offer
    socket.on('broadcaster-available', () => {
        console.log('Broadcaster became available');
        cleanupPC();
        socket.emit('request-offer');
    });

    // No broadcaster online
    socket.on('no-broadcaster', () => {
        console.log('No broadcaster available');
        showWaiting();
    });

    // Received offer from broadcaster
    socket.on('offer', async ({ sdp }) => {
        console.log('Received offer');
        showConnecting();

        cleanupPC();
        pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                socket.emit('ice-candidate', {
                    candidate: e.candidate,
                    target: 'broadcaster',
                });
            }
        };

        pc.ontrack = (e) => {
            console.log('Received remote track:', e.track.kind);
            if (e.streams && e.streams[0]) {
                remoteVideo.srcObject = e.streams[0];
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`ICE state: ${pc.iceConnectionState}`);
            switch (pc.iceConnectionState) {
                case 'connected':
                case 'completed':
                    showLive();
                    break;
                case 'disconnected':
                    setStatus('connecting', 'Reconectando…');
                    break;
                case 'failed':
                    cleanupPC();
                    showWaiting();
                    scheduleReconnect();
                    break;
            }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { sdp: pc.localDescription });
    });

    // ICE candidate from broadcaster
    socket.on('ice-candidate', ({ candidate }) => {
        if (pc && candidate) {
            pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
        }
    });

    // Broadcaster left
    socket.on('broadcaster-left', () => {
        console.log('Broadcaster disconnected');
        cleanupPC();
        showWaiting();
    });









    // ── UI Events ────────────────────────────────────

    // Switch to Camera
    btnGoToCamera.addEventListener('click', () => {
        window.location.href = '/camera.html';
    });

    // Rotate Video
    btnRotate.addEventListener('click', () => {
        rotation = (rotation + 90) % 360;
        updateRotation();
    });

    function updateRotation() {
        // Remove all rotation classes
        remoteVideo.classList.remove('rotate-0', 'rotate-90', 'rotate-180', 'rotate-270');
        videoContainer.classList.remove('rotated-sideways');

        // Add current rotation
        remoteVideo.classList.add(`rotate-${rotation}`);

        // If 90 or 270, we're in a "sideways" state
        if (rotation === 90 || rotation === 270) {
            videoContainer.classList.add('rotated-sideways');
        }
    }

    // Initialize rotation
    updateRotation();

    // Flip Remote Camera
    btnFlipRemote.addEventListener('click', () => {
        socket.emit('camera-flip');
    });

    // ── Night Vision ─────────────────────────────────
    btnNightVision.addEventListener('click', () => {
        nightVisionEnabled = !nightVisionEnabled;
        remoteVideo.classList.toggle('night-vision', nightVisionEnabled);
        videoContainer.classList.toggle('night-vision-active', nightVisionEnabled);
        btnNightVision.classList.toggle('active', nightVisionEnabled);
    });

    // ── Mute / Unmute ────────────────────────────────
    btnMute.addEventListener('click', () => {
        isMuted = !isMuted;
        remoteVideo.muted = isMuted;
        btnMute.innerHTML = isMuted ? '<i data-lucide="volume-x"></i>' : '<i data-lucide="volume-2"></i>';
        btnMute.classList.toggle('active', isMuted);
        lucide.createIcons();
    });

    // ── Fullscreen ───────────────────────────────────
    btnFullscreen.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => { });
        } else {
            document.exitFullscreen();
        }
    });

    // ── UI State Helpers ─────────────────────────────
    function showWaiting() {
        waitingScreen.classList.remove('hidden');
        waitingScreen.style.display = 'flex';
        videoContainer.style.display = 'none';
        topBar.style.display = 'none';
        bottomBar.style.display = 'none';
    }

    function showConnecting() {
        waitingScreen.style.display = 'none';
        videoContainer.style.display = 'flex';
        topBar.style.display = 'flex';
        bottomBar.style.display = 'flex';
        setStatus('connecting', 'Conectando…');
    }

    function showLive() {
        waitingScreen.style.display = 'none';
        videoContainer.style.display = 'flex';
        topBar.style.display = 'flex';
        bottomBar.style.display = 'flex';
        setStatus('live', 'Ao Vivo');
    }

    function setStatus(type, text) {
        statusBadge.className = `status-badge ${type}`;
        statusText.textContent = text;
    }

    // ── Cleanup & Reconnect ──────────────────────────
    function cleanupPC() {
        if (pc) {
            pc.close();
            pc = null;
        }
        remoteVideo.srcObject = null;
    }

    function scheduleReconnect() {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            console.log('Attempting reconnect…');
            socket.emit('request-offer');
        }, 3000);
    }

    // Keep screen awake
    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                await navigator.wakeLock.request('screen');
            }
        } catch (err) {
            console.warn('Wake lock failed:', err);
        }
    }

    // Initialize UI
    btnMute.classList.add('active');

    requestWakeLock();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') requestWakeLock();
    });
})();
