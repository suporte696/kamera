#!/usr/bin/env node
// Usage (inside the container / Easypanel console):
//   node cli.js status
//   node cli.js local     → only devices on the same Wi-Fi/LAN
//   node cli.js remote    → access from anywhere (STUN + TURN)

const http = require('http');

const PORT = process.env.PORT || 3000;
const cmd = (process.argv[2] || 'status').toLowerCase();

const routes = {
    status: { method: 'GET', path: '/admin/mode' },
    local: { method: 'POST', path: '/admin/mode/local' },
    remote: { method: 'POST', path: '/admin/mode/remote' },
};

const route = routes[cmd];
if (!route) {
    console.error(`Unknown command "${cmd}". Use: status | local | remote`);
    process.exit(1);
}

const req = http.request({ host: '127.0.0.1', port: PORT, ...route }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch (_) { data = { error: body || `HTTP ${res.statusCode}` }; }
        if (res.statusCode !== 200) {
            console.error(`Error: ${data.error}`);
            process.exit(1);
        }
        const label = data.mode === 'local' ? 'LOCAL (somente mesma rede)' : 'REMOTE (qualquer lugar)';
        console.log(`Modo de acesso: ${label}`);
        if (data.mode === 'remote' && !data.turn) {
            console.log('Aviso: TURN não configurado (TURN_URLS + TURN_SECRET). Em 4G/CGNAT a conexão pode falhar.');
        }
        if ('clients' in data) console.log(`Câmera online: ${data.broadcaster ? 'sim' : 'não'} | clientes conectados: ${data.clients}`);
    });
});

req.on('error', (err) => {
    console.error(`Não foi possível falar com o servidor na porta ${PORT}: ${err.message}`);
    process.exit(1);
});
req.end();
