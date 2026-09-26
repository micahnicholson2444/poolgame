'use strict';

/* =========================================================
   8-BALL (RED & YELLOW) — table constants
   ========================================================= */
const RAIL = 34;
const TABLE_W = 900;
const TABLE_H = 460;
const CANVAS_W = TABLE_W + RAIL * 2;
const CANVAS_H = TABLE_H + RAIL * 2;
const BALL_R = 11;
const POCKET_R = 21;
const FRICTION = 0.9865;
const MIN_SPEED = 0.045;
const MAX_PULL = 130;
const MAX_SPEED = 15.5;
const RESTITUTION_WALL = 0.86;
const RESTITUTION_BALL = 0.985;

const INNER = {
  left: RAIL + BALL_R,
  right: RAIL + TABLE_W - BALL_R,
  top: RAIL + BALL_R,
  bottom: RAIL + TABLE_H - BALL_R,
};

const POCKETS = [
  { x: RAIL, y: RAIL },
  { x: RAIL + TABLE_W / 2, y: RAIL - 6 },
  { x: RAIL + TABLE_W, y: RAIL },
  { x: RAIL, y: RAIL + TABLE_H },
  { x: RAIL + TABLE_W / 2, y: RAIL + TABLE_H + 6 },
  { x: RAIL + TABLE_W, y: RAIL + TABLE_H },
];

const HEAD_SPOT = { x: RAIL + TABLE_W * 0.25, y: RAIL + TABLE_H / 2 };
const FOOT_SPOT = { x: RAIL + TABLE_W * 0.74, y: RAIL + TABLE_H / 2 };

/* =========================================================
   Game state
   ========================================================= */
const G = {
  mode: 'menu',        // 'sandbox' | 'host' | 'guest'
  localPlayerIndex: 0, // which seat this browser controls (host=0, guest=1)
  turn: 0,
  open: true,
  colors: [null, null],   // 'red' | 'yellow' | null
  shotsOwed: [1, 1],
  freeBall: [false, false],
  balls: [],
  moving: false,
  winner: null,
  lastEvent: null,
  shotEvents: null,
};

let conn = null;   // PeerJS DataConnection
let peer = null;   // PeerJS Peer

/* =========================================================
   Rack setup
   ========================================================= */
function buildRack() {
  const colorPool = [];
  for (let i = 0; i < 7; i++) colorPool.push('red');
  for (let i = 0; i < 7; i++) colorPool.push('yellow');
  shuffle(colorPool);
  colorPool.splice(4, 0, 'black'); // 3rd row, middle slot

  const balls = [];
  balls.push({ id: 'cue', color: 'white', x: HEAD_SPOT.x, y: HEAD_SPOT.y, vx: 0, vy: 0, potted: false });

  const spacingX = BALL_R * 1.75;
  const spacingY = BALL_R * 2.02;
  let slot = 0;
  for (let row = 0; row < 5; row++) {
    const count = row + 1;
    const x = FOOT_SPOT.x + row * spacingX;
    const startY = FOOT_SPOT.y - (count - 1) * spacingY / 2;
    for (let i = 0; i < count; i++) {
      const y = startY + i * spacingY;
      balls.push({ id: 'b' + slot, color: colorPool[slot], x, y, vx: 0, vy: 0, potted: false });
      slot++;
    }
  }
  return balls;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function resetGame() {
  G.turn = 0;
  G.open = true;
  G.colors = [null, null];
  G.shotsOwed = [1, 1];
  G.freeBall = [false, false];
  G.balls = buildRack();
  G.moving = false;
  G.winner = null;
  G.lastEvent = { kind: 'break-ready' };
}

/* =========================================================
   Physics
   ========================================================= */
function cueBall() { return G.balls.find(b => b.id === 'cue'); }
function activeBalls() { return G.balls.filter(b => !b.potted); }

function stepPhysics() {
  const balls = activeBalls();
  for (const b of balls) {
    b.x += b.vx;
    b.y += b.vy;
    b.vx *= FRICTION;
    b.vy *= FRICTION;
    if (Math.hypot(b.vx, b.vy) < MIN_SPEED) { b.vx = 0; b.vy = 0; }
  }

  // pocket capture (checked before wall bounce so balls can fall in)
  for (const b of balls) {
    if (b.potted) continue;
    for (const p of POCKETS) {
      if (Math.hypot(b.x - p.x, b.y - p.y) < POCKET_R) {
        b.potted = true;
        b.vx = 0; b.vy = 0;
        b.x = -1000; b.y = -1000;
        G.shotEvents.potted.push(b.color);
        break;
      }
    }
  }

  // wall bounce
  for (const b of balls) {
    if (b.potted) continue;
    if (b.x < INNER.left) { b.x = INNER.left; b.vx = -b.vx * RESTITUTION_WALL; }
    if (b.x > INNER.right) { b.x = INNER.right; b.vx = -b.vx * RESTITUTION_WALL; }
    if (b.y < INNER.top) { b.y = INNER.top; b.vy = -b.vy * RESTITUTION_WALL; }
    if (b.y > INNER.bottom) { b.y = INNER.bottom; b.vy = -b.vy * RESTITUTION_WALL; }
  }

  // ball-ball collisions
  const live = balls.filter(b => !b.potted);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist === 0 || dist >= BALL_R * 2) continue;

      const nx = dx / dist, ny = dy / dist;
      const overlap = BALL_R * 2 - dist;
      a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
      b.x += nx * overlap / 2; b.y += ny * overlap / 2;

      if (a.id === 'cue' && G.shotEvents.firstHit === null) G.shotEvents.firstHit = b.color;
      if (b.id === 'cue' && G.shotEvents.firstHit === null) G.shotEvents.firstHit = a.color;

      const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
      const velAlongNormal = rvx * nx + rvy * ny;
      if (velAlongNormal > 0) continue;
      const impulse = -(1 + RESTITUTION_BALL) * velAlongNormal / 2;
      a.vx -= impulse * nx; a.vy -= impulse * ny;
      b.vx += impulse * nx; b.vy += impulse * ny;
    }
  }
}

function anyMoving() {
  return activeBalls().some(b => Math.hypot(b.vx, b.vy) > 0.001);
}

function respotCue() {
  const cb = cueBall();
  cb.potted = false;
  let x = HEAD_SPOT.x, y = HEAD_SPOT.y;
  let tries = 0;
  while (tries < 20 && G.balls.some(o => o.id !== 'cue' && !o.potted && Math.hypot(o.x - x, o.y - y) < BALL_R * 2.1)) {
    x -= 22; tries++;
  }
  cb.x = x; cb.y = y; cb.vx = 0; cb.vy = 0;
}

/* =========================================================
   Rules engine  (host / sandbox authoritative)
   ========================================================= */
function onBlack(idx) {
  const c = G.colors[idx];
  if (!c) return false;
  return !G.balls.some(b => b.color === c && !b.potted);
}

function evaluateShot(shooterIdx, events) {
  const opp = 1 - shooterIdx;
  const pottedBlack = events.potted.includes('black');
  const pottedWhite = events.potted.includes('white');
  const pottedRed = events.potted.filter(c => c === 'red').length;
  const pottedYellow = events.potted.filter(c => c === 'yellow').length;

  if (pottedBlack) {
    if (pottedWhite) {
      G.winner = opp;
      G.lastEvent = { kind: 'lose-black-white', shooter: shooterIdx, winner: opp };
    } else if (!onBlack(shooterIdx)) {
      G.winner = opp;
      G.lastEvent = { kind: 'lose-black-early', shooter: shooterIdx, winner: opp };
    } else {
      G.winner = shooterIdx;
      G.lastEvent = { kind: 'win-black', shooter: shooterIdx, winner: shooterIdx };
    }
    G.moving = false;
    return;
  }

  const wasOpen = G.open;
  const hadFreeBall = G.freeBall[shooterIdx];
  G.freeBall[shooterIdx] = false;

  let requiredColor = null;
  if (!wasOpen) requiredColor = onBlack(shooterIdx) ? 'black' : G.colors[shooterIdx];

  let isFoul = false;
  let foulReason = null;
  if (pottedWhite) { isFoul = true; foulReason = 'cue-ball'; }
  else if (events.firstHit === null) { isFoul = true; foulReason = 'no-contact'; }
  else if (!hadFreeBall) {
    if (wasOpen) {
      if (events.firstHit === 'black') { isFoul = true; foulReason = 'black-early'; }
    } else if (events.firstHit !== requiredColor) {
      isFoul = true; foulReason = 'wrong-ball';
    }
  }

  let assignedColor = null;
  if (wasOpen && !isFoul) {
    if (pottedRed > 0 && pottedYellow === 0) { G.colors[shooterIdx] = 'red'; G.colors[opp] = 'yellow'; G.open = false; assignedColor = 'red'; }
    else if (pottedYellow > 0 && pottedRed === 0) { G.colors[shooterIdx] = 'yellow'; G.colors[opp] = 'red'; G.open = false; assignedColor = 'yellow'; }
  }

  if (pottedWhite) respotCue();

  if (isFoul) {
    G.turn = opp;
    G.shotsOwed[opp] = 2;
    G.freeBall[opp] = true;
    G.lastEvent = { kind: 'foul', shooter: shooterIdx, reason: foulReason, next: opp };
  } else {
    const ownPotted = wasOpen ? (pottedRed + pottedYellow > 0)
      : events.potted.filter(c => c === G.colors[shooterIdx]).length > 0;
    let continueTurn = false;
    if (ownPotted) {
      continueTurn = true;
      G.shotsOwed[shooterIdx] = 1;
      G.lastEvent = assignedColor
        ? { kind: 'assigned', shooter: shooterIdx, color: assignedColor }
        : { kind: 'extra-shot', shooter: shooterIdx };
    } else if (G.shotsOwed[shooterIdx] > 1) {
      G.shotsOwed[shooterIdx] -= 1;
      continueTurn = true;
      G.lastEvent = { kind: 'owed-continue', shooter: shooterIdx };
    } else {
      G.lastEvent = { kind: 'safe', shooter: shooterIdx };
    }
    if (!continueTurn) {
      G.turn = opp;
      G.shotsOwed[opp] = 1;
    }
  }

  G.moving = false;
}

/* =========================================================
   Message formatting (perspective-aware)
   ========================================================= */
function pname(idx) {
  if (G.mode === 'sandbox') return 'Player ' + (idx + 1);
  return idx === G.localPlayerIndex ? 'You' : 'Opponent';
}
function poss(idx) {
  return idx === G.localPlayerIndex && G.mode !== 'sandbox' ? 'your' : (pname(idx) + "'s");
}

function formatMessage(ev) {
  if (!ev) return '';
  switch (ev.kind) {
    case 'break-ready': return 'Break to start the game.';
    case 'foul': {
      const reasons = {
        'cue-ball': 'potted the cue ball',
        'no-contact': "didn't hit a ball",
        'black-early': 'hit the black before colours were decided',
        'wrong-ball': 'hit the wrong colour first',
      };
      return `Foul — ${pname(ev.shooter)} ${reasons[ev.reason] || 'fouled'}. ${pname(ev.next)} gets two shots, first is a free ball.`;
    }
    case 'assigned':
      return `Table's open no more — ${pname(ev.shooter)} ${ev.shooter === G.localPlayerIndex && G.mode !== 'sandbox' ? 'are' : 'is'} on ${ev.color}s. Shoot again.`;
    case 'extra-shot':
      return `Potted a ball — ${pname(ev.shooter)} shoot${ev.shooter === G.localPlayerIndex && G.mode !== 'sandbox' ? '' : 's'} again.`;
    case 'owed-continue':
      return `${pname(ev.shooter)} still owed a shot from that foul.`;
    case 'safe':
      return 'No ball potted — turn passes.';
    case 'win-black':
      return `${pname(ev.winner)} potted the black on ${ev.winner === G.localPlayerIndex && G.mode !== 'sandbox' ? 'your' : 'their'} turn and wins!`;
    case 'lose-black-early':
      return `${pname(ev.shooter)} potted the black too early — ${pname(ev.winner)} wins!`;
    case 'lose-black-white':
      return `${pname(ev.shooter)} potted the black and the cue ball together — ${pname(ev.winner)} wins!`;
    default: return '';
  }
}

/* =========================================================
   Rendering
   ========================================================= */
const canvas = document.getElementById('table');
const ctx = canvas.getContext('2d');
canvas.width = CANVAS_W;
canvas.height = CANVAS_H;

function drawTable() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // wood rail
  const railGrad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  railGrad.addColorStop(0, '#6b4426');
  railGrad.addColorStop(1, '#3b2013');
  ctx.fillStyle = railGrad;
  roundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 14);
  ctx.fill();

  // felt
  const feltGrad = ctx.createRadialGradient(CANVAS_W / 2, CANVAS_H / 2, 40, CANVAS_W / 2, CANVAS_H / 2, CANVAS_W / 1.2);
  feltGrad.addColorStop(0, '#116b49');
  feltGrad.addColorStop(1, '#0a4630');
  ctx.fillStyle = feltGrad;
  ctx.fillRect(RAIL, RAIL, TABLE_W, TABLE_H);

  // inner rail shadow line
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(RAIL, RAIL, TABLE_W, TABLE_H);

  // pockets
  for (const p of POCKETS) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, POCKET_R, 0, Math.PI * 2);
    ctx.fillStyle = '#050302';
    ctx.fill();
    ctx.strokeStyle = '#c9a24b';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // baulk line + spot (visual flavour)
  ctx.strokeStyle = 'rgba(239,230,210,0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(HEAD_SPOT.x, RAIL + 6);
  ctx.lineTo(HEAD_SPOT.x, RAIL + TABLE_H - 6);
  ctx.stroke();
}

function drawBalls() {
  for (const b of G.balls) {
    if (b.potted) continue;
    ctx.save();
    ctx.beginPath();
    ctx.arc(b.x + 1.5, b.y + 2.5, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = ballFill(b.color);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.stroke();

    const glow = ctx.createRadialGradient(b.x - 4, b.y - 4, 1, b.x, b.y, BALL_R);
    glow.addColorStop(0, 'rgba(255,255,255,0.55)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();
  }
}

function ballFill(color) {
  if (color === 'white') return '#f4efe2';
  if (color === 'red') return '#c0392b';
  if (color === 'yellow') return '#e0b13a';
  if (color === 'black') return '#161616';
  return '#999';
}

let aiming = false;
let aimCurrent = { x: 0, y: 0 };

function drawAim() {
  if (!aiming) return;
  const cb = cueBall();
  if (!cb || cb.potted) return;
  const dx = aimCurrent.x - cb.x, dy = aimCurrent.y - cb.y;
  const pull = Math.min(Math.hypot(dx, dy), MAX_PULL);
  const dist = Math.hypot(dx, dy) || 1;
  const dirx = -dx / dist, diry = -dy / dist;

  // trajectory guide
  ctx.save();
  ctx.setLineDash([6, 7]);
  ctx.strokeStyle = 'rgba(239,230,210,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cb.x, cb.y);
  ctx.lineTo(cb.x + dirx * 260, cb.y + diry * 260);
  ctx.stroke();
  ctx.restore();

  // cue stick
  const stickBack = 18 + pull;
  ctx.save();
  ctx.strokeStyle = '#c9a24b';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cb.x - dirx * (BALL_R + 6), cb.y - diry * (BALL_R + 6));
  ctx.lineTo(cb.x - dirx * stickBack, cb.y - diry * stickBack);
  ctx.stroke();
  ctx.restore();

  const powerMeter = document.getElementById('power-meter');
  const powerFill = document.getElementById('power-fill');
  powerMeter.classList.add('show');
  powerFill.style.width = Math.round((pull / MAX_PULL) * 100) + '%';
}

function render() {
  drawTable();
  drawBalls();
  drawAim();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* =========================================================
   Simulation loop
   ========================================================= */
let simRunning = false;
let broadcastCounter = 0;

function startSimLoop() {
  if (simRunning) return;
  simRunning = true;
  const shooter = G.turn;
  requestAnimationFrame(function loop() {
    stepPhysics();
    render();
    updateHud();

    if (G.mode === 'host') {
      broadcastCounter++;
      if (broadcastCounter % 2 === 0) sendState();
    }

    if (anyMoving()) {
      requestAnimationFrame(loop);
    } else {
      simRunning = false;
      if (G.mode !== 'guest') {
        evaluateShot(shooter, G.shotEvents);
        render();
        updateHud();
        if (G.mode === 'host') sendResult();
        if (G.winner !== null) showWinner();
      }
    }
  });
}

/* =========================================================
   Shooting
   ========================================================= */
function canAim() {
  if (G.winner !== null) return false;
  if (G.moving || simRunning) return false;
  if (G.mode === 'sandbox') return true;
  return G.turn === G.localPlayerIndex;
}

function performLocalShot(dir, speed) {
  const cb = cueBall();
  cb.vx = dir.x * speed;
  cb.vy = dir.y * speed;
  G.shotEvents = { firstHit: null, potted: [] };
  G.moving = true;
  broadcastCounter = 0;
  startSimLoop();
}

function canvasPos(evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = (evt.clientX - rect.left) * scaleX;
  const cy = (evt.clientY - rect.top) * scaleY;
  return { x: cx, y: cy };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!canAim()) return;
  aiming = true;
  aimCurrent = canvasPos(e);
  render();
});
window.addEventListener('pointermove', (e) => {
  if (!aiming) return;
  aimCurrent = canvasPos(e);
  render();
});
window.addEventListener('pointerup', () => {
  if (!aiming) return;
  aiming = false;
  document.getElementById('power-meter').classList.remove('show');
  const cb = cueBall();
  const dx = aimCurrent.x - cb.x, dy = aimCurrent.y - cb.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 8) { render(); return; }
  const pull = Math.min(dist, MAX_PULL);
  const dirx = -dx / dist, diry = -dy / dist;
  const speed = (pull / MAX_PULL) * MAX_SPEED;

  if (G.mode === 'guest') {
    G.moving = true; // lock local aiming until the host reports the result
    conn && conn.send({ type: 'shoot', dx: dirx, dy: diry, speed });
  } else {
    performLocalShot({ x: dirx, y: diry }, speed);
  }
  render();
});

/* =========================================================
   HUD
   ========================================================= */
function chipHtml(idx) {
  const color = G.colors[idx];
  const dotClass = color ? color : 'open';
  const label = G.mode === 'sandbox' ? `Player ${idx + 1}` : (idx === G.localPlayerIndex ? 'You' : 'Opponent');
  const colorLabel = color ? `on ${color}` : 'open';
  return { dotClass, label, colorLabel };
}

function updateHud() {
  const p0 = chipHtml(0), p1 = chipHtml(1);
  const chip0 = document.getElementById('chip-0');
  const chip1 = document.getElementById('chip-1');
  chip0.querySelector('.chip-dot').className = 'chip-dot ' + p0.dotClass;
  chip0.querySelector('.chip-label').textContent = `${p0.label} — ${p0.colorLabel}`;
  chip1.querySelector('.chip-dot').className = 'chip-dot ' + p1.dotClass;
  chip1.querySelector('.chip-label').textContent = `${p1.label} — ${p1.colorLabel}`;
  chip0.classList.toggle('active', G.turn === 0 && G.winner === null);
  chip1.classList.toggle('active', G.turn === 1 && G.winner === null);

  const msg = document.getElementById('center-message');
  msg.textContent = formatMessage(G.lastEvent);
}

function showWinner() {
  const overlay = document.getElementById('winner-overlay');
  const text = document.getElementById('winner-text');
  const reason = document.getElementById('winner-reason');
  text.textContent = `${pname(G.winner)} win${G.winner === G.localPlayerIndex && G.mode !== 'sandbox' ? '' : 's'}!`;
  reason.textContent = formatMessage(G.lastEvent);
  overlay.classList.remove('hidden');
}
function hideWinner() {
  document.getElementById('winner-overlay').classList.add('hidden');
}

/* =========================================================
   Networking (PeerJS) — host is authoritative
   ========================================================= */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}
function roomIdFor(code) { return 'p8b-' + code; }

function serializeState() {
  return {
    turn: G.turn,
    open: G.open,
    colors: G.colors,
    shotsOwed: G.shotsOwed,
    freeBall: G.freeBall,
    winner: G.winner,
    lastEvent: G.lastEvent,
    moving: G.moving,
    balls: G.balls.map(b => ({ id: b.id, color: b.color, x: b.x, y: b.y, potted: b.potted })),
  };
}
function applyState(s) {
  G.turn = s.turn; G.open = s.open; G.colors = s.colors;
  G.shotsOwed = s.shotsOwed; G.freeBall = s.freeBall; G.winner = s.winner;
  G.lastEvent = s.lastEvent; G.balls = s.balls; G.moving = s.moving;
}

function sendState() {
  if (!conn || !conn.open) return;
  conn.send({ type: 'state', balls: G.balls.map(b => ({ x: b.x, y: b.y, potted: b.potted })) });
}
function sendResult() {
  if (!conn || !conn.open) return;
  conn.send({ type: 'result', state: serializeState() });
}
function sendInit() {
  if (!conn || !conn.open) return;
  conn.send({ type: 'init', state: serializeState() });
}

function hostReceive(data) {
  if (data.type === 'shoot') {
    if (G.turn === 1 && !G.moving && !simRunning) {
      performLocalShotFor(1, { x: data.dx, y: data.dy }, data.speed);
    }
  } else if (data.type === 'restart-request') {
    resetGame();
    updateHud(); render(); hideWinner();
    sendInit();
  }
}
function performLocalShotFor(idx, dir, speed) {
  // identical to performLocalShot, exposed for clarity when triggered remotely
  performLocalShot(dir, speed);
}

function guestReceive(data) {
  if (data.type === 'init') {
    applyState(data.state);
    updateHud(); render(); hideWinner();
    goToGameScreen();
  } else if (data.type === 'state') {
    data.balls.forEach((bd, i) => {
      G.balls[i].x = bd.x; G.balls[i].y = bd.y; G.balls[i].potted = bd.potted;
    });
    render();
  } else if (data.type === 'result') {
    applyState(data.state); // includes the authoritative G.moving = false
    updateHud(); render();
    if (G.winner !== null) showWinner();
  }
}

function teardownNetworking() {
  if (conn) { try { conn.close(); } catch (e) {} conn = null; }
  if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
}

/* =========================================================
   Screen management & menu wiring
   ========================================================= */
const screens = {
  menu: document.getElementById('menu-screen'),
  game: document.getElementById('game-screen'),
};
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}
function goToGameScreen() {
  showScreen('game');
  document.getElementById('leave-btn').classList.remove('hidden');
  render();
  updateHud();
}
function goToMenu() {
  teardownNetworking();
  simRunning = false;
  G.mode = 'menu';
  showScreen('menu');
  showMenuPane('root');
  hideWinner();
  document.getElementById('leave-btn').classList.add('hidden');
  document.getElementById('play-again-btn').classList.remove('hidden');
  document.getElementById('winner-menu-btn').classList.remove('hidden');
}

function showMenuPane(name) {
  document.querySelectorAll('.menu-pane').forEach(p => p.classList.add('hidden'));
  document.getElementById('pane-' + name).classList.remove('hidden');
}

document.getElementById('btn-play').addEventListener('click', () => {
  showMenuPane('creating');
  document.getElementById('create-status').textContent = 'Opening a table…';
  createRoom();
});
document.getElementById('btn-join').addEventListener('click', () => showMenuPane('join'));
document.getElementById('btn-sandbox').addEventListener('click', () => {
  G.mode = 'sandbox';
  G.localPlayerIndex = 0;
  resetGame();
  goToGameScreen();
});
document.querySelectorAll('.back-link').forEach(b => b.addEventListener('click', () => {
  teardownNetworking();
  showMenuPane('root');
}));
document.getElementById('btn-join-submit').addEventListener('click', () => {
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  if (code.length < 3) return;
  showMenuPane('joining');
  document.getElementById('join-status').textContent = 'Connecting…';
  joinRoom(code);
});
document.getElementById('leave-btn').addEventListener('click', goToMenu);
document.getElementById('play-again-btn').addEventListener('click', () => {
  if (G.mode === 'host') {
    resetGame();
    hideWinner(); render(); updateHud();
    sendInit();
  } else if (G.mode === 'sandbox') {
    resetGame();
    hideWinner(); render(); updateHud();
  } else if (G.mode === 'guest') {
    conn && conn.send({ type: 'restart-request' });
  }
});
document.getElementById('winner-menu-btn').addEventListener('click', goToMenu);

function createRoom(attempt = 0) {
  const code = generateCode();
  teardownNetworking();
  peer = new Peer(roomIdFor(code), { debug: 0 });

  peer.on('open', () => {
    document.getElementById('room-code-text').textContent = code;
    showMenuPane('waiting');
  });

  peer.on('connection', (c) => {
    conn = c;
    conn.on('open', () => {
      G.mode = 'host';
      G.localPlayerIndex = 0;
      resetGame();
      goToGameScreen();
      sendInit();
    });
    conn.on('data', hostReceive);
    conn.on('close', () => onOpponentLeft());
  });

  peer.on('error', (err) => {
    if (String(err.type) === 'unavailable-id' && attempt < 5) {
      createRoom(attempt + 1);
    } else {
      document.getElementById('create-status').textContent = 'Could not open a table. Check your connection and try again.';
    }
  });
}

function joinRoom(code) {
  teardownNetworking();
  peer = new Peer({ debug: 0 });
  peer.on('open', () => {
    conn = peer.connect(roomIdFor(code), { reliable: true });
    conn.on('open', () => {
      G.mode = 'guest';
      G.localPlayerIndex = 1;
    });
    conn.on('data', guestReceive);
    conn.on('close', () => onOpponentLeft());
    conn.on('error', () => {
      document.getElementById('join-status').textContent = "Couldn't connect — check the code and try again.";
    });

    setTimeout(() => {
      if (G.mode !== 'guest') {
        document.getElementById('join-status').textContent = "Couldn't find that table — check the code and try again.";
      }
    }, 8000);
  });
  peer.on('error', () => {
    document.getElementById('join-status').textContent = 'Connection error. Check your internet connection and try again.';
  });
}

function onOpponentLeft() {
  if (screens.game.classList.contains('hidden')) return;
  const msg = document.getElementById('center-message');
  msg.textContent = 'Opponent left the table.';
  document.getElementById('winner-overlay').classList.remove('hidden');
  document.getElementById('winner-text').textContent = 'Opponent disconnected';
  document.getElementById('winner-reason').textContent = 'Head back to the menu to start a new game.';
  document.getElementById('play-again-btn').classList.add('hidden');
}

/* boot */
showMenuPane('root');
