// ── Access mode (local / remote) ───────────────────────────
//
// local  → only devices on the same network can connect.
//          * clients get NO STUN/TURN servers (only host candidates are gathered)
//          * the server drops every ICE candidate that is not a private/LAN address
//            (both in trickled candidates and inside the SDP), so a P2P path over
//            the internet can never be negotiated, even by a modified client
//          * optionally, viewer and camera must reach the server from the same public IP
//
// remote → STUN + TURN, no filtering. Works from anywhere.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MODES = ['local', 'remote'];
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'data', 'state.json');

const STUN_URLS = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',').map(s => s.trim()).filter(Boolean);
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const TURN_SECRET = process.env.TURN_SECRET || '';       // coturn: use-auth-secret / static-auth-secret
const TURN_USERNAME = process.env.TURN_USERNAME || '';   // or static credentials
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';
const TURN_TTL = parseInt(process.env.TURN_TTL || '21600', 10); // 6h
const LOCAL_IP_MATCH = process.env.LOCAL_IP_MATCH !== 'false';

let mode = loadInitialMode();

function loadInitialMode() {
    try {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (MODES.includes(saved.mode)) {
            console.log(`[access] mode "${saved.mode}" loaded from ${STATE_FILE}`);
            return saved.mode;
        }
    } catch (_) { /* no saved state */ }
    const env = (process.env.ACCESS_MODE || 'local').toLowerCase();
    if (!MODES.includes(env)) {
        console.warn(`[access] invalid ACCESS_MODE "${env}", falling back to "local"`);
        return 'local';
    }
    return env;
}

function getMode() {
    return mode;
}

function setMode(next) {
    if (!MODES.includes(next)) throw new Error(`invalid mode "${next}" (use: ${MODES.join(' | ')})`);
    mode = next;
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify({ mode, updatedAt: new Date().toISOString() }));
    } catch (err) {
        console.warn(`[access] could not persist mode to ${STATE_FILE}: ${err.message}`);
    }
    return mode;
}

// ── ICE servers handed to clients ─────────────────────────

function turnCredentials() {
    if (TURN_SECRET) {
        // coturn REST API: username = expiry timestamp, credential = base64(HMAC-SHA1(secret, username))
        const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:kamera`;
        const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
        return { username, credential };
    }
    if (TURN_USERNAME && TURN_CREDENTIAL) return { username: TURN_USERNAME, credential: TURN_CREDENTIAL };
    return null;
}

function getClientConfig() {
    if (mode === 'local') return { mode, iceServers: [] };

    const iceServers = [];
    if (STUN_URLS.length) iceServers.push({ urls: STUN_URLS });
    const creds = TURN_URLS.length ? turnCredentials() : null;
    if (creds) iceServers.push({ urls: TURN_URLS, ...creds });
    return { mode, iceServers };
}

function hasTurn() {
    return TURN_URLS.length > 0 && !!turnCredentials();
}

// ── LAN candidate filtering ───────────────────────────────

function isPrivateAddress(addr) {
    if (!addr) return false;
    const a = addr.toLowerCase().replace(/^\[|\]$/g, '');

    // mDNS-obfuscated host candidates (Chrome/Safari): only resolvable on the LAN
    if (a.endsWith('.local')) return true;

    const v4 = a.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (v4) {
        const [o1, o2] = [Number(v4[1]), Number(v4[2])];
        return o1 === 10
            || (o1 === 172 && o2 >= 16 && o2 <= 31)
            || (o1 === 192 && o2 === 168)
            || (o1 === 169 && o2 === 254);
        // 100.64.0.0/10 (CGNAT) is intentionally NOT allowed: it is shared between ISP customers
    }

    if (a.includes(':')) {
        return /^fe[89ab]/.test(a)   // fe80::/10 link-local
            || /^f[cd]/.test(a);     // fc00::/7  unique local
        // global IPv6 (2xxx:, 3xxx:) is routable from the internet → blocked
    }
    return false;
}

// "candidate:842163049 1 udp 1677729535 192.168.1.5 54321 typ host ..."
function isLanCandidateLine(line) {
    const parts = line.replace(/^a=/, '').trim().split(/\s+/);
    const typIdx = parts.indexOf('typ');
    if (parts.length < 8 || typIdx === -1) return false;
    return parts[typIdx + 1] === 'host' && isPrivateAddress(parts[4]);
}

// Returns the candidate if allowed in the current mode, otherwise null.
function filterCandidate(candidate) {
    if (mode !== 'local' || !candidate) return candidate;
    const line = typeof candidate === 'string' ? candidate : candidate.candidate;
    if (!line) return candidate; // end-of-candidates marker
    return isLanCandidateLine(line) ? candidate : null;
}

// Strips non-LAN a=candidate lines out of an SDP when in local mode.
function filterSdp(sdp) {
    if (mode !== 'local' || !sdp || typeof sdp.sdp !== 'string') return sdp;
    const lines = sdp.sdp.split('\r\n').filter(l => !l.startsWith('a=candidate:') || isLanCandidateLine(l));
    return { ...sdp, sdp: lines.join('\r\n') };
}

// ── Same-network check (public IP seen by the server) ─────

function clientIp(socket) {
    // Behind Easypanel/Traefik the real client is the LAST entry the proxy appended.
    const xff = socket.handshake.headers['x-forwarded-for'];
    const ip = xff ? xff.split(',').pop().trim() : socket.handshake.address;
    return (ip || '').replace(/^::ffff:/, '');
}

function sameNetwork(ipA, ipB) {
    if (!LOCAL_IP_MATCH || !ipA || !ipB) return true;
    const v6A = ipA.includes(':');
    const v6B = ipB.includes(':');
    // Different families (one over IPv4, the other over IPv6): can't compare;
    // the candidate filter still guarantees the media path stays on the LAN.
    if (v6A !== v6B) return true;
    if (!v6A) return ipA === ipB;
    // IPv6: every device has its own address, compare the /64 prefix
    const prefix = ip => expandV6(ip).slice(0, 4).join(':');
    return prefix(ipA) === prefix(ipB);
}

function expandV6(ip) {
    const [head, tail = ''] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const fill = ip.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
    return [...h, ...fill, ...t].map(p => p.padStart(4, '0'));
}

module.exports = {
    MODES,
    getMode,
    setMode,
    getClientConfig,
    hasTurn,
    filterCandidate,
    filterSdp,
    clientIp,
    sameNetwork,
    isPrivateAddress,
};
