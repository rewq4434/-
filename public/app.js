const SIZE = 15;
const $ = id => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');
let ws, state = null, myColor = 0, hover = null;

$('name').value = localStorage.getItem('omokName') || ('플레이어' + Math.floor(1000 + Math.random() * 9000));
let pendingRoom = null; // 연결되면 바로 입장할 방 (초대 링크)

function showInvite(code) {
  code = String(code || '').toUpperCase().trim();
  if (!code) return;
  pendingRoom = code;
  $('codeInput').value = code;
  $('inviteCode').textContent = code;
  $('inviteBox').classList.remove('hidden');
  $('createBtn').classList.remove('primary');
}
showInvite(new URLSearchParams(location.search).get('room'));

// ───────── 연결 방식 ─────────
// server : Node 서버(WebSocket)에 접속 — 직접 서버를 띄운 경우
// p2p    : 서버 없이 방장 브라우저가 서버 역할 (GitHub Pages 등 정적 호스팅, 앱 기본값)
const IS_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const WEB_URL = window.OMOK_WEB_URL || '';
let mode, serverUrl = '';
if (IS_APP) {
  serverUrl = localStorage.getItem('omokServer') || window.OMOK_SERVER || '';
  mode = serverUrl ? 'server' : 'p2p';
} else {
  mode = window.OMOK_MODE === 'p2p' || window.OMOK_MODE === 'server' ? window.OMOK_MODE
    : (/github\.io$/.test(location.hostname) || location.protocol === 'file:') ? 'p2p' : 'server';
  serverUrl = location.origin;
}

function inviteBase() {
  if (mode === 'server') return serverUrl + '/';
  if (!IS_APP) return location.origin + location.pathname;
  return WEB_URL;
}

if (IS_APP) {
  $('serverRow').classList.remove('hidden');
  $('serverInput').value = mode === 'server' ? serverUrl : '';
  $('serverBtn').onclick = () => {
    // 카톡 메시지를 통째로 붙여넣어도 링크와 방 코드를 찾아냄
    const v = $('serverInput').value.trim();
    const urlText = (v.match(/https?:\/\/\S+/) || [v.split(/\s+/)[0] || ''])[0];
    if (!urlText) { mode = 'p2p'; localStorage.removeItem('omokServer'); applyMode(); return; }
    let u;
    try { u = new URL(/^https?:\/\//.test(urlText) ? urlText : 'http://' + urlText); }
    catch { $('lobbyMsg').textContent = '주소를 확인해 주세요.'; return; }
    if (u.searchParams.get('room')) showInvite(u.searchParams.get('room'));
    if (/github\.io$/.test(u.hostname) || (WEB_URL && u.hostname === new URL(WEB_URL).hostname)) {
      mode = 'p2p'; localStorage.removeItem('omokServer'); $('serverInput').value = '';
    } else {
      mode = 'server'; serverUrl = u.origin; localStorage.setItem('omokServer', serverUrl); $('serverInput').value = serverUrl;
    }
    applyMode();
  };
}
if ('serviceWorker' in navigator && !IS_APP && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');

function applyMode() {
  $('quickBtn').classList.toggle('hidden', mode === 'p2p'); // P2P에는 매칭 서버가 없음
  if (mode === 'server') { p2pReset(); connect(); }
  else {
    clearTimeout(retryTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    $('lobbyMsg').textContent = '';
    if (pendingRoom && localStorage.getItem('omokName')) joinPending(); // 이름을 정해둔 적 있으면 바로 입장
  }
}

// ───────── server 모드 ─────────
let retryTimer = null;
function connect() {
  clearTimeout(retryTimer);
  if (ws) { ws.onclose = null; ws.close(); }
  try { ws = new WebSocket(serverUrl.replace(/^http/, 'ws')); }
  catch { $('lobbyMsg').textContent = '잘못된 서버 주소입니다.'; return; }
  $('lobbyMsg').textContent = '서버에 연결 중…';
  const slow = setTimeout(() => {
    if (ws.readyState === 0) $('lobbyMsg').textContent = '서버를 깨우는 중이에요… (무료 서버는 처음 접속할 때 최대 1분 걸려요)';
  }, 4000);
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => {
    $('lobbyMsg').textContent = '서버 연결이 끊겼습니다. 재연결 중…';
    showLobby();
    retryTimer = setTimeout(connect, 2000);
  };
  ws.onopen = () => {
    clearTimeout(slow);
    $('lobbyMsg').textContent = IS_APP ? '✅ 서버에 연결됨' : '';
    if (pendingRoom && localStorage.getItem('omokName')) joinPending();
  };
}

// ───────── p2p 모드 (서버 없이: 공개 MQTT 중계 서버로 메시지만 주고받음) ─────────
// 방장 기기가 게임 규칙(core.js)을 실행하고, 중계 서버는 메시지를 전달만 함.
// WebRTC 직접 연결을 쓰지 않으므로 LTE/5G·회사 와이파이 등 어떤 네트워크에서도 동작.
const BROKERS = window.OMOK_BROKERS || [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];
const TOPIC = 'omok-rewq4434/v2/';
const myId = (localStorage.getItem('omokId') || (() => {
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  localStorage.setItem('omokId', id); return id;
})());
const DEAD_MS = 90000; // 이 시간 동안 소식이 없으면 연결 끊김으로 판단 (카톡 다녀오는 시간 여유)
let mq = null, core = null, localConn = null, roomBase = '', hbTimer = null, hostSeen = 0, myToken = 0;
const clients = new Map();

function p2pReset() {
  myToken++;
  clearInterval(hbTimer); hbTimer = null;
  const c = mq;
  if (c) {
    try { c.publish(roomBase + (core ? '/down' : '/up'), JSON.stringify(core ? { t: 'closed' } : { from: myId, t: 'bye' }), { qos: 1 }); } catch (e) {}
    setTimeout(() => c.end(false), 500); // 마지막 메시지가 전달될 시간
  }
  mq = null; core = null; localConn = null; roomBase = ''; clients.clear();
}
function p2pMsg(text) {
  if ($('game').classList.contains('hidden')) $('lobbyMsg').textContent = text; else log('⚠ ' + text);
}
function randomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = ''; for (let i = 0; i < 5; i++) c += A[Math.floor(Math.random() * A.length)];
  return c;
}
// 중계 서버 하나에 접속 (실패/시간초과면 reject)
function brokerConnect(url) {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(url, {
      clientId: 'omok_' + myId + '_' + Math.random().toString(36).slice(2, 6),
      clean: false, connectTimeout: 7000, reconnectPeriod: 2000, keepalive: 30, protocolVersion: 4,
    });
    let done = false;
    const fail = () => { if (!done) { done = true; c.end(true); reject(); } };
    c.once('connect', () => { if (!done) { done = true; resolve(c); } });
    c.on('error', () => {});
    c.once('close', fail); // 접속 실패하면 바로 다음 중계 서버로
    c.once('offline', fail);
    setTimeout(fail, 7000);
  });
}
const pub = (c, topic, obj) => c.publish(topic, JSON.stringify(obj), { qos: 1 });
const parse = buf => { try { return JSON.parse(buf.toString()); } catch (e) { return null; } };

async function p2pHost(nm) {
  p2pReset();
  const token = myToken, code = randomCode(), base = TOPIC + code;
  $('lobbyMsg').textContent = '방을 만드는 중…';
  let c = null;
  for (const url of BROKERS) {
    try { c = await brokerConnect(url); break; } catch (e) {}
    if (token !== myToken) return;
  }
  if (token !== myToken) { if (c) c.end(true); return; }
  if (!c) { $('lobbyMsg').textContent = '중계 서버에 접속할 수 없어요. 인터넷 연결을 확인하고 다시 시도해 주세요.'; return; }
  mq = c; roomBase = base;
  $('lobbyMsg').textContent = '';
  core = OmokCore.createGame({ allowCode: true });
  localConn = { send: m => setTimeout(() => handle(m)) };
  core.connect(localConn);
  core.message(localConn, { type: 'create', name: nm, code });
  c.subscribe(base + '/up', { qos: 1 });
  c.on('message', (topic, buf) => {
    if (c !== mq) return;
    const d = parse(buf); if (!d || !d.from) return;
    const id = String(d.from);
    let cl = clients.get(id);
    if (d.t === 'bye') { if (cl) { clients.delete(id); core.close(cl.conn); } return; }
    if (d.t === 'ping') {
      if (cl) cl.seen = Date.now(); else pub(c, base + '/to/' + id, { t: 'gone' }); // 모르는 사람 → 다시 입장하라고 알림
      return;
    }
    if (d.t !== 'm' || !d.m) return;
    if (!cl) {
      if (d.m.type !== 'join') return pub(c, base + '/to/' + id, { t: 'gone' });
      cl = { conn: { send: m => pub(c, base + '/to/' + id, { t: 'm', m }) }, seen: 0 };
      core.connect(cl.conn); clients.set(id, cl);
    }
    cl.seen = Date.now();
    core.message(cl.conn, d.m);
  });
  hbTimer = setInterval(() => {
    if (c !== mq) return;
    const now = Date.now();
    for (const [id, cl] of clients) if (now - cl.seen > DEAD_MS) { clients.delete(id); core.close(cl.conn); }
    if (clients.size) pub(c, base + '/down', { t: 'alive' });
  }, 5000);
}

async function p2pJoin(nm, code) {
  p2pReset();
  const token = myToken, base = TOPIC + code;
  $('lobbyMsg').textContent = '방에 연결 중…';
  for (const url of BROKERS) { // 방장이 어느 중계 서버에 있는지 차례로 찾아봄
    let c;
    try { c = await brokerConnect(url); } catch (e) { if (token !== myToken) return; continue; }
    if (token !== myToken) { c.end(true); return; }
    const pending = [];
    const process = d => {
      hostSeen = Date.now();
      if (d.t === 'm') handle(d.m);
      else if (d.t === 'closed' || d.t === 'gone') hostLost(d.t === 'closed' ? '방장이 방을 닫았어요.' : '방장과의 연결이 끊어졌어요.');
    };
    const found = await new Promise(resolve => {
      let got = false;
      c.on('message', (topic, buf) => {
        const d = parse(buf); if (!d) return;
        if (!got) { if (d.t !== 'm') return; got = true; resolve(true); }
        if (c !== mq) { if (!mq || mq === null) pending.push(d); return; }
        process(d);
      });
      c.subscribe([base + '/to/' + myId, base + '/down'], { qos: 1 }, () => {
        pub(c, base + '/up', { from: myId, t: 'm', m: { type: 'join', name: nm, code } });
      });
      setTimeout(() => { if (!got) resolve(false); }, 6000);
    });
    if (token !== myToken) { c.end(true); return; }
    if (!found) { c.end(true); continue; }
    mq = c; roomBase = base; hostSeen = Date.now();
    $('lobbyMsg').textContent = '';
    pending.splice(0).forEach(process);
    // 재접속하면 최신 판 상태를 다시 받아옴
    c.on('connect', () => { if (c === mq) pub(c, base + '/up', { from: myId, t: 'm', m: { type: 'sync' } }); });
    hbTimer = setInterval(() => {
      if (c !== mq) return;
      pub(c, base + '/up', { from: myId, t: 'ping' });
      if (Date.now() - hostSeen > DEAD_MS) hostLost('방장과의 연결이 끊어졌어요.');
    }, 5000);
    return;
  }
  if (token === myToken) $('lobbyMsg').textContent = '방을 찾을 수 없어요. 방장이 나갔거나 코드가 틀렸어요.';
}
function hostLost(text) {
  mq = null; // p2pReset에서 'bye'를 보내지 않도록
  p2pReset();
  showLobby();
  $('lobbyMsg').textContent = text;
}
// 다른 앱(카톡 등)에 다녀오면 바로 생존 신호 보내기
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !mq || !roomBase) return;
  if (core) { if (clients.size) pub(mq, roomBase + '/down', { t: 'alive' }); }
  else { pub(mq, roomBase + '/up', { from: myId, t: 'ping' }); pub(mq, roomBase + '/up', { from: myId, t: 'm', m: { type: 'sync' } }); }
});

// ───────── 공통 ─────────
function send(msg) {
  if (mode === 'server') {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    else $('lobbyMsg').textContent = '서버에 연결되어 있지 않습니다.';
    return;
  }
  if (msg.type === 'create') return p2pHost(msg.name);
  if (msg.type === 'join') return p2pJoin(msg.name, String(msg.code || '').toUpperCase().trim());
  if (core) core.message(localConn, msg);
  else if (mq && roomBase) pub(mq, roomBase + '/up', { from: myId, t: 'm', m: msg });
  if (msg.type === 'leave') { if (!core) showLobby(); p2pReset(); }
}
function name() { const n = $('name').value.trim() || '익명'; localStorage.setItem('omokName', n); return n; }

function joinPending() {
  if (!pendingRoom) return;
  send({ type: 'join', name: name(), code: pendingRoom });
  pendingRoom = null;
  $('inviteBox').classList.add('hidden');
  $('createBtn').classList.add('primary');
}
$('inviteBtn').onclick = joinPending;
$('quickBtn').onclick = () => send({ type: 'quick', name: name() });
$('createBtn').onclick = () => send({ type: 'create', name: name() });
$('joinBtn').onclick = () => send({ type: 'join', name: name(), code: $('codeInput').value });
$('codeInput').onkeydown = e => { if (e.key === 'Enter') $('joinBtn').click(); };
$('leaveBtn').onclick = () => {
  if (mode === 'p2p' && core && state && state.players[1] && !confirm('방장이 나가면 방이 닫혀요. 나갈까요?')) return;
  send({ type: 'leave' });
};
$('resignBtn').onclick = () => { if (confirm('정말 기권하시겠습니까?')) send({ type: 'resign' }); };
$('undoBtn').onclick = () => send({ type: 'undo' });
$('rematchBtn').onclick = () => send({ type: 'rematch' });
$('copyBtn').textContent = navigator.share ? '초대하기' : '링크 복사';
$('copyBtn').onclick = async () => {
  const link = `${inviteBase()}?room=${state.code}`;
  const text = `오목 한 판 해요! 방 코드: ${state.code}`;
  if (navigator.share) { try { await navigator.share({ title: '온라인 오목', text, url: link }); return; } catch {} }
  navigator.clipboard?.writeText(`${text}\n${link}`).then(() => log('초대 링크가 복사되었습니다.'), () => prompt('링크를 복사하세요', link));
};
$('chatForm').onsubmit = e => {
  e.preventDefault();
  send({ type: 'chat', text: $('chatInput').value });
  $('chatInput').value = '';
};

function showLobby() { $('lobby').classList.remove('hidden'); $('game').classList.add('hidden'); state = null; }
function showGame() { $('lobby').classList.add('hidden'); $('game').classList.remove('hidden'); resize(); }

function log(text, cls = 'info', who) {
  const d = document.createElement('div');
  d.className = cls;
  if (who) { const b = document.createElement('b'); b.textContent = who + ': '; d.append(b); }
  d.append(text);
  $('chatLog').append(d);
  $('chatLog').scrollTop = 1e9;
}

function handle(m) {
  switch (m.type) {
    case 'joined':
      $('chatLog').innerHTML = '';
      if (!IS_APP) history.replaceState(null, '', location.pathname + '?room=' + m.code);
      showGame();
      if (m.color === 1) {
        log('👉 위의 "' + $('copyBtn').textContent + '" 버튼을 눌러 친구에게 링크를 보내세요. 친구가 링크를 누르면 바로 대국이 시작돼요!', 'hint');
        if (mode === 'p2p') log('💡 내가 방장이라 이 화면을 닫으면 방이 사라져요.', 'hint');
      }
      break;
    case 'state': {
      const prevMoves = state && state.last;
      state = m; myColor = m.you;
      render();
      if (m.last && (!prevMoves || prevMoves.x !== m.last.x || prevMoves.y !== m.last.y)) beep();
      break;
    }
    case 'chat': log(m.text, 'chat', (m.color === 1 ? '⚫ ' : m.color === 2 ? '⚪ ' : '👀 ') + m.name); break;
    case 'info': log(m.text); break;
    case 'error':
      if (/존재하지 않는/.test(m.text)) $('inviteBox').classList.add('hidden');
      if ($('game').classList.contains('hidden')) $('lobbyMsg').textContent = m.text; else log('⚠ ' + m.text);
      break;
    case 'undoReq':
      send({ type: 'undoReply', accept: confirm(`${m.from} 님이 무르기를 요청했습니다. 수락할까요?`) });
      break;
    case 'left':
      if (!IS_APP) history.replaceState(null, '', location.pathname);
      showLobby();
      break;
  }
}

function render() {
  const s = state;
  $('roomCode').textContent = s.code;
  ['p1', 'p2'].forEach((id, i) => {
    const el = $(id);
    el.querySelector('.pname').textContent = s.players[i] || '대기 중…';
    el.classList.toggle('turn', s.started && !s.winner && s.turn === i + 1);
    el.classList.toggle('me', myColor === i + 1);
  });
  let st;
  if (!s.players[0] || !s.players[1]) st = s.winner > 0 ? `${s.winner === 1 ? '흑' : '백'} 승리!` : '상대를 기다리는 중…';
  else if (s.winner === -1) st = '무승부!';
  else if (s.winner) st = s.winner === myColor ? '🎉 승리했습니다!' : myColor ? '패배했습니다' : `${s.winner === 1 ? '흑' : '백'} 승리!`;
  else if (!s.started) st = '대기 중';
  else st = s.turn === myColor ? '당신의 차례입니다' : myColor ? '상대의 차례입니다' : `${s.turn === 1 ? '흑' : '백'}의 차례`;
  $('status').textContent = st;
  $('spec').textContent = myColor ? (s.spectators ? `관전자 ${s.spectators}명` : '') : `관전 중 · 관전자 ${s.spectators}명`;

  const playing = myColor && s.started && !s.winner;
  $('resignBtn').disabled = !playing;
  $('undoBtn').disabled = !playing || !s.last || s.last.c !== myColor;
  const canRematch = myColor && s.winner && s.players[0] && s.players[1];
  $('rematchBtn').classList.toggle('hidden', !canRematch);
  $('rematchBtn').disabled = s.rematch.includes(myColor);
  $('rematchBtn').textContent = s.rematch.includes(myColor) ? '상대 대기 중…' : s.rematch.length ? '상대가 재대결 원함! 수락' : '다시 하기';
  draw();
}

// ---------- 보드 그리기 ----------
let cell, pad;
function resize() {
  const css = canvas.getBoundingClientRect().width || 600;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.height = css * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cell = css / (SIZE + 1);
  pad = cell;
  draw();
}
window.addEventListener('resize', resize);

function draw() {
  if (!cell) return;
  const W = cell * (SIZE + 1);
  ctx.fillStyle = '#dcb35c';
  ctx.fillRect(0, 0, W, W);
  ctx.strokeStyle = '#3b2a14';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    const p = pad + i * cell;
    ctx.beginPath(); ctx.moveTo(pad, p); ctx.lineTo(pad + (SIZE - 1) * cell, p); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p, pad); ctx.lineTo(p, pad + (SIZE - 1) * cell); ctx.stroke();
  }
  ctx.fillStyle = '#3b2a14';
  for (const [x, y] of [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]]) {
    ctx.beginPath(); ctx.arc(pad + x * cell, pad + y * cell, cell * 0.12, 0, 7); ctx.fill();
  }
  if (!state) return;
  const b = state.board;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (b[y][x]) stone(x, y, b[y][x], 1);

  if (hover && myColor && state.turn === myColor && state.started && !state.winner && !b[hover.y][hover.x])
    stone(hover.x, hover.y, myColor, 0.4);

  if (state.last) {
    const { x, y } = state.last;
    ctx.fillStyle = '#e33';
    ctx.beginPath(); ctx.arc(pad + x * cell, pad + y * cell, cell * 0.12, 0, 7); ctx.fill();
  }
  if (state.winLine) {
    ctx.strokeStyle = '#e33'; ctx.lineWidth = 3;
    for (const [x, y] of state.winLine) {
      ctx.beginPath(); ctx.arc(pad + x * cell, pad + y * cell, cell * 0.45, 0, 7); ctx.stroke();
    }
  }
}

function stone(x, y, c, alpha) {
  const cx = pad + x * cell, cy = pad + y * cell, r = cell * 0.45;
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  if (c === 1) { g.addColorStop(0, '#666'); g.addColorStop(1, '#000'); }
  else { g.addColorStop(0, '#fff'); g.addColorStop(1, '#bbb'); }
  ctx.fillStyle = g;
  ctx.shadowColor = '#0006'; ctx.shadowBlur = alpha === 1 ? 3 : 0; ctx.shadowOffsetY = 1;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.globalAlpha = 1;
}

function toCell(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.round((e.clientX - r.left - pad) / cell);
  const y = Math.round((e.clientY - r.top - pad) / cell);
  return x >= 0 && y >= 0 && x < SIZE && y < SIZE ? { x, y } : null;
}
const myTurn = () => state && state.started && !state.winner && state.turn === myColor;
canvas.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') { hover = toCell(e); draw(); } });
canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { hover = null; draw(); } });
canvas.addEventListener('pointerup', e => {
  const c = toCell(e);
  if (!c || !myTurn() || state.board[c.y][c.x]) return;
  // 모바일: 첫 탭은 위치 미리보기, 같은 자리를 다시 탭하면 착수 (오터치 방지)
  if (e.pointerType !== 'mouse' && !(hover && hover.x === c.x && hover.y === c.y)) {
    hover = c; draw();
    $('status').textContent = '같은 자리를 한 번 더 누르면 착수';
    return;
  }
  hover = null;
  send({ type: 'move', x: c.x, y: c.y });
  navigator.vibrate?.(15);
});

// 착수 효과음
let actx;
function beep() {
  try {
    actx = actx || new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = 520; o.type = 'triangle';
    g.gain.setValueAtTime(0.15, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.12);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.12);
  } catch {}
}

// 웹: 홈 화면에 앱으로 설치 안내
let installEvt;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('installBtn').classList.remove('hidden'); });
$('installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; $('installBtn').classList.add('hidden'); };
if (!IS_APP && mode === 'p2p' && /Android/.test(navigator.userAgent)) $('apkLink').classList.remove('hidden');
if (!IS_APP && /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone) $('iosHint').classList.remove('hidden');

applyMode();
