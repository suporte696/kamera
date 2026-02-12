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
    let videoDevices = [];
    let currentDeviceIndex = 0;

    const ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
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

            // First time, just get the default (back preferred)
            localStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1920 }, // High resolution for better sensor pull
                    height: { ideal: 1080 },
                    frameRate: { ideal: 15, max: 20 }, // Lower frame rate allows longer exposure per frame
                },
                audio: true,
            });

            // After getting permission, list all devices
            await refreshDeviceList();

            // Find which device we are actually using
            const currentTrack = localStream.getVideoTracks()[0];
            const settings = currentTrack.getSettings();
            if (settings.deviceId) {
                currentDeviceIndex = videoDevices.findIndex(d => d.deviceId === settings.deviceId);
                if (currentDeviceIndex === -1) currentDeviceIndex = 0;
            }

            localVideo.srcObject = localStream;
            // Safari Fix: Explicitly call play()
            localVideo.play().catch(console.error);

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
    async function refreshDeviceList() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            let allVideo = devices.filter(d => d.kind === 'videoinput' && d.deviceId);

            // Filter out duplicates and virtual/composite devices if they share IDs
            const seen = new Set();
            const unique = allVideo.filter(d => {
                if (seen.has(d.deviceId)) return false;
                seen.add(d.deviceId);
                return true;
            });

            // Logical Sort: 
            // 1. Primary Back (Main)
            // 2. Secondary Back (Wide, Telephoto, etc)
            // 3. Front
            videoDevices = unique.sort((a, b) => {
                const lA = (a.label || '').toLowerCase();
                const lB = (b.label || '').toLowerCase();

                const isFrontA = lA.includes('front') || lA.includes('user') || lA.includes('frontal');
                const isFrontB = lB.includes('front') || lB.includes('user') || lB.includes('frontal');

                // Front cameras go to the end
                if (isFrontA && !isFrontB) return 1;
                if (!isFrontA && isFrontB) return -1;

                // For back cameras, try to put "Main/Padrão" first
                const isMainA = lA.includes('padrão') || lA.includes('main') || (!lA.includes('wide') && !lA.includes('ultra'));
                const isMainB = lB.includes('padrão') || lB.includes('main') || (!lB.includes('wide') && !lB.includes('ultra'));

                if (isMainA && !isMainB) return -1;
                if (!isMainA && isMainB) return 1;

                return 0;
            });

            console.log('Video devices ready:', videoDevices.map(d => d.label || 'id:' + d.deviceId.slice(0, 4)));
        } catch (err) {
            console.error('Error enumerating devices:', err);
        }
    }

    async function toggleCamera() {
        if (!localStream || videoDevices.length < 2) {
            console.log('Not enough cameras to switch.');
            return;
        }

        try {
            // Re-sync index with actual hardware current state
            const currentTrack = localStream.getVideoTracks()[0];
            const settings = currentTrack.getSettings();
            if (settings.deviceId) {
                const realIndex = videoDevices.findIndex(d => d.deviceId === settings.deviceId);
                if (realIndex !== -1) currentDeviceIndex = realIndex;
            }

            // Move to next device in sorted list
            currentDeviceIndex = (currentDeviceIndex + 1) % videoDevices.length;
            const nextDevice = videoDevices[currentDeviceIndex];

            console.log(`Switching to lens: ${nextDevice.label || nextDevice.deviceId}`);

            // Constraints for the NEW stream
            const constraints = {
                video: {
                    deviceId: { exact: nextDevice.deviceId },
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                },
                audio: true
            };

            const newStream = await navigator.mediaDevices.getUserMedia(constraints);
            const newVideoTrack = newStream.getVideoTracks()[0];

            // Update WebRTC peers
            const promises = Object.values(peerConnections).map(pc => {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) return sender.replaceTrack(newVideoTrack);
            });

            await Promise.all(promises);

            // Update local view
            localVideo.srcObject = newStream;

            // Clean up old resources
            localStream.getTracks().forEach(track => track.stop());
            localStream = newStream;

        } catch (err) {
            console.error('Flip failed:', err);
            // On failure, refresh list and alert
            await refreshDeviceList();
            alert('Não foi possível alternar para esta câmera.');
        }
    }

    btnFlip.addEventListener('click', toggleCamera);

    // ── Signaling Events ─────────────────────────────

    // Remote flip request from viewer
    socket.on('camera-flip', toggleCamera);

    async function toggleNightMode({ enabled }) {
        try {
            console.log(`Night Mode transition: ${enabled ? 'ON' : 'OFF'}`);

            // Re-sync index with actual hardware current state
            const currentTrack = localStream.getVideoTracks()[0];
            const settings = currentTrack.getSettings();

            const constraints = {
                video: {
                    deviceId: settings.deviceId ? { exact: settings.deviceId } : undefined,
                    facingMode: settings.deviceId ? undefined : { ideal: 'environment' },
                    width: enabled ? { ideal: 640 } : { ideal: 1920 },
                    height: enabled ? { ideal: 480 } : { ideal: 1080 },
                    frameRate: enabled ? { ideal: 15, max: 15 } : { ideal: 30, max: 60 },
                },
                audio: true
            };

            const newStream = await navigator.mediaDevices.getUserMedia(constraints);
            const newVideoTrack = newStream.getVideoTracks()[0];

            // Update WebRTC peers
            const promises = Object.values(peerConnections).map(pc => {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) return sender.replaceTrack(newVideoTrack);
            });

            await Promise.all(promises);

            // Update local view
            localVideo.srcObject = newStream;

            // Clean up old resources
            localStream.getTracks().forEach(track => track.stop());
            localStream = newStream;

            console.log(`Night Mode active: ${enabled}. Resolution: ${enabled ? '640x480 (Sensitive)' : 'HD'}`);
        } catch (err) {
            console.error('Night Mode switch failed:', err);
        }
    }

    socket.on('night-mode-toggle', toggleNightMode);

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
        let offer = await pc.createOffer();

        // Safari/iOS Fix: Prioritize H264 codec
        if (offer.sdp) {
            offer.sdp = prioritizeH264(offer.sdp);
        }

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
