// copad — 共同編輯筆記（hackmd-lite）
// GET  /                首頁（打房號進房）
// GET  /r/{room}        編輯頁
// GET  /api/room/{id}          內容 JSON（content + canvas）
// PUT  /api/room/{id}          存內容（知道房號=有權限，LWW；content / canvas 可分開送，server 合併）
// GET  /api/room/{id}/stream   SSE：內容變更 + 在線人數
// POST /api/upload             貼圖：代打 urusai.cc 匿名圖床，回 { ok, url }
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
const MAX_IMG_BYTES = 10 * 1024 * 1024;

const DEFAULT_CONTENT = [
  '# 新房間',
  '',
  '這是一份**共同編輯**的筆記——把這頁的網址丟給別人，打同一個房號就能一起改。',
  '',
  '- 左邊打字，右邊即時預覽',
  '- 支援 `# 標題`、`- 列點`、`[ ] 待辦`、`> 引言`、`**粗體**`、`` `code` ``、`[連結](網址)`',
  '- 直接貼上圖片（Ctrl+V）會自動上傳插入',
  '- 右邊是**畫布**：文字框可以拖曳、縮放；「背景」設底圖、「貼圖」或直接把圖片拖進畫布，貼圖能移動放大縮小',
  '- 右上角「閱讀」切換純閱讀版面，網址加 `?read` 可以直接分享閱讀版',
  '- 停止輸入就自動儲存，所有人即時同步',
].join('\n');

function roomFile(id) { return path.join(ROOMS_DIR, id + '.json'); }
function readRoom(id) {
  try {
    const r = JSON.parse(fs.readFileSync(roomFile(id), 'utf8'));
    if (r.canvas === undefined) r.canvas = null;
    return r;
  }
  catch { return { content: DEFAULT_CONTENT, canvas: null, version: 0, updatedAt: null }; }
}

// 畫布狀態：{ bg, frame:{x,y,w,h}, stickers:[{id,url,x,y,w}] }（座標一律 % of 畫布）
function sanitizeCanvas(c) {
  if (c === null) return null;
  if (typeof c !== 'object' || Array.isArray(c)) throw new Error('canvas must be object');
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : d;
  const url = v => (typeof v === 'string' && /^https?:\/\//.test(v) && v.length < 2048) ? v : null;
  const f = (c.frame && typeof c.frame === 'object') ? c.frame : {};
  return {
    bg: url(c.bg),
    frame: { x: num(f.x, 4), y: num(f.y, 4), w: num(f.w, 92), h: num(f.h, 92) },
    stickers: (Array.isArray(c.stickers) ? c.stickers : []).slice(0, 100)
      .map(s => ({ id: String(s.id || '').slice(0, 40), url: url(s.url), x: num(s.x, 40), y: num(s.y, 35), w: num(s.w, 22) }))
      .filter(s => s.id && s.url),
  };
}

function writeRoom(id, patch) {
  if (!fs.existsSync(ROOMS_DIR)) fs.mkdirSync(ROOMS_DIR, { recursive: true });
  const prev = readRoom(id);
  const room = {
    content: typeof patch.content === 'string' ? patch.content : prev.content,
    canvas: patch.canvas !== undefined ? patch.canvas : prev.canvas,
    version: (prev.version || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
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

// 貼圖上傳：代打 urusai（瀏覽器直打有 CORS）。per-IP 節流 20 張/分鐘。
const uploadHits = new Map(); // ip → { n, t }
function uploadAllowed(ip) {
  const now = Date.now();
  const h = uploadHits.get(ip);
  if (!h || now - h.t > 60000) { uploadHits.set(ip, { n: 1, t: now }); return true; }
  h.n += 1;
  return h.n <= 20;
}
async function uploadToUrusai(buf, mime) {
  const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), 'paste.' + ext);
  const r = await fetch('https://api.urusai.cc/v1/upload', { method: 'POST', body: fd });
  const j = await r.json().catch(() => null);
  const url = j && j.data && j.data.url_direct;
  if (!url) throw new Error('圖床回應異常');
  return url;
}

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

  if (req.method === 'POST' && p === '/api/upload') {
    const mime = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!/^image\//.test(mime)) return json(res, 400, { ok: false, error: '只接受圖片' });
    if (!uploadAllowed(req.socket.remoteAddress || '?')) return json(res, 429, { ok: false, error: '上傳太頻繁，休息一下再試' });
    const chunks = []; let size = 0;
    req.on('data', d => { size += d.length; if (size > MAX_IMG_BYTES) return req.destroy(); chunks.push(d); });
    req.on('end', async () => {
      try {
        const url = await uploadToUrusai(Buffer.concat(chunks), mime);
        json(res, 200, { ok: true, url });
      } catch (e) { json(res, 502, { ok: false, error: '上傳失敗：' + e.message }); }
    });
    return;
  }

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
          const b = JSON.parse(body);
          const patch = {};
          if (b.content !== undefined) {
            if (typeof b.content !== 'string') throw new Error('content must be string');
            patch.content = b.content;
          }
          if (b.canvas !== undefined) patch.canvas = sanitizeCanvas(b.canvas);
          if (patch.content === undefined && patch.canvas === undefined) throw new Error('nothing to save');
          const room = writeRoom(id, patch);
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
