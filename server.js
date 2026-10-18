// Spy / Impostor word game server — Designed & Developed by Mujtaba
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const WORDS = {
  Locations: ['Hospital', 'Airport', 'School', 'Cinema', 'Library', 'Bakery', 'Beach', 'Mosque', 'Zoo', 'Train Station', 'Bank', 'Gym'],
  Food: ['Biryani', 'Pizza', 'Burger', 'Sushi', 'Samosa', 'Ice Cream', 'Pancakes', 'Karahi', 'Noodles', 'Chocolate', 'Falooda', 'Kebab'],
  Animals: ['Elephant', 'Penguin', 'Camel', 'Dolphin', 'Eagle', 'Giraffe', 'Octopus', 'Tiger', 'Kangaroo', 'Parrot', 'Crocodile', 'Bat'],
  Jobs: ['Doctor', 'Pilot', 'Chef', 'Teacher', 'Farmer', 'Firefighter', 'Barber', 'Judge', 'Plumber', 'Astronaut', 'Tailor', 'Detective'],
  Objects: ['Umbrella', 'Mirror', 'Backpack', 'Torch', 'Clock', 'Scissors', 'Headphones', 'Candle', 'Ladder', 'Key', 'Telescope', 'Wallet'],
  Sports: ['Cricket', 'Football', 'Tennis', 'Hockey', 'Swimming', 'Boxing', 'Chess', 'Badminton', 'Kabaddi', 'Archery', 'Cycling', 'Golf']
};

const rooms = {};
const uid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function genCode() {
  let c;
  do {
    c = Array.from({ length: 4 }, () => pick('ABCDEFGHJKLMNPQRSTUVWXYZ'.split(''))).join('');
  } while (rooms[c]);
  return c;
}

function view(r, p) {
  const live = r.phase !== 'lobby';
  const isSpy = live && r.spy === p.id;
  const v = {
    code: r.code, phase: r.phase, round: r.round, me: p.id, owner: r.owner,
    players: r.players.map((x) => ({ id: x.id, name: x.name, on: x.on, voted: r.phase === 'voting' && r.votes[x.id] !== undefined })),
    log: r.log,
    pending: p.id === r.owner ? r.pending : [],
    role: live ? { spy: isSpy, category: r.cat, word: isSpy ? null : r.word } : null,
    result: r.phase === 'result' ? r.result : null
  };
  return v;
}

function push(r) {
  r.players.forEach((p) => { if (p.sid && p.on) io.to(p.sid).emit('state', view(r, p)); });
}

function startRound(r) {
  r.cat = pick(Object.keys(WORDS));
  r.word = pick(WORDS[r.cat]);
  const live = r.players.filter((x) => x.on);
  r.spy = pick(live).id;
  // Anti-spy guard: the spy can never be the room owner.
  r.owner = r.baseHost;
  if (r.owner === r.spy || !r.players.find((x) => x.id === r.owner && x.on)) {
    r.owner = pick(live.filter((x) => x.id !== r.spy)).id;
  }
  r.pending = []; r.log = []; r.votes = {}; r.result = null;
  r.phase = 'discussion';
  r.round++;
}

function endRound(r, winner, reason, tally) {
  const named = {};
  Object.entries(tally || {}).forEach(([id, n]) => {
    const pl = r.players.find((x) => x.id === id);
    if (pl) named[pl.name] = n;
  });
  r.phase = 'result';
  r.result = { winner, reason, spy: r.players.find((x) => x.id === r.spy).name, word: r.word, category: r.cat, tally: named };
}

function tally(r) {
  const c = {};
  Object.values(r.votes).forEach((t) => { c[t] = (c[t] || 0) + 1; });
  const counts = Object.values(c);
  if (!counts.length) return;
  const max = Math.max(...counts);
  const top = Object.keys(c).filter((k) => c[k] === max);
  const caught = top.length === 1 && top[0] === r.spy;
  const reason = caught ? 'The spy was caught by the vote.'
    : top.length > 1 ? 'The vote was tied, so the spy slipped away.'
    : 'The wrong player was voted out, so the spy escaped.';
  endRound(r, caught ? 'players' : 'spy', reason, c);
}

function checkVotes(r) {
  if (r.phase !== 'voting') return;
  const live = r.players.filter((x) => x.on);
  if (live.length && live.every((x) => r.votes[x.id] !== undefined)) tally(r);
}

function removePlayer(r, p) {
  r.players = r.players.filter((x) => x !== p);
  if (!r.players.length) { delete rooms[r.code]; return; }
  if (r.baseHost === p.id) r.baseHost = r.players[0].id;
  if (r.owner === p.id) r.owner = r.baseHost;
  push(r);
}

io.on('connection', (s) => {
  const ctx = () => {
    const r = rooms[s.data.code];
    const p = r && r.players.find((x) => x.id === s.data.pid);
    return r && p ? [r, p] : [null, null];
  };

  s.on('join', (d, cb) => {
    d = d || {};
    let name = String(d.name || '').trim().slice(0, 16);
    let r;
    if (d.create) {
      const k = genCode();
      r = rooms[k] = { code: k, players: [], phase: 'lobby', round: 0, pending: [], log: [], votes: {}, baseHost: null, owner: null };
    } else {
      r = rooms[String(d.code || '').toUpperCase().trim()];
    }
    if (!r) return cb({ error: 'Room not found. Check the code.' });
    let p = d.token && r.players.find((x) => x.id === d.token);
    if (!p) {
      if (!name) return cb({ error: 'Enter your name first.' });
      if (r.phase === 'discussion' || r.phase === 'voting') return cb({ error: 'A round is in progress. Join after it ends.' });
      if (r.players.length >= 12) return cb({ error: 'Room is full (12 players).' });
      if (r.players.some((x) => x.name.toLowerCase() === name.toLowerCase())) return cb({ error: 'That name is taken in this room.' });
      p = { id: uid(), name, on: true };
      r.players.push(p);
      if (!r.baseHost) { r.baseHost = p.id; r.owner = p.id; }
    }
    clearTimeout(p.timer);
    p.on = true; p.sid = s.id;
    s.data = { code: r.code, pid: p.id };
    cb({ ok: true, token: p.id, code: r.code });
    push(r);
  });

  s.on('start', () => {
    const [r, p] = ctx();
    if (!r || p.id !== r.owner || !['lobby', 'result'].includes(r.phase)) return;
    if (r.players.filter((x) => x.on).length < 4) return;
    startRound(r); push(r);
  });

  s.on('ask', (d) => {
    const [r, p] = ctx();
    if (!r || r.phase !== 'discussion' || !d) return;
    const q = String(d.q || '').trim().slice(0, 200);
    const t = r.players.find((x) => x.id === d.to);
    if (!q || !t || t.id === p.id) return;
    const item = { id: uid(), from: p.name, fromId: p.id, to: t.name, toId: t.id, q, a: null };
    if (p.id === r.owner) r.log.push(item); else r.pending.push(item);
    push(r);
  });

  s.on('approve', (d) => {
    const [r, p] = ctx();
    if (!r || p.id !== r.owner || !d) return;
    const i = r.pending.findIndex((x) => x.id === d.id);
    if (i < 0) return;
    r.log.push(r.pending.splice(i, 1)[0]); push(r);
  });

  s.on('reject', (d) => {
    const [r, p] = ctx();
    if (!r || p.id !== r.owner || !d) return;
    r.pending = r.pending.filter((x) => x.id !== d.id); push(r);
  });

  s.on('answer', (d) => {
    const [r, p] = ctx();
    if (!r || !['discussion', 'voting'].includes(r.phase) || !d) return;
    const item = r.log.find((x) => x.id === d.id && x.toId === p.id && x.a === null);
    const a = String(d.a || '').trim().slice(0, 200);
    if (!item || !a) return;
    item.a = a; push(r);
  });

  s.on('startVote', () => {
    const [r, p] = ctx();
    if (!r || p.id !== r.owner || r.phase !== 'discussion') return;
    r.phase = 'voting'; r.votes = {}; r.pending = []; push(r);
  });

  s.on('vote', (d) => {
    const [r, p] = ctx();
    if (!r || r.phase !== 'voting' || !d || d.target === p.id) return;
    if (!r.players.some((x) => x.id === d.target)) return;
    r.votes[p.id] = d.target;
    checkVotes(r);
    push(r);
  });

  s.on('endVote', () => {
    const [r, p] = ctx();
    if (!r || p.id !== r.owner || r.phase !== 'voting') return;
    if (Object.keys(r.votes).length) { tally(r); push(r); }
  });

  s.on('guess', (d) => {
    const [r, p] = ctx();
    if (!r || !['discussion', 'voting'].includes(r.phase) || p.id !== r.spy || !d) return;
    const ok = norm(d.word) === norm(r.word);
    if (!norm(d.word)) return;
    endRound(r, ok ? 'spy' : 'players', ok ? 'The spy guessed the secret word!' : 'The spy guessed the word wrong.', {});
    push(r);
  });

  s.on('disconnect', () => {
    const [r, p] = ctx();
    if (!r || p.sid !== s.id) return;
    p.on = false;
    if (r.phase === 'lobby') p.timer = setTimeout(() => { if (!p.on) removePlayer(r, p); }, 60000);
    checkVotes(r);
    push(r);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Spy game is running!  (Designed & Developed by Mujtaba)\n');
  console.log(`  This computer:  http://localhost:${PORT}`);
  Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal)
    .forEach((i) => console.log(`  Other devices:  http://${i.address}:${PORT}`));
  console.log('');
});
