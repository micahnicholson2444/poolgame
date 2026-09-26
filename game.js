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
const POCKET_CAPTURE_R = 21;
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
  activeSpin: { x: 0, y: 0 },
  shotDirection: { x: 1, y: 0 },
};

let selectedSpin = { x: 0, y: 0 };
let conn = null;   // PeerJS DataConnection
let peer = null;   // PeerJS Peer

let audioContext = null;
let soundEnabled = true;
let lastImpactSound = 0;
function playSound(kind, strength = 1) {
  if (G.mode === 'host' && conn && conn.open) conn.send({ type: 'sound', kind, strength });
  if (!soundEnabled) return;
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    if (!audioContext) audioContext = new AudioCtor();
    if (audioContext.state === 'suspended') audioContext.resume();
    const now = audioContext.currentTime, osc = audioContext.createOscillator(), gain = audioContext.createGain();
    const scale = Math.max(0.2, Math.min(1, strength / 9));
    const cfg = kind === 'pocket' ? [115, 'sine', 0.14] : kind === 'rail' ? [210, 'triangle', 0.05] : kind === 'cue' ? [155, 'sine', 0.07] : [340, 'triangle', 0.045];
    osc.type = cfg[1]; osc.frequency.setValueAtTime(cfg[0] * (0.75 + scale * 0.5), now);
    osc.frequency.exponentialRampToValueAtTime(cfg[0] * 0.48, now + cfg[2]);
    gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime((kind === 'pocket' ? 0.07 : 0.035) * scale, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + cfg[2]);
    osc.connect(gain); gain.connect(audioContext.destination); osc.start(now); osc.stop(now + cfg[2] + 0.01);
  } catch (_) { /* Sound is optional; gameplay continues if unavailable. */ }
}
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

function playImpactSound(kind, speed) {
  const now = performance.now();
  if (speed > 1.8 && now - lastImpactSound > 65) { lastImpactSound = now; playSound(kind, speed); }
}
function stepPhysics() {
  G.balls.forEach(advancePocketDrop);
  const balls = activeBalls();

  // Sub-step the motion so fast balls can't tunnel past the exact contact
  // point before a collision is detected — that overshoot was throwing off
  // both the simulated bounce and the predicted aim line.
  const topSpeed = balls.reduce((m, b) => Math.max(m, Math.hypot(b.vx, b.vy)), 0);
  const subSteps = Math.min(10, Math.max(1, Math.ceil(topSpeed / 2)));

  for (let s = 0; s < subSteps; s++) {
    for (const b of balls) {
      if (b.potted) continue;
      b.x += b.vx / subSteps;
      b.y += b.vy / subSteps;
    }

    // pocket capture (checked before wall bounce so balls can fall in)
    for (const b of balls) {
      if (b.potted) continue;
      for (const p of POCKETS) {
        if (Math.hypot(b.x - p.x, b.y - p.y) < POCKET_CAPTURE_R) {
          const speed = Math.hypot(b.vx, b.vy);
          b.potted = true;
          b.pocketing = { x: p.x, y: p.y, startX: b.x, startY: b.y, frame: 0, delay: speed < 2.1 ? 14 : 3, duration: 22, wobble: Math.random() * Math.PI * 2 };
          b.vx = 0; b.vy = 0;
          G.shotEvents.potted.push(b.color);
          playSound('pocket', speed);
          break;
        }
      }
    }

    // Wall bounce.
    for (const b of balls) {
      if (b.potted) continue;
      if (b.x < INNER.left) { b.x = INNER.left; b.vx = -b.vx * RESTITUTION_WALL; if (b.id === 'cue') b.vy += Math.abs(b.vx) * G.activeSpin.x * 0.1; playImpactSound('rail', Math.abs(b.vx)); }
      if (b.x > INNER.right) { b.x = INNER.right; b.vx = -b.vx * RESTITUTION_WALL; if (b.id === 'cue') b.vy -= Math.abs(b.vx) * G.activeSpin.x * 0.1; playImpactSound('rail', Math.abs(b.vx)); }
      if (b.y < INNER.top) { b.y = INNER.top; b.vy = -b.vy * RESTITUTION_WALL; if (b.id === 'cue') b.vx -= Math.abs(b.vy) * G.activeSpin.x * 0.1; playImpactSound('rail', Math.abs(b.vy)); }
      if (b.y > INNER.bottom) { b.y = INNER.bottom; b.vy = -b.vy * RESTITUTION_WALL; if (b.id === 'cue') b.vx += Math.abs(b.vy) * G.activeSpin.x * 0.1; playImpactSound('rail', Math.abs(b.vy)); }
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
        const impactSpeed = Math.abs(velAlongNormal);
        playImpactSound('ball', impactSpeed);
        const impulse = -(1 + RESTITUTION_BALL) * velAlongNormal / 2;
        a.vx -= impulse * nx; a.vy -= impulse * ny;
        b.vx += impulse * nx; b.vy += impulse * ny;
        const cue = a.id === 'cue' ? a : (b.id === 'cue' ? b : null);
        const object = cue === a ? b : a;
        if (cue) {
          const spin = G.activeSpin, impact = Math.abs(velAlongNormal);
          cue.vx += (-G.shotDirection.x * spin.y - G.shotDirection.y * spin.x) * impact * 0.3;
          cue.vy += (-G.shotDirection.y * spin.y + G.shotDirection.x * spin.x) * impact * 0.3;
          object.vx += ny * spin.x * impact * 0.06;
          object.vy -= nx * spin.x * impact * 0.06;
        }
      }
    }
  }

  // friction and the stop threshold apply once per full frame, not per sub-step
  for (const b of balls) {
    if (b.potted) continue;
    b.rollAngle = (b.rollAngle || 0) + Math.hypot(b.vx, b.vy) / BALL_R;
    b.vx *= FRICTION;
    b.vy *= FRICTION;
    if (Math.hypot(b.vx, b.vy) < MIN_SPEED) { b.vx = 0; b.vy = 0; }
  }
}

function advancePocketDrop(ball) {
  if (!ball.pocketing) return;
  const a = ball.pocketing; a.frame++;
  if (a.frame <= a.delay) {
    const wobble = Math.sin(a.frame * 1.5 + a.wobble) * 1.4;
    ball.x = a.startX + wobble; ball.y = a.startY + Math.cos(a.frame * 1.5 + a.wobble) * 0.8;
    return;
  }
  const t = Math.min(1, (a.frame - a.delay) / a.duration), ease = t * t * (3 - 2 * t);
  ball.x = a.startX + (a.x - a.startX) * ease; ball.y = a.startY + (a.y - a.startY) * ease;
  if (t >= 1) { ball.pocketing = null; ball.x = -1000; ball.y = -1000; }
}
function anyMoving() {
  return activeBalls().some(b => Math.hypot(b.vx, b.vy) > 0.001) || G.balls.some(b => !!b.pocketing);
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

  // Pockets
  for (const p of POCKETS) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, POCKET_R, 0, Math.PI * 2);
    ctx.fillStyle = '#050302';
    ctx.fill();
    ctx.strokeStyle = '#c9a24b';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Highlight the legal cue-ball placement area during a free ball.
  if (typeof canPlaceCue === 'function' && canPlaceCue()) {
    ctx.fillStyle = 'rgba(230,200,119,0.08)';
    ctx.fillRect(RAIL, RAIL, HEAD_SPOT.x - RAIL, TABLE_H);
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
    if (b.potted && !b.pocketing) continue;
    const speed = Math.hypot(b.vx, b.vy);
    let scale = 1, alpha = 1;
    if (b.pocketing) {
      const t = Math.max(0, (b.pocketing.frame - b.pocketing.delay) / b.pocketing.duration);
      scale = 1 - Math.min(0.86, t * 0.86); alpha = 1 - Math.min(0.35, t * 0.35);
    }
    if (speed > 2 && !b.pocketing) {
      ctx.save(); ctx.globalAlpha = Math.min(0.18, speed / 75); ctx.strokeStyle = ballFill(b.color); ctx.lineWidth = BALL_R * 0.85; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(b.x - b.vx * 1.5, b.y - b.vy * 1.5); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.restore();
    }
    ctx.save(); ctx.globalAlpha = alpha; ctx.translate(b.x, b.y); ctx.rotate(b.rollAngle || 0); ctx.scale(scale, scale);
    ctx.beginPath(); ctx.arc(1.5, 2.5, BALL_R, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, BALL_R, 0, Math.PI * 2); ctx.fillStyle = ballFill(b.color); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.stroke();
    const glow = ctx.createRadialGradient(-4, -4, 1, 0, 0, BALL_R);
    glow.addColorStop(0, 'rgba(255,255,255,0.62)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath(); ctx.arc(0, 0, BALL_R, 0, Math.PI * 2); ctx.fillStyle = glow; ctx.fill(); ctx.restore();
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
const touchControls = matchMedia('(pointer: coarse)').matches;
let mobileAimDir = null;
let mobilePowerStartY = 0;
let mobilePowerPull = 0;
let mobilePowerDragging = false;

/* Ray from (ox,oy) in direction (dx,dy) — find the first object ball the
   cue ball's centre would touch, and the point of contact (ghost-ball
   position), using the standard ray/circle test against a circle of
   radius 2*BALL_R (since we're tracking the travelling centre, not edge). */
function raycastFirstBall(ox, oy, dx, dy) {
  let best = null;
  for (const b of G.balls) {
    if (b.potted || b.id === 'cue') continue;
    const ocx = ox - b.x, ocy = oy - b.y;
    const bcoef = 2 * (ocx * dx + ocy * dy);
    const c = ocx * ocx + ocy * ocy - (2 * BALL_R) * (2 * BALL_R);
    const disc = bcoef * bcoef - 4 * c;
    if (disc < 0) continue;
    const t = (-bcoef - Math.sqrt(disc)) / 2;
    if (t < 0) continue;
    if (!best || t < best.t) best = { t, ball: b };
  }
  if (!best) return null;
  const gx = ox + dx * best.t, gy = oy + dy * best.t;
  let nx = best.ball.x - gx, ny = best.ball.y - gy;
  const nlen = Math.hypot(nx, ny) || 1;
  nx /= nlen; ny /= nlen;
  return { ball: best.ball, ghostX: gx, ghostY: gy, nx, ny };
}

/* Where the aim ray would cross the inner rail, and which side it hit
   (needed so we know which velocity component to flip for the bounce). */
function raycastWall(ox, oy, dx, dy) {
  let best = null;
  if (dx > 0) best = pickWall(best, (INNER.right - ox) / dx, 'v');
  if (dx < 0) best = pickWall(best, (INNER.left - ox) / dx, 'v');
  if (dy > 0) best = pickWall(best, (INNER.bottom - oy) / dy, 'h');
  if (dy < 0) best = pickWall(best, (INNER.top - oy) / dy, 'h');
  if (!best) return null;
  return { t: best.t, side: best.side, x: ox + dx * best.t, y: oy + dy * best.t };
}
function pickWall(best, t, side) {
  if (!isFinite(t) || t < 0) return best;
  if (!best || t < best.t) return { t, side };
  return best;
}

const AIM_GUIDE_LENGTH = 420;
const AIM_MAX_BOUNCES = 3;

/* Traces the cue ball's guide line out to a fixed total length, bending
   it off any cushion it meets along the way, and stopping early — with
   the ball it would strike — if one is in the path. */
function traceGuidePath(ox, oy, dirx, diry) {
  const segments = [];
  let x = ox, y = oy, dx = dirx, dy = diry;
  let remaining = AIM_GUIDE_LENGTH;
  let ballHit = null;

  for (let bounce = 0; bounce <= AIM_MAX_BOUNCES; bounce++) {
    const ball = raycastFirstBall(x, y, dx, dy);
    const ballT = ball ? Math.hypot(ball.ghostX - x, ball.ghostY - y) : Infinity;
    const wall = raycastWall(x, y, dx, dy);
    const wallT = wall ? wall.t : Infinity;

    if (ballT <= remaining && ballT <= wallT) {
      segments.push({ x1: x, y1: y, x2: ball.ghostX, y2: ball.ghostY });
      ballHit = { ...ball, dirx: dx, diry: dy };
      break;
    }
    if (wallT <= remaining) {
      segments.push({ x1: x, y1: y, x2: wall.x, y2: wall.y });
      remaining -= wallT;
      x = wall.x; y = wall.y;
      if (wall.side === 'v') dx = -dx; else dy = -dy;
      continue;
    }
    segments.push({ x1: x, y1: y, x2: x + dx * remaining, y2: y + dy * remaining });
    break;
  }
  return { segments, ballHit };
}

function drawAim() {
  if (!aiming && !(touchControls && mobileAimDir)) return;
  const cb = cueBall();
  if (!cb || cb.potted) return;
  const dx = aimCurrent.x - cb.x, dy = aimCurrent.y - cb.y;
  const dist = Math.hypot(dx, dy) || 1;
  const pull = touchControls ? mobilePowerPull : Math.min(dist, MAX_PULL);
  const dirx = touchControls && mobileAimDir ? mobileAimDir.x : -dx / dist;
  const diry = touchControls && mobileAimDir ? mobileAimDir.y : -dy / dist;

  const { segments, ballHit: hit } = traceGuidePath(cb.x, cb.y, dirx, diry);

  // dashed guide: cue ball's path, bending off any cushions it meets,
  // stopping at the first ball it would strike
  ctx.save();
  ctx.setLineDash([6, 7]);
  ctx.strokeStyle = 'rgba(239,230,210,0.6)';
  ctx.lineWidth = 2;
  for (const seg of segments) {
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.stroke();
  }
  ctx.restore();

  if (hit) {
    // faint ghost-ball outline showing where the cue ball meets the target
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(hit.ghostX, hit.ghostY, BALL_R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    const lineLen = 70 + pull * 0.3;

    // predicted path of the object ball, straight along the line of centres
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hit.ball.x, hit.ball.y);
    ctx.lineTo(hit.ball.x + hit.nx * lineLen, hit.ball.y + hit.ny * lineLen);
    ctx.stroke();
    ctx.restore();

    // predicted deflection of the cue ball (the component of its travel
    // that isn't transferred into the object ball on contact)
    const vn = hit.dirx * hit.nx + hit.diry * hit.ny;
    const tx = hit.dirx - hit.nx * vn, ty = hit.diry - hit.ny * vn;
    const tlen = Math.hypot(tx, ty);
    if (tlen > 0.12) {
      const ux = tx / tlen, uy = ty / tlen;
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(205,222,255,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hit.ghostX, hit.ghostY);
      ctx.lineTo(hit.ghostX + ux * lineLen * 0.75, hit.ghostY + uy * lineLen * 0.75);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawCueStick(cb, dirx, diry, pull);

  const powerMeter = document.getElementById('power-meter');
  const powerFill = document.getElementById('power-fill');
  powerMeter.classList.add('show');
  powerFill.style.width = Math.round((pull / MAX_PULL) * 100) + '%';
}

/* A tapered wooden cue: cream ferrule + chalked tip at the front, a
   walnut-to-maple gradient shaft, and a brass joint ring near the butt.
   It pulls back further from the ball as power builds. */
function drawCueStick(cb, dirx, diry, pull) {
  const perpx = -diry, perpy = dirx;
  const tipGap = BALL_R + 5;
  const shaftLen = 210 + pull * 1.1;
  const tipX = cb.x - dirx * tipGap, tipY = cb.y - diry * tipGap;
  const buttX = cb.x - dirx * (tipGap + shaftLen), buttY = cb.y - diry * (tipGap + shaftLen);
  const tipW = 3, buttW = 9.5;

  // soft drop shadow on the felt
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = buttW + 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(tipX + 2, tipY + 3);
  ctx.lineTo(buttX + 2, buttY + 3);
  ctx.stroke();
  ctx.restore();

  // tapered shaft
  const grad = ctx.createLinearGradient(tipX, tipY, buttX, buttY);
  grad.addColorStop(0, '#efe6d2');
  grad.addColorStop(0.14, '#d8b579');
  grad.addColorStop(0.55, '#8a5a34');
  grad.addColorStop(1, '#3b2013');
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tipX + perpx * tipW / 2, tipY + perpy * tipW / 2);
  ctx.lineTo(buttX + perpx * buttW / 2, buttY + perpy * buttW / 2);
  ctx.lineTo(buttX - perpx * buttW / 2, buttY - perpy * buttW / 2);
  ctx.lineTo(tipX - perpx * tipW / 2, tipY - perpy * tipW / 2);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // cream ferrule just behind the tip
  const ferruleX = cb.x - dirx * (tipGap + 9), ferruleY = cb.y - diry * (tipGap + 9);
  ctx.save();
  ctx.strokeStyle = '#f4efe2';
  ctx.lineWidth = tipW + 1.5;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(ferruleX, ferruleY);
  ctx.stroke();
  ctx.restore();

  // chalked leather tip
  ctx.save();
  ctx.fillStyle = '#6f89a8';
  ctx.beginPath();
  ctx.arc(tipX, tipY, tipW / 2 + 0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // brass joint ring, purely decorative
  const ringX = tipX + (buttX - tipX) * 0.82, ringY = tipY + (buttY - tipY) * 0.82;
  ctx.save();
  ctx.strokeStyle = '#c9a24b';
  ctx.lineWidth = buttW * 0.9;
  ctx.beginPath();
  ctx.moveTo(ringX - dirx * 3, ringY - diry * 3);
  ctx.lineTo(ringX + dirx * 3, ringY + diry * 3);
  ctx.stroke();
  ctx.restore();
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

function performLocalShot(dir, speed, spin = selectedSpin) {
  playSound('cue', speed);
  G.activeSpin = { x: spin.x || 0, y: spin.y || 0 };
  G.shotDirection = { x: dir.x, y: dir.y };
  const cb = cueBall();
  cb.vx = dir.x * speed;
  cb.vy = dir.y * speed;
  G.shotEvents = { firstHit: null, potted: [] };
  G.moving = true;
  broadcastCounter = 0;
  startSimLoop();
}

function canPlaceCue() {
  return canAim() && G.freeBall[G.localPlayerIndex];
}
function validCuePlacement(x, y) {
  if (x < INNER.left || x > HEAD_SPOT.x || y < INNER.top || y > INNER.bottom) return false;
  if (POCKETS.some(p => Math.hypot(x - p.x, y - p.y) < POCKET_R + BALL_R)) return false;
  return !G.balls.some(b => b.id !== 'cue' && !b.potted && Math.hypot(x - b.x, y - b.y) < BALL_R * 2 + 1);
}
function placeCueBall(x, y) {
  if (!validCuePlacement(x, y)) return false;
  const cb = cueBall(); cb.x = x; cb.y = y; cb.potted = false; cb.vx = 0; cb.vy = 0; return true;
}
let cuePlacementDragging = false;
function canvasPos(evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = (evt.clientX - rect.left) * scaleX;
  const cy = (evt.clientY - rect.top) * scaleY;
  return { x: cx, y: cy };
}

function shootWithPower(dirx, diry, pull) {
  const speed = (Math.min(pull, MAX_PULL) / MAX_PULL) * MAX_SPEED;
  if (G.mode === 'guest') { const cb = cueBall(), placement = canPlaceCue(); G.moving = true; conn && conn.send({ type: 'shoot', dx: dirx, dy: diry, speed, spin: selectedSpin, cueX: placement ? cb.x : undefined, cueY: placement ? cb.y : undefined }); }
  else performLocalShot({ x: dirx, y: diry }, speed, selectedSpin);
  mobileAimDir = null; mobilePowerPull = 0; render();
}
canvas.addEventListener('pointerdown', (e) => {
  if (canPlaceCue()) {
    e.preventDefault(); canvas.setPointerCapture(e.pointerId); cuePlacementDragging = true;
    const pos = canvasPos(e); placeCueBall(pos.x, pos.y); render(); return;
  }
  if (!canAim()) return;
  if (touchControls) { canvas.setPointerCapture(e.pointerId); aiming = true; aimCurrent = canvasPos(e); return; }
  aiming = true; aimCurrent = canvasPos(e); render();
});
window.addEventListener('pointermove', (e) => {
  if (cuePlacementDragging) {
    const pos = canvasPos(e); placeCueBall(pos.x, pos.y); render(); return;
  }
  if (mobilePowerDragging) {
    mobilePowerPull = Math.max(0, Math.min(MAX_PULL, (e.clientY - mobilePowerStartY) * 2.6));
    document.getElementById('mobile-cue').style.top = `${4 + mobilePowerPull / MAX_PULL * 62}%`;
    document.getElementById('cue-power').setAttribute('aria-valuenow', String(Math.round(mobilePowerPull / MAX_PULL * 100)));
    render(); return;
  }
  if (!aiming) return;
  aimCurrent = canvasPos(e);
  if (touchControls) { const cb = cueBall(); const dx = cb.x - aimCurrent.x, dy = cb.y - aimCurrent.y, d = Math.hypot(dx, dy) || 1; mobileAimDir = { x: dx / d, y: dy / d }; }
  render();
});
window.addEventListener('pointerup', () => {
  if (cuePlacementDragging) { cuePlacementDragging = false; render(); return; }
  if (mobilePowerDragging) {
    mobilePowerDragging = false; document.getElementById('mobile-shot').classList.remove('active');
    if (canAim() && mobileAimDir && mobilePowerPull >= 5) shootWithPower(mobileAimDir.x, mobileAimDir.y, mobilePowerPull);
    mobilePowerPull = 0; document.getElementById('mobile-cue').style.top = '4px'; document.getElementById('cue-power').setAttribute('aria-valuenow', '0'); render(); return;
  }
  if (!aiming) return;
  aiming = false;
  if (touchControls) { const cb = cueBall(); const dx = cb.x - aimCurrent.x, dy = cb.y - aimCurrent.y, d = Math.hypot(dx, dy); if (d > 5) mobileAimDir = { x: dx / d, y: dy / d }; render(); return; }
  document.getElementById('power-meter').classList.remove('show');
  const cb = cueBall(); const dx = aimCurrent.x - cb.x, dy = aimCurrent.y - cb.y, dist = Math.hypot(dx, dy);
  if (dist < 8) { render(); return; }
  shootWithPower(-dx / dist, -dy / dist, Math.min(dist, MAX_PULL));
});
document.getElementById('cue-power').addEventListener('pointerdown', (e) => {
  if (!touchControls || !canAim() || !mobileAimDir) return;
  e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); mobilePowerDragging = true; mobilePowerStartY = e.clientY;
  document.getElementById('mobile-shot').classList.add('active');
});
const spinOverlay = document.getElementById('spin-overlay');
const spinPicker = document.getElementById('spin-ball-picker');
const spinDot = document.getElementById('spin-dot');
let spinDragging = false;
function updateSpinDot() {
  const left = `${(0.5 + selectedSpin.x * 0.42) * 100}%`, top = `${(0.5 + selectedSpin.y * 0.42) * 100}%`;
  spinDot.style.left = left; spinDot.style.top = top;
  const miniDot = document.querySelector('.spin-ball-icon i'); miniDot.style.left = left; miniDot.style.top = top;
  spinPicker.setAttribute('aria-valuenow', `${Math.round(selectedSpin.x * 100)},${Math.round(selectedSpin.y * 100)}`);
}
function setSpinFromPointer(e) {
  const rect = spinPicker.getBoundingClientRect();
  let x = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2 - 12);
  let y = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2 - 12);
  const length = Math.hypot(x, y); if (length > 0.88) { x *= 0.88 / length; y *= 0.88 / length; }
  selectedSpin = { x, y }; updateSpinDot();
}
document.getElementById('spin-open').addEventListener('click', () => { updateSpinDot(); spinOverlay.classList.remove('hidden'); });
document.getElementById('spin-done').addEventListener('click', () => spinOverlay.classList.add('hidden'));
spinOverlay.addEventListener('click', (e) => { if (e.target === spinOverlay) spinOverlay.classList.add('hidden'); });
spinPicker.addEventListener('pointerdown', (e) => { spinDragging = true; spinPicker.setPointerCapture(e.pointerId); setSpinFromPointer(e); });
spinPicker.addEventListener('pointermove', (e) => { if (spinDragging) setSpinFromPointer(e); });
spinPicker.addEventListener('pointerup', () => { spinDragging = false; });
spinPicker.addEventListener('pointercancel', () => { spinDragging = false; });
spinPicker.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 0.2 : 0.06;
  if (e.key === 'ArrowLeft') selectedSpin.x -= step; else if (e.key === 'ArrowRight') selectedSpin.x += step;
  else if (e.key === 'ArrowUp') selectedSpin.y -= step; else if (e.key === 'ArrowDown') selectedSpin.y += step; else return;
  e.preventDefault(); const length = Math.hypot(selectedSpin.x, selectedSpin.y);
  if (length > 0.88) { selectedSpin.x *= 0.88 / length; selectedSpin.y *= 0.88 / length; } updateSpinDot();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') spinOverlay.classList.add('hidden'); });
updateSpinDot();
const soundToggle = document.getElementById('sound-toggle');
soundToggle.addEventListener('click', () => { soundEnabled = !soundEnabled; soundToggle.textContent = 'Sound: ' + (soundEnabled ? 'on' : 'off'); soundToggle.setAttribute('aria-pressed', String(soundEnabled)); if (soundEnabled) playSound('rail', 3); });
document.addEventListener('pointerdown', () => { if (!audioContext) { const AudioCtor = window.AudioContext || window.webkitAudioContext; if (AudioCtor) audioContext = new AudioCtor(); } }, { once: true, capture: true });
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
  msg.textContent = canPlaceCue() ? 'Free ball — place the cue ball behind the line.' : formatMessage(G.lastEvent);
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
  conn.send({ type: 'state', balls: G.balls.map(b => ({ x: b.x, y: b.y, potted: b.potted, pocketing: b.pocketing || null })) });
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
      if (G.freeBall[1] && Number.isFinite(data.cueX) && Number.isFinite(data.cueY)) placeCueBall(data.cueX, data.cueY);
      performLocalShotFor(1, { x: data.dx, y: data.dy }, data.speed, data.spin);
    }
  } else if (data.type === 'restart-request') {
    resetGame();
    updateHud(); render(); hideWinner();
    sendInit();
  }
}
function performLocalShotFor(idx, dir, speed, spin) {
  // identical to performLocalShot, exposed for clarity when triggered remotely
  performLocalShot(dir, speed, spin || { x: 0, y: 0 });
}

function guestReceive(data) {
  if (data.type === 'sound') { playSound(data.kind, data.strength);
  } else if (data.type === 'init') {
    applyState(data.state);
    updateHud(); render(); hideWinner();
    goToGameScreen();
  } else if (data.type === 'state') {
    data.balls.forEach((bd, i) => {
      G.balls[i].x = bd.x; G.balls[i].y = bd.y; G.balls[i].potted = bd.potted; G.balls[i].pocketing = bd.pocketing || null;
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
