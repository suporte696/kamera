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
    let rotation = 0; // Start at 0 to avoid initial crop
    let currentScale = 1; // Dedicated scale variable for smooth pinching

    // ── Interaction State (Zoom & Pan) ──────────────
    let zoomLevel = 0; // 0, 1, 2 (corresponds to 1x, 2.5x, 4x)
    const zoomScales = [1, 2.5, 4];
    let isDragging = false;
    let startX, startY;
    let translateX = 0, translateY = 0;
    let lastTranslateX = 0, lastTranslateY = 0;

    function updateTransform() {
        const scale = currentScale;
        // Combine rotation and zoom/pan
        remoteVideo.style.transform = `rotate(${rotation}deg) scale(${scale}) translate(${translateX}px, ${translateY}px)`;

        videoContainer.classList.toggle('has-zoom', currentScale > 1.1);
        videoContainer.classList.toggle('is-dragging', isDragging);
    }

    const ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
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
                    // Safari Fix: Explicitly call play() on track arrival
                    remoteVideo.play().catch(err => {
                        console.log('Autoplay blocked, waiting for interaction or retrying...', err);
                        // Optional: show a "Click to view" button if play fails
                    });
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
            let answer = await pc.createAnswer();

            // Safari/iOS Fix: Prioritize H.264 codec in SDP
            if (answer.sdp) {
                answer.sdp = prioritizeH264(answer.sdp);
            }

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
        updateTransform();
    });

    btnFlipRemote.addEventListener('click', () => {
        if (socket) socket.emit('camera-flip');
    });

    function updateRotation() {
        videoContainer.classList.remove('rotated-sideways');
        if (rotation === 90 || rotation === 270) {
            videoContainer.classList.add('rotated-sideways');
        }
    }

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

    // ── Zoom & Pan Logic ────────────────────────────
    remoteVideo.addEventListener('dblclick', (e) => {
        zoomLevel = (zoomLevel + 1) % zoomScales.length;
        currentScale = zoomScales[zoomLevel];
        if (zoomLevel === 0) {
            translateX = 0; translateY = 0;
            lastTranslateX = 0; lastTranslateY = 0;
        }
        remoteVideo.style.transition = 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
        updateTransform();
    });

    const startDrag = (e) => {
        if (currentScale <= 1.05) return;
        isDragging = true;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX; startY = clientY;
        remoteVideo.style.transition = 'none';
        updateTransform();
    };

    const doDrag = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const dx = (clientX - startX) / currentScale;
        const dy = (clientY - startY) / currentScale;

        let adjX = dx, adjY = dy;
        if (rotation === 90) { adjX = dy; adjY = -dx; }
        else if (rotation === 180) { adjX = -dx; adjY = -dy; }
        else if (rotation === 270) { adjX = -dy; adjY = dx; }

        translateX = lastTranslateX + adjX;
        translateY = lastTranslateY + adjY;
        updateTransform();
    };

    const endDrag = () => {
        if (!isDragging) return;
        isDragging = false;
        lastTranslateX = translateX; lastTranslateY = translateY;
        remoteVideo.style.transition = 'transform 0.3s ease-out';
        updateTransform();
    };

    remoteVideo.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove', doDrag);
    window.addEventListener('mouseup', endDrag);
    remoteVideo.addEventListener('touchstart', startDrag, { passive: false });
    window.addEventListener('touchmove', doDrag, { passive: false });
    window.addEventListener('touchend', endDrag);

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
        videoContainer.classList.remove('rotated-sideways');
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

    // ── Pinch to Zoom (Mobile) ──────────────────────
    let evCache = [];
    let prevDiff = -1;

    function pointerDownHandler(ev) {
        evCache.push(ev);
        if (evCache.length === 2) {
            isDragging = false; // Stop dragging if pinching starts
            remoteVideo.style.transition = 'none';
        }
    }

    function pointerMoveHandler(ev) {
        // Find this event in the cache and update its record with this one
        const index = evCache.findIndex((cachedEv) => cachedEv.pointerId === ev.pointerId);
        evCache[index] = ev;

        // If two pointers are down, check for pinch gestures
        if (evCache.length === 2) {
            const curDiff = Math.hypot(evCache[0].clientX - evCache[1].clientX, evCache[0].clientY - evCache[1].clientY);

            if (prevDiff > 0) {
                const delta = (curDiff - prevDiff) * 0.01;
                // Accumulate scale smoothly
                currentScale = Math.min(Math.max(currentScale + delta, 1), 6);

                // Sync zoomLevel for the UI/DblClick logic
                if (currentScale < 1.2) zoomLevel = 0;
                else if (currentScale < 3) zoomLevel = 1;
                else zoomLevel = 2;

                updateTransform();
            }
            prevDiff = curDiff;
        }
    }

    function pointerUpHandler(ev) {
        const index = evCache.findIndex((cachedEv) => cachedEv.pointerId === ev.pointerId);
        if (index !== -1) evCache.splice(index, 1);
        if (evCache.length < 2) {
            prevDiff = -1;
        }
    }

    remoteVideo.addEventListener('pointerdown', pointerDownHandler);
    remoteVideo.addEventListener('pointermove', pointerMoveHandler);
    remoteVideo.addEventListener('pointerup', pointerUpHandler);
    remoteVideo.addEventListener('pointercancel', pointerUpHandler);
    remoteVideo.addEventListener('pointerout', pointerUpHandler);
    remoteVideo.addEventListener('pointerleave', pointerUpHandler);

    // ── SDP Munging ─────────────────────────────────
    function prioritizeH264(sdp) {
        const lines = sdp.split('\r\n');
        let mLineIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].indexOf('m=video') === 0) {
                mLineIndex = i;
                break;
            }
        }
        if (mLineIndex === -1) return sdp;

        const h264Payloads = [];
        const otherPayloads = [];
        const rtpMapRegex = /^a=rtpmap:(\d+) H264\/\d+/;

        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(rtpMapRegex);
            if (match) {
                h264Payloads.push(match[1]);
            }
        }

        if (h264Payloads.length === 0) return sdp;

        const mLineElements = lines[mLineIndex].split(' ');
        const mLineHeader = mLineElements.slice(0, 3);
        const existingPayloads = mLineElements.slice(3);

        existingPayloads.forEach(payload => {
            if (!h264Payloads.includes(payload)) {
                otherPayloads.push(payload);
            }
        });

        lines[mLineIndex] = mLineHeader.concat(h264Payloads, otherPayloads).join(' ');
        return lines.join('\r\n');
    }

    // Initialize UI
    lucide.createIcons();
    updateRotation();
    updateTransform(); // Ensure sync on startup to avoid crop
    btnMute.classList.add('active');
    requestWakeLock();

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') requestWakeLock();
    });
})();
