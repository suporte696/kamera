(() => {
    'use strict';

    // ── DOM Elements ─────────────────────────────────
    const choiceScreen = document.getElementById('choiceScreen');
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
    const btnRotate = document.getElementById('btnRotate');
    const btnFlipRemote = document.getElementById('btnFlipRemote');
    const btnJoinViewer = document.getElementById('btnJoinViewer');
    const btnBackToHome = document.getElementById('btnBackToHome');

    // ── State ────────────────────────────────────────
    let socket = null;
    let pc = null;
    let isMuted = true;
    let reconnectTimer = null;
    let nightVisionEnabled = false;
    let rotation = 90;

    const ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
    ];

    // ── Socket Management ────────────────────────────
    function initSocket() {
        if (socket) return;
        socket = io();

        socket.on('connect', () => {
            console.log('Connected to signaling server');
            socket.emit('request-offer');
        });

        socket.on('broadcaster-available', () => {
            cleanupPC();
            socket.emit('request-offer');
        });

        socket.on('no-broadcaster', () => {
            showWaiting();
        });

        socket.on('offer', async ({ sdp }) => {
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
                if (e.streams && e.streams[0]) {
                    remoteVideo.srcObject = e.streams[0];
                }
            };

            pc.oniceconnectionstatechange = () => {
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

        socket.on('ice-candidate', ({ candidate }) => {
            if (pc && candidate) {
                pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
            }
        });

        socket.on('broadcaster-left', () => {
            cleanupPC();
            showWaiting();
        });
    }

    // ── UI Events ────────────────────────────────────
    btnJoinViewer.addEventListener('click', () => {
        showWaiting(); // Show waiting state while we check signal
        initSocket();
    });

    btnBackToHome.addEventListener('click', () => {
        if (socket) {
            socket.disconnect();
            socket = null;
        }
        cleanupPC();
        showChoice();
    });

    btnRotate.addEventListener('click', () => {
        rotation = (rotation + 90) % 360;
        updateRotation();
    });

    btnFlipRemote.addEventListener('click', () => {
        if (socket) socket.emit('camera-flip');
    });

    btnNightVision.addEventListener('click', () => {
        nightVisionEnabled = !nightVisionEnabled;
        remoteVideo.classList.toggle('night-vision', nightVisionEnabled);
        videoContainer.classList.toggle('night-vision-active', nightVisionEnabled);
        btnNightVision.classList.toggle('active', nightVisionEnabled);
    });

    btnMute.addEventListener('click', () => {
        isMuted = !isMuted;
        remoteVideo.muted = isMuted;
        btnMute.innerHTML = isMuted ? '<i data-lucide="volume-x"></i>' : '<i data-lucide="volume-2"></i>';
        btnMute.classList.toggle('active', isMuted);
        lucide.createIcons();
    });

    btnFullscreen.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => { });
        } else {
            document.exitFullscreen();
        }
    });

    // ── UI Helpers ───────────────────────────────────
    function showChoice() {
        choiceScreen.classList.remove('hidden');
        choiceScreen.style.display = 'flex';
        waitingScreen.style.display = 'none';
        videoContainer.style.display = 'none';
        topBar.style.display = 'none';
        bottomBar.style.display = 'none';
    }

    function showWaiting() {
        choiceScreen.classList.add('hidden');
        choiceScreen.style.display = 'none';
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

    function updateRotation() {
        remoteVideo.classList.remove('rotate-0', 'rotate-90', 'rotate-180', 'rotate-270');
        videoContainer.classList.remove('rotated-sideways');
        remoteVideo.classList.add(`rotate-${rotation}`);
        if (rotation === 90 || rotation === 270) {
            videoContainer.classList.add('rotated-sideways');
        }
    }

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
            if (socket) socket.emit('request-offer');
        }, 3000);
    }

    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
        } catch (err) { }
    }

    // Initialize UI
    lucide.createIcons();
    updateRotation();
    btnMute.classList.add('active');
    requestWakeLock();

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') requestWakeLock();
    });
})();
