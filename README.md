# 🎥 Kamera

Babá eletrônica P2P usando WebRTC para stream de áudio/vídeo com latência mínima (~100-300ms).

## 🚀 Como usar

### Localmente

```bash
npm install
npm start
```

- **Câmera:** `http://localhost:3000/camera.html`
- **Viewer:** `http://localhost:3000/`

### Deploy no Easypanel

1. Criar app Docker no Easypanel
2. Apontar para este repositório
3. Configurar domínio com HTTPS (obrigatório para WebRTC)
4. Porta: `3000`

## 📁 Estrutura

```
├── server.js              # Signaling server (Socket.IO)
├── public/
│   ├── index.html         # Viewer
│   ├── camera.html        # Câmera
│   ├── css/style.css      # Design
│   └── js/
│       ├── camera.js      # WebRTC broadcaster
│       └── viewer.js      # WebRTC viewer
└── Dockerfile
```

## 🔧 Funcionalidades

- ✅ Stream P2P de vídeo e áudio
- ✅ Latência mínima (~100-300ms)
- ✅ Design responsivo e mobile-first
- ✅ Reconexão automática
- ✅ Wake Lock (tela sempre ligada)
- ✅ Controles: mute/unmute, fullscreen
- ✅ **Visão noturna** — filtros CSS para ambientes escuros

## 🔮 Próximas features

- [ ] Detecção de choro
