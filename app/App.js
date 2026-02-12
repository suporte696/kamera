import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Image,
  SafeAreaView,
  StatusBar,
  Dimensions,
  Platform,
  Alert,
  TouchableWithoutFeedback
} from 'react-native';
import { BlurView } from 'expo-blur';
import {
  Monitor,
  Video,
  Camera as LucideCamera,
  RotateCw,
  Radio,
  Shuffle,
  Home,
  Volume2,
  VolumeX,
  Moon,
  Repeat,
  Square,
  Battery,
  Zap
} from 'lucide-react-native';
import { io } from 'socket.io-client';
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCView,
  mediaDevices
} from 'react-native-webrtc';


// ── Configuration ────────────────────────────────
// IP do servidor (Atualize conforme sua rede local ou use o domínio da VPS)
const SIGNALING_SERVER = 'https://kamera.rodrigor.xyz';

// ── Professional Palette ────────────────────────
const COLORS = {
  bgDark: '#0f172a',
  bgSurface: '#1e293b',
  bgCard: '#334155',
  accent: '#6366f1',
  textMain: '#f8fafc',
  textMuted: '#94a3b8',
  danger: '#ef4444',
  success: '#10b981',
  border: 'rgba(255, 255, 255, 0.08)',
};

export default function App() {
  const [mode, setMode] = useState('choice'); // 'choice', 'viewer', 'camera'
  const [status, setStatus] = useState('offline'); // 'offline', 'waiting', 'live'
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isMuted, setIsMuted] = useState(true);
  const [nightVision, setNightVision] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [isBatterySaving, setIsBatterySaving] = useState(false);
  const [lastInteraction, setLastInteraction] = useState(Date.now());
  const [videoDevices, setVideoDevices] = useState([]);
  const [currentDeviceIndex, setCurrentDeviceIndex] = useState(0);

  const socketRef = useRef(null);
  const pcRef = useRef(null);

  // ── Battery Saving Logic ──────────────────────
  const resetInactivityTimer = () => {
    setLastInteraction(Date.now());
    if (isBatterySaving) setIsBatterySaving(false);
  };

  useEffect(() => {
    if (mode === 'choice') return;

    const checkInactivity = setInterval(() => {
      const timeSinceLast = Date.now() - lastInteraction;
      // Timeout mais agressivo para a Câmera (10s), Monitor não escurece sozinho mais
      const timeout = mode === 'camera' ? 10000 : 9999999;

      if (timeSinceLast > timeout && !isBatterySaving) {
        setIsBatterySaving(true);
      }
    }, 2000);

    return () => clearInterval(checkInactivity);
  }, [lastInteraction, mode, isBatterySaving]);

  // ── WebRTC & Signaling ────────────────────────
  useEffect(() => {
    if (mode === 'choice') return;

    // Connect socket
    socketRef.current = io(SIGNALING_SERVER);

    socketRef.current.on('connect', () => {
      console.log('Connected to server');
      if (mode === 'viewer') {
        socketRef.current.emit('request-offer');
      } else if (mode === 'camera') {
        startCamera();
      }
    });

    socketRef.current.on('offer', async ({ sdp }) => {
      if (mode !== 'viewer') return;
      await handleOffer(sdp);
    });

    socketRef.current.on('answer', async ({ sdp }) => {
      if (mode !== 'camera' || !pcRef.current) return;
      await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
    });

    socketRef.current.on('ice-candidate', ({ candidate }) => {
      if (pcRef.current && candidate) {
        pcRef.current.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
      }
    });

    socketRef.current.on('no-broadcaster', () => {
      if (mode === 'viewer') setStatus('waiting');
    });

    return cleanup;
  }, [mode]);

  const startCamera = async () => {
    try {
      const devices = await mediaDevices.enumerateDevices();
      const videoIn = devices.filter(d => d.kind === 'videoinput');

      // Ordenação lógica: Traseira primeiro, depois frontal
      const sorted = videoIn.sort((a, b) => {
        const labelA = (a.label || '').toLowerCase();
        const labelB = (b.label || '').toLowerCase();
        if (labelA.includes('front') && !labelB.includes('front')) return 1;
        if (!labelA.includes('front') && labelB.includes('front')) return -1;
        return 0;
      });

      setVideoDevices(sorted);

      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: 'environment', // Preferir traseira no início
          frameRate: 30,
        }
      });

      setLocalStream(stream);
      setStatus('waiting');

      socketRef.current.on('request-offer', async () => {
        await createOffer(stream);
      });

      socketRef.current.on('camera-flip', () => {
        console.log('Recebido pedido remoto para trocar câmera');
        toggleCamera();
      });
    } catch (err) {
      Alert.alert('Erro', 'Não foi possível acessar a câmera.');
      setMode('choice');
    }
  };

  const toggleCamera = async () => {
    if (videoDevices.length < 2 || !localStream) return;

    try {
      const nextIndex = (currentDeviceIndex + 1) % videoDevices.length;
      setCurrentDeviceIndex(nextIndex);
      const nextDevice = videoDevices[nextIndex];

      const newStream = await mediaDevices.getUserMedia({
        audio: true,
        video: { deviceId: nextDevice.deviceId }
      });

      const newVideoTrack = newStream.getVideoTracks()[0];

      setLocalStream(newStream);

      if (pcRef.current) {
        const sender = pcRef.current.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          sender.replaceTrack(newVideoTrack);
        }
      }

      localStream.getTracks().forEach(t => t.stop());
    } catch (err) {
      console.error('Falha ao trocar câmera:', err);
    }
  };

  const createOffer = async (stream) => {
    pcRef.current = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    stream.getTracks().forEach(track => pcRef.current.addTrack(track, stream));

    pcRef.current.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current.emit('ice-candidate', { candidate: e.candidate, target: 'viewer' });
      }
    };

    const offer = await pcRef.current.createOffer();
    await pcRef.current.setLocalDescription(offer);
    socketRef.current.emit('offer', { sdp: pcRef.current.localDescription });
    setStatus('live');
  };

  const handleOffer = async (sdp) => {
    pcRef.current = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    pcRef.current.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current.emit('ice-candidate', { candidate: e.candidate, target: 'broadcaster' });
      }
    };

    pcRef.current.ontrack = (e) => {
      if (e.streams && e.streams[0]) {
        setRemoteStream(e.streams[0]);
        setStatus('live');
      }
    };

    await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pcRef.current.createAnswer();
    await pcRef.current.setLocalDescription(answer);
    socketRef.current.emit('answer', { sdp: pcRef.current.localDescription });
  };

  const cleanup = () => {
    try {
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    } catch (e) { }
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setLocalStream(null);
    setRemoteStream(null);
    setStatus('offline');
  };

  // ── Choice Screen Component ────────────────────
  const ChoiceScreen = () => (
    <View style={styles.choiceWrapper}>
      {/* Background Decorative Glow */}
      <View style={styles.bgGlow} />

      <View style={styles.choiceContent}>
        <Image
          source={require('./assets/logo.png')}
          style={styles.logoHero}
          resizeMode="contain"
        />

        <View style={styles.cardContainer}>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => setMode('viewer')}
            style={styles.cardOuter}
          >
            <BlurView intensity={25} tint="light" style={styles.glassCard}>
              <View style={[styles.cardIconBox, { backgroundColor: COLORS.accent }]}>
                <Monitor size={28} color="#fff" />
              </View>
              <View style={styles.cardInfo}>
                <Text style={styles.cardTitle}>Modo Monitor</Text>
                <Text style={styles.cardDesc}>Acompanhe o vídeo e áudio em tempo real deste ou de outros dispositivos.</Text>
              </View>
            </BlurView>
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => setMode('camera')}
            style={styles.cardOuter}
          >
            <BlurView intensity={25} tint="light" style={styles.glassCard}>
              <View style={[styles.cardIconBox, { backgroundColor: COLORS.success }]}>
                <LucideCamera size={28} color="#fff" />
              </View>
              <View style={styles.cardInfo}>
                <Text style={styles.cardTitle}>Modo Câmera</Text>
                <Text style={styles.cardDesc}>Transforme este dispositivo em uma câmera de monitoramento segura.</Text>
              </View>
            </BlurView>
          </TouchableOpacity>
        </View>

        <Text style={styles.footerBrand}>Powered by RK Company</Text>
      </View>
    </View>
  );

  // ── Main UI ────────────────────────────────────
  return (
    <TouchableWithoutFeedback onPress={resetInactivityTimer}>
      <View style={styles.container} onStartShouldSetResponderCapture={() => { resetInactivityTimer(); return false; }}>
        <StatusBar barStyle="light-content" translucent backgroundColor="transparent" hidden={mode === 'viewer'} />

        {mode === 'choice' && (
          <SafeAreaView style={styles.full}>
            <ChoiceScreen />
          </SafeAreaView>
        )}

        {mode === 'viewer' && (
          <View style={styles.viewerContainer}>
            {/* Top Bar (Floating Liquid Glass) */}
            <BlurView intensity={80} tint="dark" style={styles.floatingTopBar}>
              <View style={styles.logoAndInfo}>
                <Image source={require('./assets/logo.png')} style={styles.brandLogo} resizeMode="contain" />
              </View>
              <View style={[styles.statusBadge, status === 'live' ? styles.statusLive : styles.statusWaiting]}>
                <View style={[styles.statusDot, status === 'live' && styles.dotLive]} />
                <Text style={styles.statusText}>{status === 'live' ? 'AO VIVO' : 'CONECTANDO...'}</Text>
              </View>
            </BlurView>

            {/* Fullscreen Video Area */}
            <View style={styles.videoContainer}>
              {remoteStream ? (
                <RTCView
                  streamURL={remoteStream.toURL()}
                  style={[styles.video, { transform: [{ rotate: `${rotation}deg` }] }]}
                  objectFit="contain"
                />
              ) : (
                <View style={styles.waitingOverlay}>
                  <Radio size={48} color={COLORS.accent} />
                  <Text style={styles.waitingText}>Aguardando sinal da câmera...</Text>
                </View>
              )}
              {nightVision && (
                <>
                  <View style={styles.nightVisionLift} />
                  <View style={styles.nightVisionOverlay} />
                </>
              )}
            </View>

            {/* Bottom Bar (Floating Liquid Glass) */}
            <BlurView intensity={90} tint="dark" style={styles.floatingBottomBar}>
              <TouchableOpacity style={styles.circleBtn} onPress={() => { resetInactivityTimer(); setRotation((rotation + 90) % 360); }}>
                <RotateCw size={22} color={COLORS.textMain} />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.circleBtn}
                onPress={() => { resetInactivityTimer(); socketRef.current.emit('camera-flip'); }}
              >
                <Shuffle size={20} color={COLORS.textMain} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.circleBtn, nightVision && styles.circleBtnActive]}
                onPress={() => { resetInactivityTimer(); setNightVision(!nightVision); }}
              >
                <Moon size={22} color={nightVision ? "#fff" : COLORS.textMain} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.circleBtn, !isMuted && styles.circleBtnActive]}
                onPress={() => { resetInactivityTimer(); setIsMuted(!isMuted); }}
              >
                {isMuted ? <VolumeX size={22} color={COLORS.textMuted} /> : <Volume2 size={22} color="#fff" />}
              </TouchableOpacity>

              <TouchableOpacity style={[styles.circleBtn, { borderColor: COLORS.danger, backgroundColor: 'rgba(239, 68, 68, 0.1)' }]} onPress={() => { cleanup(); setMode('choice'); }}>
                <Home size={20} color={COLORS.danger} />
              </TouchableOpacity>
            </BlurView>
          </View>
        )}

        {mode === 'camera' && (
          <View style={styles.viewerContainer}>
            {/* Top Bar (Floating Liquid Glass) */}
            <BlurView intensity={80} tint="dark" style={styles.floatingTopBar}>
              <View style={styles.logoAndInfo}>
                <Image source={require('./assets/logo.png')} style={styles.brandLogo} resizeMode="contain" />
              </View>
              <View style={[styles.statusBadge, status === 'waiting' ? styles.statusWaiting : styles.statusLive]}>
                <View style={[styles.statusDot, status === 'live' && styles.dotLive]} />
                <Text style={styles.statusText}>{status === 'live' ? 'AO VIVO' : 'AGUARDANDO...'}</Text>
              </View>
            </BlurView>

            {/* Fullscreen Camera Preview Area */}
            <View style={styles.videoContainer}>
              {localStream ? (
                <RTCView
                  streamURL={localStream.toURL()}
                  style={styles.video}
                  objectFit="cover"
                />
              ) : (
                <View style={styles.waitingOverlay}>
                  <Radio size={48} color={COLORS.accent} />
                  <Text style={styles.waitingText}>Iniciando câmera...</Text>
                </View>
              )}
            </View>

            {/* Bottom Bar (Floating Liquid Glass) */}
            <BlurView intensity={90} tint="dark" style={styles.floatingBottomBar}>
              <TouchableOpacity style={styles.circleBtn} onPress={() => { resetInactivityTimer(); setMode('viewer'); }}>
                <Monitor size={22} color={COLORS.textMain} />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.circleBtn}
                onPress={() => {
                  resetInactivityTimer();
                  toggleCamera();
                }}
              >
                <Repeat size={22} color={COLORS.textMain} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.circleBtn, { borderColor: COLORS.danger, backgroundColor: 'rgba(239, 68, 68, 0.1)' }]}
                onPress={() => { cleanup(); setMode('choice'); }}
              >
                <Square size={20} color={COLORS.danger} fill={COLORS.danger} />
              </TouchableOpacity>
            </BlurView>

            {/* Battery Saving Overlay (Câmera) */}
            {isBatterySaving && (
              <View style={styles.batterySavingOverlay}>
                <Battery size={48} color={COLORS.success} />
                <Text style={styles.batterySavingText}>Transmissão Segura Ativa</Text>
                <Text style={styles.batterySavingSubtext}>Tela escurecida para poupar bateria</Text>
                <TouchableOpacity style={styles.wakeBtn} onPress={resetInactivityTimer}>
                  <Text style={styles.wakeBtnText}>ACORDAR TELA</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

      </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bgDark,
  },
  full: {
    flex: 1,
  },
  centerBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  choiceWrapper: {
    flex: 1,
    backgroundColor: COLORS.bgDark,
  },
  bgGlow: {
    position: 'absolute',
    top: -100,
    left: '50%',
    marginLeft: -200,
    width: 400,
    height: 400,
    backgroundColor: COLORS.accent,
    opacity: 0.1,
    borderRadius: 200,
    filter: 'blur(80px)', // Apenas referencial, no RN usamos o shadow ou View vazia
  },
  choiceContent: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: Platform.OS === 'ios' ? 80 : 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoHero: {
    width: 140,
    height: 60,
    marginBottom: 20,
  },
  welcomeText: {
    alignItems: 'center',
    marginBottom: 40,
  },
  mainTitle: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '900',
    letterSpacing: -1,
  },
  subtext: {
    color: COLORS.textMuted,
    fontSize: 14,
    marginTop: 4,
    textAlign: 'center',
  },
  cardContainer: {
    width: '100%',
    gap: 20,
  },
  cardOuter: {
    width: '100%',
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  glassCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 20,
    height: 120,
  },
  cardIconBox: {
    width: 56,
    height: 56,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 20,
  },
  cardInfo: {
    flex: 1,
  },
  cardTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  cardDesc: {
    color: COLORS.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  footerBrand: {
    position: 'absolute',
    bottom: 40,
    color: 'rgba(255,255,255,0.2)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  viewerContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  floatingTopBar: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 20,
    left: 20,
    right: 20,
    zIndex: 100,
    height: 60,
    overflow: 'hidden', // Importante para o BlurView respeitar o borderRadius
    borderRadius: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  floatingBottomBar: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 40 : 20,
    left: '50%',
    marginLeft: -160,
    width: 320,
    zIndex: 100,
    height: 70,
    overflow: 'hidden',
    borderRadius: 35,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  logoAndInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  brandLogo: {
    height: 22,
    width: 80,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statusLive: {
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: COLORS.textMuted,
    marginRight: 8,
  },
  dotLive: {
    backgroundColor: COLORS.success,
    shadowColor: COLORS.success,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
  statusText: {
    color: COLORS.textMain,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  videoContainer: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: Dimensions.get('window').width,
    height: Dimensions.get('window').height,
  },
  nightVisionLift: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.35)', // "Levanta" os pretos para cinza nítido
    pointerEvents: 'none',
    zIndex: 5,
  },
  nightVisionOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 255, 0, 0.2)', // Tom verde de alta visibilidade
    borderWidth: 0,
    pointerEvents: 'none',
    zIndex: 6,
  },
  circleBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.bgSurface,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  circleBtnActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  waitingOverlay: {
    alignItems: 'center',
  },
  waitingText: {
    color: COLORS.textMuted,
    marginTop: 16,
    fontSize: 16,
  },
  batterySavingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    zIndex: 999,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  batterySavingText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 20,
    textAlign: 'center',
  },
  batterySavingSubtext: {
    color: COLORS.textMuted,
    fontSize: 14,
    marginTop: 10,
    textAlign: 'center',
  },
  wakeBtn: {
    marginTop: 40,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bgSurface,
  },
  wakeBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  }
});
