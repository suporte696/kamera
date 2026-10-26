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

## 🔒 Modo de acesso (local / remoto)

| Modo | Quem vê | Como |
|------|---------|------|
| `local` (padrão) | Só dispositivos no mesmo Wi-Fi | Sem STUN/TURN; o servidor descarta todo candidato ICE que não seja IP privado (inclusive dentro do SDP) e exige que viewer e câmera venham do mesmo IP público |
| `remote` | Qualquer lugar | STUN + TURN, sem filtro |

Trocar em tempo real (Easypanel → serviço → **Console**):

```bash
npm run mode -- status
npm run mode -- local
npm run mode -- remote
```

A troca derruba as conexões atuais e todos reconectam no modo novo. O endpoint `/admin` só responde de dentro do container (pedidos via proxy recebem 404).

Variáveis de ambiente:

| Variável | Uso |
|----------|-----|
| `ACCESS_MODE` | Modo inicial (`local` / `remote`). Padrão `local` |
| `STATE_FILE` | Onde o modo escolhido pela CLI é salvo. Padrão `/app/data/state.json` — monte um volume em `/app/data` para sobreviver a redeploy |
| `TURN_URLS` | Ex.: `turn:turn.seudominio.com:3478?transport=udp,turn:turn.seudominio.com:3478?transport=tcp` |
| `TURN_SECRET` | `static-auth-secret` do coturn (gera credenciais temporárias) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | Alternativa: credenciais fixas (provedor gerenciado) |
| `STUN_URLS` | Sobrescreve os STUN padrão (Google) |
| `LOCAL_IP_MATCH` | `false` desativa a checagem de IP público no modo local |

## 📁 Estrutura

```
├── server.js              # Signaling server (Socket.IO)
├── access.js              # Modo de acesso local/remoto (ICE config + filtro)
├── cli.js                 # CLI: npm run mode -- local|remote|status
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
