// Run: node app.js   (Node 18+, no dependencies)
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY  (service_role key, keep it server-side only)
const http = require('http'), fs = require('fs'), crypto = require('crypto');
const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const users = {}, inbox = {}; // users/friends are mirrored in Supabase; videos stay in memory on purpose
const rid = () => crypto.randomBytes(6).toString('hex');
const byKey = k => Object.values(users).find(u => u.key === k);
const pub = u => ({ id: u.id, name: u.name });

const sb = (path, body) => fetch(SB + '/rest/v1/' + path, {
  method: body ? 'POST' : 'GET',
  headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates' },
  body: body && JSON.stringify(body)
}).then(r => r.text()).then(t => (t ? JSON.parse(t) : null));

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams;
  const json = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return fs.createReadStream(__dirname + '/index.html').pipe(res); }
  const me = byKey(q.get('key'));

  if (p === '/api/join') {
    const name = (q.get('name') || '').trim().slice(0, 20);
    if (!name) return json({ error: 'name' }, 400);
    const id = rid(), key = rid() + rid();
    users[id] = { id, name, key, friends: new Set() }; inbox[id] = [];
    if (SB) await sb('users', { id, name, key }).catch(e => console.error(e));
    return json({ id, key, name });
  }
  if (!me) return json({ error: 'auth' }, 401);

  if (p === '/api/me') return json({
    ...pub(me),
    friends: [...me.friends].map(i => pub(users[i])),
    inbox: inbox[me.id].map(v => ({ vid: v.vid, name: v.name, ttl: v.ttl }))
  });
  if (p === '/api/search') {
    const s = (q.get('q') || '').toLowerCase();
    return json(Object.values(users).filter(x => x.id !== me.id && !me.friends.has(x.id) && s && x.name.toLowerCase().includes(s)).slice(0, 10).map(pub));
  }
  if (p === '/api/add') {
    const f = users[q.get('id')];
    if (!f || f.id === me.id) return json({ error: 'nope' }, 400);
    me.friends.add(f.id); f.friends.add(me.id);
    if (SB) await sb('friends', [{ a: me.id, b: f.id }, { a: f.id, b: me.id }]).catch(e => console.error(e));
    return json({ ok: 1, friend: pub(f) });
  }
  if (p === '/api/send' && req.method === 'POST') {
    const ttl = Math.min(30, Math.max(3, +q.get('ttl') || 10)), type = req.headers['content-type'] || 'video/webm';
    const b = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > 40e6) req.destroy(); else b.push(c); });
    req.on('end', () => {
      const buf = Buffer.concat(b);
      me.friends.forEach(f => inbox[f].push({ vid: rid(), from: me.id, name: me.name, ttl, buf, type, t: Date.now() }));
      json({ sent: me.friends.size });
    });
    return;
  }
  if (p === '/api/watch') { // delivering a video deletes it for that person
    const list = inbox[me.id], i = list.findIndex(v => v.vid === q.get('vid'));
    if (i < 0) return json({ error: 'gone' }, 404);
    const [v] = list.splice(i, 1);
    res.writeHead(200, { 'Content-Type': v.type, 'Content-Length': v.buf.length, 'Cache-Control': 'no-store' });
    return res.end(v.buf);
  }
  json({ error: '404' }, 404);
});

// unwatched videos vanish after 24h
setInterval(() => { const c = Date.now() - 864e5; for (const k in inbox) inbox[k] = inbox[k].filter(v => v.t > c); }, 6e4);

(async () => {
  if (SB && KEY) {
    try {
      (await sb('users?select=*')).forEach(x => { users[x.id] = { ...x, friends: new Set() }; inbox[x.id] = []; });
      (await sb('friends?select=*')).forEach(r => users[r.a] && users[r.a].friends.add(r.b));
      console.log('loaded', Object.keys(users).length, 'users from Supabase');
    } catch (e) { console.error('Supabase load failed', e); }
  } else console.warn('No Supabase env vars: running in memory only');
  server.listen(process.env.PORT || 3000, () => console.log('up'));
})();
