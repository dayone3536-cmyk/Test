// Run: node app.js   (Node 18+, no dependencies)
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY  (secret / service_role key, keep it server-side only)
const http = require('http'), fs = require('fs'), crypto = require('crypto');
const SB = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, ''); // strips trailing slash
const KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const invites = Object.create(null); // video invites: code -> {from, buf, type, exp}
const users = {}, inbox = {}; // users/friends are mirrored in Supabase; videos stay in memory on purpose
const rid = () => crypto.randomBytes(6).toString('hex');
const byKey = k => Object.values(users).find(u => u.key === k);
const pub = u => ({ id: u.id, name: u.name });
const TTLS = [30, 120, 360]; // minutes a video stays available
// a valid invite code is single-use: taking it deletes it
const take = (c, not) => { const i = invites[c]; if (!i || i.exp < Date.now() || i.from === not) return null; delete invites[c]; return users[i.from] || null; };
const peek = c => { const i = invites[c]; return i && i.exp > Date.now() ? i : null; };

// sb_secret_ keys are not JWTs, so only send Authorization for legacy eyJ... keys
const sb = (path, body) => fetch(SB + '/rest/v1/' + path, {
  method: body ? 'POST' : 'GET',
  headers: {
    apikey: KEY,
    ...(KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + KEY } : {}),
    'Content-Type': 'application/json',
    Prefer: 'resolution=ignore-duplicates'
  },
  body: body && JSON.stringify(body)
}).then(async r => {
  const t = await r.text();
  if (!r.ok) throw new Error(r.status + ' ' + t);
  return t ? JSON.parse(t) : null;
});

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
    if (SB && KEY) await sb('users', { id, name, key }).catch(e => console.error('save user failed', e.message));
    const inv = take(q.get('c')); // arrived through a video invite: friends both ways, instantly
    if (inv) { users[id].friends.add(inv.id); inv.friends.add(id); if (SB && KEY) await sb('friends', [{ a: id, b: inv.id }, { a: inv.id, b: id }]).catch(e => console.error('save friends failed', e.message)); }
    return json({ id, key, name });
  }
  if (p === '/api/invite_info') { const i = peek(q.get('c')); return i ? json({ name: users[i.from].name }) : json({ error: 'gone' }, 404); }
  if (p === '/api/invite_clip') {
    const i = peek(q.get('c')); if (!i) return json({ error: 'gone' }, 404);
    res.writeHead(200, { 'Content-Type': i.type, 'Content-Length': i.buf.length, 'Cache-Control': 'no-store' });
    return res.end(i.buf);
  }
  if (!me) return json({ error: 'auth' }, 401);

  if (p === '/api/me') {
    const now = Date.now();
    return json({
      ...pub(me),
      friends: [...me.friends].map(i => pub(users[i])),
      inbox: inbox[me.id].filter(v => v.exp > now)
        .map(v => ({ vid: v.vid, name: v.name, left: Math.max(1, Math.ceil((v.exp - now) / 6e4)), seen: !!v.seen }))
    });
  }
  if (p === '/api/search') { // empty query lists up to 10 people you haven't added
    const s = (q.get('q') || '').toLowerCase();
    return json(Object.values(users).filter(x => x.id !== me.id && !me.friends.has(x.id) && x.name.toLowerCase().includes(s)).slice(0, 10).map(pub));
  }
  if (p === '/api/add') {
    const f = users[q.get('id')];
    if (!f || f.id === me.id) return json({ error: 'nope' }, 400);
    me.friends.add(f.id); f.friends.add(me.id);
    if (SB && KEY) await sb('friends', [{ a: me.id, b: f.id }, { a: f.id, b: me.id }]).catch(e => console.error('save friends failed', e.message));
    return json({ ok: 1, friend: pub(f) });
  }
  if (p === '/api/invite' && req.method === 'POST') {
    if (Object.values(invites).filter(i => i.from === me.id).length >= 5) return json({ error: 'too many open invites' }, 429);
    const type = req.headers['content-type'] || 'video/webm', b = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > 8e6) req.destroy(); else b.push(c); });
    req.on('end', () => { const c = rid() + rid(); invites[c] = { from: me.id, buf: Buffer.concat(b), type, exp: Date.now() + 864e5 }; json({ c }); });
    return;
  }
  if (p === '/api/claim') { // already has an account and opened someone's invite
    const f = take(q.get('c'), me.id);
    if (!f) return json({ error: 'gone' }, 400);
    me.friends.add(f.id); f.friends.add(me.id);
    if (SB && KEY) await sb('friends', [{ a: me.id, b: f.id }, { a: f.id, b: me.id }]).catch(e => console.error('save friends failed', e.message));
    return json({ ok: 1, friend: pub(f) });
  }
  if (p === '/api/send' && req.method === 'POST') {
    const ttl = TTLS.includes(+q.get('ttl')) ? +q.get('ttl') : 120, type = req.headers['content-type'] || 'video/webm';
    const b = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > 40e6) req.destroy(); else b.push(c); });
    req.on('end', () => {
      const buf = Buffer.concat(b), now = Date.now();
      me.friends.forEach(f => inbox[f].push({ vid: rid(), from: me.id, name: me.name, ttl, buf, type, t: now, exp: now + ttl * 6e4 }));
      json({ sent: me.friends.size });
    });
    return;
  }
  if (p === '/api/watch') { // stays watchable until its timer runs out, then it is deleted
    const v = inbox[me.id].find(v => v.vid === q.get('vid') && v.exp > Date.now());
    if (!v) return json({ error: 'gone' }, 404);
    v.seen = true;
    res.writeHead(200, { 'Content-Type': v.type, 'Content-Length': v.buf.length, 'Cache-Control': 'no-store' });
    return res.end(v.buf);
  }
  json({ error: '404' }, 404);
});

// expired videos are deleted every minute
setInterval(() => { const now = Date.now(); for (const k in inbox) inbox[k] = inbox[k].filter(v => v.exp > now); for (const c in invites) if (invites[c].exp < now) delete invites[c]; }, 6e4);

(async () => {
  if (SB && KEY) {
    try {
      (await sb('users?select=*')).forEach(x => { users[x.id] = { ...x, friends: new Set() }; inbox[x.id] = []; });
      (await sb('friends?select=*')).forEach(r => users[r.a] && users[r.a].friends.add(r.b));
      console.log('loaded', Object.keys(users).length, 'users from Supabase');
    } catch (e) { console.error('Supabase load failed:', e.message); }
  } else console.warn('No Supabase env vars: running in memory only');
  server.listen(process.env.PORT || 3000, () => console.log('up'));
})();
