'use strict';
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

// ── Constants (keep in sync with client) ─────────────────
const MAX_HP     = 100;
const BULLET_DMG = 25;
const RESPAWN_MS = 3000;
const KILL_LIMIT = 10;

// ── HTTP – serves game files ──────────────────────────────
const httpServer = http.createServer((req, res) => {
    const safePath = req.url === '/' ? '/index.html' : req.url.replace(/\.\./g, '');
    const filePath = path.join(__dirname, safePath);
    const ext      = path.extname(filePath);
    const mime     = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(filePath));
});

// ── WebSocket – game logic ────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

const slots = [null, null]; // ws for P1 and P2

const gs = {
    hp:         [MAX_HP, MAX_HP],
    kills:      [0, 0],
    respawning: [false, false],
    over:       false,
    winner:     -1,
};

function resetGs() {
    gs.hp         = [MAX_HP, MAX_HP];
    gs.kills      = [0, 0];
    gs.respawning = [false, false];
    gs.over       = false;
    gs.winner     = -1;
}

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(data, excludeId = -1) {
    slots.forEach((ws, i) => { if (i !== excludeId) send(ws, data); });
}

wss.on('connection', ws => {
    const id = slots[0] === null ? 0 : slots[1] === null ? 1 : -1;

    if (id === -1) { send(ws, { type: 'full' }); ws.close(); return; }

    slots[id] = ws;
    ws.pid    = id;
    console.log(`[+] Player ${id + 1} connected  (${wss.clients.size}/2 slots filled)`);

    send(ws, { type: 'assigned', playerId: id, hp: gs.hp, kills: gs.kills });

    if (slots[id ^ 1]) {
        send(ws,          { type: 'opponent_joined' });
        send(slots[id^1], { type: 'opponent_joined' });
    }

    ws.on('message', raw => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        const oth = slots[id ^ 1];

        switch (msg.type) {

            case 'state':
                send(oth, { type:'opponent_state', pos:msg.pos, yaw:msg.yaw, pitch:msg.pitch });
                break;

            case 'shoot_hit': {
                if (gs.over || gs.respawning[id ^ 1]) break;
                gs.hp[id ^ 1] = Math.max(0, gs.hp[id ^ 1] - BULLET_DMG);
                if (gs.hp[id ^ 1] === 0) {
                    gs.kills[id]++;
                    gs.respawning[id ^ 1] = true;
                    broadcast({ type:'killed', victimId:id^1, killerId:id, kills:gs.kills });
                    if (gs.kills[id] >= KILL_LIMIT) {
                        gs.over = true; gs.winner = id;
                        broadcast({ type:'game_over', winnerId:id, kills:gs.kills });
                    } else {
                        setTimeout(() => {
                            if (!gs.over) {
                                gs.hp[id^1]         = MAX_HP;
                                gs.respawning[id^1] = false;
                                broadcast({ type:'respawned', playerId:id^1 });
                            }
                        }, RESPAWN_MS);
                    }
                } else {
                    broadcast({ type:'hit', victimId:id^1, hp:gs.hp[id^1] });
                }
                break;
            }

            case 'shoot_effect':
                send(oth, { type:'opponent_shoot', hit:msg.hit, hitPos:msg.hitPos });
                break;

            case 'restart':
                if (gs.over && slots[0] && slots[1]) {
                    resetGs();
                    broadcast({ type:'restart' });
                }
                break;
        }
    });

    ws.on('close', () => {
        slots[id] = null;
        console.log(`[-] Player ${id + 1} disconnected  (${wss.clients.size} remaining)`);
        send(slots[id ^ 1], { type:'opponent_left' });
    });

    ws.on('error', err => console.error(`WS P${id+1} error:`, err.message));
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════╗`);
    console.log(`  ║  FUTURE SHOOTERS — Game Server  ║`);
    console.log(`  ╚══════════════════════════════════╝`);
    console.log(`\n  Both players open:  http://localhost:${PORT}\n`);
    console.log(`  First to connect  → PLAYER 1 (Blue)`);
    console.log(`  Second to connect → PLAYER 2 (Orange)\n`);
});
