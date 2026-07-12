// copad — 共同編輯筆記（hackmd-lite）
// GET  /                首頁（打房號進房）
// GET  /r/{room}        編輯頁
// GET  /api/room/{id}          內容 JSON
// PUT  /api/room/{id}          存內容（知道房號=有權限，LWW）
// GET  /api/room/{id}/stream   SSE：內容變更 + 在線人數
const http = require('http');
const fs = require('fs');
const path = require('path');

for (const name of ['.env', '.env.production']) {
  const p = path.join(__dirname, name);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const PORT = parseInt(process.env.PORT, 10) || 4042;
const ROOMS_DIR = path.join(__dirname, 'data', 'rooms');
const ROOM_RE = /^\d{4}$/;
const MAX_BYTES = 512 * 1024;

const DEFAULT_CONTENT = [
  '# 新房間',
  '',
  '這是一份**共同編輯**的筆記——把這頁的網址丟給別人，打同一個房號就能一起改。',
  '',
  '- 左邊打字，右邊即時預覽',
  '- 支援 `# 標題`、`- 列點`、`[ ] 待辦`、`> 引言`、`**粗體**`、`` `code` ``、`[連結](網址)`',
  '- 停止輸入就自動儲存，所有人即時同步',
].join('\n');

function roomFile(id) { return path.join(ROOMS_DIR, id + '.json'); }
function readRoom(id) {
  try { return JSON.parse(fs.readFileSync(roomFile(id), 'utf8')); }
  catch { return { content: DEFAULT_CONTENT, version: 0, updatedAt: null }; }
}
function writeRoom(id, content) {
  if (!fs.existsSync(ROOMS_DIR)) fs.mkdirSync(ROOMS_DIR, { recursive: true });
  const prev = readRoom(id);
  const room = { content, version: (prev.version || 0) + 1, updatedAt: new Date().toISOString() };
  fs.writeFileSync(roomFile(id), JSON.stringify(room));
  return room;
}

// SSE：房號 → Set<res>
const channels = new Map();
function chan(id) { if (!channels.has(id)) channels.set(id, new Set()); return channels.get(id); }
function push(id, obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of chan(id)) { try { res.write(msg); } catch { chan(id).delete(res); } }
}
function presence(id) { push(id, { type: 'presence', count: chan(id).size }); }
setInterval(() => {
  for (const [id, set] of channels) {
    for (const res of set) { try { res.write(': ping\n\n'); } catch { set.delete(res); } }
    if (set.size === 0) channels.delete(id);
  }
}, 25000);

function sendFile(res, file, type) {
  try {
    const body = fs.readFileSync(path.join(__dirname, 'public', file));
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  let m;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, 'home.html', 'text/html');
  if (req.method === 'GET' && p === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'GET' && /^\/r\/[^/]+$/.test(p)) return sendFile(res, 'pad.html', 'text/html');

  if ((m = p.match(/^\/api\/room\/([^/]+)(\/stream)?$/))) {
    const id = m[1];
    if (!ROOM_RE.test(id)) return json(res, 400, { ok: false, error: '房號是 4 位數字' });

    if (req.method === 'GET' && m[2] === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify({ type: 'room', ...readRoom(id) })}\n\n`);
      chan(id).add(res);
      presence(id);
      req.on('close', () => { chan(id).delete(res); presence(id); });
      return;
    }
    if (req.method === 'GET') return json(res, 200, readRoom(id));
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', d => { body += d; if (body.length > MAX_BYTES) req.destroy(); });
      req.on('end', () => {
        try {
          const { content } = JSON.parse(body);
          if (typeof content !== 'string') throw new Error('content must be string');
          const room = writeRoom(id, content);
          push(id, { type: 'room', ...room });
          json(res, 200, { ok: true, version: room.version, updatedAt: room.updatedAt });
        } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      });
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

server.listen(PORT, () => console.log(`[copad] running on ${PORT}`));
