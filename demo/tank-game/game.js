(() => {
  'use strict';

  // ---- 画布与常量 ------------------------------------------------------------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  const GRID_W = 15;
  const GRID_H = 13;
  const TILE = 32;
  const TANK = 30;
  const BULLET = 6;

  const PLAYER_SPEED = 96;
  const ENEMY_SPEED = 40;
  const BULLET_SPEED = 160;
  const FIRE_COOLDOWN = 0.38;
  const INVULN_TIME = 2.0;
  const MAX_LIVES = 3;
  const SCORE_PER_KILL = 100;
  const SPAWN_INTERVAL = 1.9;
  const MAX_ALIVE = 5;
  const ENEMY_FIRE_CHANCE = 0.9;
  const ENEMY_FIRE_COOLDOWN = 0.8;

  const UP = 0, DOWN = 1, LEFT = 2, RIGHT = 3;
  const DIR_VEC = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];
  const KEYS_PLAYER = {
    ArrowUp: UP, ArrowDown: DOWN, ArrowLeft: LEFT, ArrowRight: RIGHT,
    w: UP, s: DOWN, a: LEFT, d: RIGHT,
    W: UP, S: DOWN, A: LEFT, D: RIGHT,
  };

  // ---- 墙体布局 ---------------------------------------------------------------
  const WALL_BLOCKS = [
    { c: 2, r: 2, w: 2, h: 1 },
    { c: 11, r: 2, w: 2, h: 1 },
    { c: 7, r: 3, w: 1, h: 2 },
    { c: 0, r: 4, w: 1, h: 2 },
    { c: 14, r: 4, w: 1, h: 2 },
    { c: 6, r: 6, w: 3, h: 1 },
    { c: 3, r: 8, w: 2, h: 1 },
    { c: 10, r: 8, w: 2, h: 1 },
    { c: 1, r: 9, w: 1, h: 2 },
    { c: 13, r: 9, w: 1, h: 2 },
  ];

  function buildWalls() {
    const grid = Array.from({ length: GRID_H }, () => Array(GRID_W).fill(false));
    for (const b of WALL_BLOCKS) {
      for (let r = b.r; r < b.r + b.h; r += 1) {
        for (let c = b.c; c < b.c + b.w; c += 1) {
          grid[r][c] = true;
        }
      }
    }
    return grid;
  }

  const walls = buildWalls();

  // ---- 碰撞检测工具 -----------------------------------------------------------
  function rectsOverlap(a, b) {
    return a.x < b.x + b.size && a.x + a.size > b.x &&
           a.y < b.y + b.size && a.y + a.size > b.y;
  }

  function hitsWall(x, y, size) {
    const left = Math.floor(x / TILE);
    const right = Math.floor((x + size - 1) / TILE);
    const top = Math.floor(y / TILE);
    const bottom = Math.floor((y + size - 1) / TILE);
    for (let r = top; r <= bottom; r += 1) {
      for (let c = left; c <= right; c += 1) {
        if (r < 0 || r >= GRID_H || c < 0 || c >= GRID_W) return true;
        if (walls[r][c]) return true;
      }
    }
    return false;
  }

  function moveAxis(x, y, dx, dy, size) {
    let nx = x, ny = y;
    if (dx !== 0 && !hitsWall(x + dx, y, size)) nx = x + dx;
    if (dy !== 0 && !hitsWall(x, y + dy, size)) ny = y + dy;
    return { x: nx, y: ny };
  }

  // ---- 实体创建 ---------------------------------------------------------------
  const PLAYER_SPAWN = { x: GRID_W / 2 * TILE - TANK / 2, y: (GRID_H * TILE) - TILE - 6 };

  function makePlayer() {
    return { x: PLAYER_SPAWN.x, y: PLAYER_SPAWN.y, dir: UP, size: TANK, team: 'player' };
  }

  function makeBullet(owner) {
    const vec = DIR_VEC[owner.dir];
    return {
      x: owner.x + TANK / 2 - BULLET / 2 + vec[0] * TANK / 2,
      y: owner.y + TANK / 2 - BULLET / 2 + vec[1] * TANK / 2,
      dir: owner.dir,
      size: BULLET,
      team: owner.team,
    };
  }

  function makeEnemy(col) {
    return {
      x: col * TILE + TILE / 2 - TANK / 2,
      y: TILE / 2 - TANK / 2 + 14,
      dir: DOWN,
      size: TANK,
      team: 'enemy',
      fireTimer: ENEMY_FIRE_COOLDOWN,
      strafeTimer: 0,
    };
  }

  function emptyEnemyCol(existing) {
    const occupied = new Set(existing.map((e) => Math.floor((e.x + TANK / 2) / TILE)));
    const open = [];
    for (let c = 1; c < GRID_W - 1; c += 1) {
      if (!occupied.has(c) && !walls[0][c]) open.push(c);
    }
    return open.length ? open[Math.floor(Math.random() * open.length)] : 1;
  }

  // ---- 初始状态 ---------------------------------------------------------------
  function initialState() {
    return {
      status: 'playing',
      player: makePlayer(),
      enemies: [],
      bullets: [],
      keys: {},
      score: 0,
      lives: MAX_LIVES,
      invuln: 0,
      fireCooldown: 0,
      spawnAt: 1.2,
    };
  }

  // ---- 更新：玩家 -------------------------------------------------------------
  function updatePlayer(player, keys, dt) {
    const dir = Object.keys(KEYS_PLAYER)
      .filter((k) => keys[k])
      .map((k) => KEYS_PLAYER[k])[0];
    const vec = dir === undefined ? [0, 0] : DIR_VEC[dir];
    const moved = moveAxis(
      player.x, player.y,
      vec[0] * PLAYER_SPEED * dt, vec[1] * PLAYER_SPEED * dt, player.size,
    );
    return {
      x: moved.x, y: moved.y,
      dir: dir === undefined ? player.dir : dir,
      size: player.size,
      team: 'player',
    };
  }

  // ---- 更新：敌人 -------------------------------------------------------------
  function updateEnemies(enemies, player, dt) {
    return enemies.map((e) => {
      const px = e.x + e.size / 2;
      const pcx = player.x + player.size / 2;
      const sameCol = Math.abs(pcx - px) < 3;

      let dx = 0;
      let dy = ENEMY_SPEED * dt;
      if (sameCol) {
        dy = ENEMY_SPEED * 1.5 * dt;
      } else {
        dx = (pcx > px ? 1 : -1) * ENEMY_SPEED * dt;
      }
      let strafeTimer = e.strafeTimer - dt;
      if (strafeTimer <= 0) {
        strafeTimer = 0.6 + Math.random() * 1.4;
        dx = 0;
      }
      const moved = moveAxis(e.x, e.y, dx, dy, e.size);
      return {
        x: moved.x, y: moved.y,
        dir: DOWN, size: e.size, team: 'enemy',
        fireTimer: e.fireTimer - dt, strafeTimer,
      };
    });
  }

  // 敌人开火：向下射击
  function enemyFire(enemies, bullets, dt) {
    let next = bullets;
    const nextEnemies = enemies.map((e) => {
      if (e.fireTimer > 0) return e;
      if (Math.random() > ENEMY_FIRE_CHANCE * dt) return e;
      next = next.concat([{ ...makeBullet(e), y: e.y + e.size - BULLET / 2, dir: DOWN }]);
      return { ...e, fireTimer: ENEMY_FIRE_COOLDOWN };
    });
    return { enemies: nextEnemies, bullets: next };
  }

  function updateBullets(bullets, dt) {
    return bullets.reduce((acc, b) => {
      const vec = DIR_VEC[b.dir];
      const nx = b.x + vec[0] * BULLET_SPEED * dt;
      const ny = b.y + vec[1] * BULLET_SPEED * dt;
      const out = nx < -BULLET || nx > GRID_W * TILE || ny < -BULLET || ny > GRID_H * TILE;
      const hit = hitsWall(nx, ny, b.size);
      if (out || hit) return acc;
      acc.push({ x: nx, y: ny, dir: b.dir, size: b.size, team: b.team });
      return acc;
    }, []);
  }

  // ---- 命中判定（不可变更新） -------------------------------------------------
  function resolveHits(st) {
    let enemies = st.enemies;
    let bullets = st.bullets;
    let score = st.score;
    let hitPlayer = false;

    const keptPlayerBullets = [];
    for (const b of bullets.filter((x) => x.team === 'player')) {
      const hitIndex = enemies.findIndex((e) => rectsOverlap(e, b));
      if (hitIndex >= 0) {
        enemies = enemies.filter((_, i) => i !== hitIndex);
        score += SCORE_PER_KILL;
        continue;
      }
      keptPlayerBullets.push(b);
    }

    const keptEnemyBullets = [];
    for (const b of bullets.filter((x) => x.team === 'enemy')) {
      if (rectsOverlap(st.player, b) && st.invuln <= 0) {
        hitPlayer = true;
        continue;
      }
      keptEnemyBullets.push(b);
    }

    bullets = keptPlayerBullets.concat(keptEnemyBullets);
    return { enemies, bullets, score, hitPlayer };
  }

  // ---- 生成新状态 -------------------------------------------------------------
  function tick(state, dt) {
    if (state.status !== 'playing') return state;
    dt = Math.min(dt, 0.05);

    const player = updatePlayer(state.player, state.keys, dt);

    let enemies = state.enemies;
    let spawnAt = state.spawnAt - dt;
    if (spawnAt <= 0) {
      if (enemies.length < MAX_ALIVE) {
        enemies = enemies.concat([makeEnemy(emptyEnemyCol(enemies))]);
      }
      spawnAt = SPAWN_INTERVAL;
    }
    enemies = updateEnemies(enemies, player, dt);

    let fireCooldown = state.fireCooldown - dt;
    let bullets = state.bullets;
    if (state.keys.space && fireCooldown <= 0) {
      bullets = bullets.concat([makeBullet(player)]);
      fireCooldown = FIRE_COOLDOWN;
    }
    fireCooldown = Math.max(0, fireCooldown);

    const enemyFired = enemyFire(enemies, bullets, dt);
    enemies = enemyFired.enemies;
    bullets = enemyFired.bullets;
    bullets = updateBullets(bullets, dt);

    const hit = resolveHits({
      enemies, bullets, player, invuln: state.invuln, score: state.score,
    });
    state = {
      ...state,
      player, enemies: hit.enemies, bullets: hit.bullets,
      score: hit.score, spawnAt, fireCooldown,
    };

    let invuln = Math.max(0, state.invuln - dt);

    if (hit.hitPlayer) {
      const lives = state.lives - 1;
      if (lives <= 0) {
        return { ...state, lives: 0, status: 'over', enemies: [], bullets: [], invuln: 0 };
      }
      invuln = INVULN_TIME;
      state = {
        ...state,
        lives,
        invuln,
        player: makePlayer(),
        bullets: [],
      };
    } else {
      state = { ...state, invuln };
    }

    return state;
  }

  // ---- 渲染 --------------------------------------------------------------------
  function drawTank(t, color) {
    const cx = t.x + t.size / 2;
    const cy = t.y + t.size / 2;
    const vec = DIR_VEC[t.dir];

    ctx.fillStyle = '#0c0f14';
    ctx.fillRect(t.x, t.y, 7, t.size);
    ctx.fillRect(t.x + t.size - 7, t.y, 7, t.size);

    ctx.fillStyle = color;
    ctx.fillRect(t.x + 7, t.y + 7, t.size - 14, t.size - 14);

    const ax = cx - 2 + vec[0] * (t.size / 2);
    const ay = cy - 2 + vec[1] * (t.size / 2);
    const bw = vec[0] === 0 ? 4 : Math.abs(vec[0]) * t.size;
    const bh = vec[1] === 0 ? 4 : Math.abs(vec[1]) * t.size;
    const ox = vec[0] < 0 ? ax - bw : ax;
    const oy = vec[1] < 0 ? ay - bh : ay;
    ctx.fillStyle = color;
    ctx.fillRect(ox, oy, bw, bh);

    ctx.fillStyle = '#ffffff22';
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawWalls() {
    for (let r = 0; r < GRID_H; r += 1) {
      for (let c = 0; c < GRID_W; c += 1) {
        if (!walls[r][c]) continue;
        ctx.fillStyle = '#46586d';
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
        ctx.fillStyle = '#38455a';
        ctx.fillRect(c * TILE + 2, r * TILE + 2, TILE - 4, TILE - 4);
        ctx.fillStyle = '#5a6c80';
        ctx.fillRect(c * TILE + 10, r * TILE + 10, 12, 12);
      }
    }
  }

  function render(state) {
    ctx.clearRect(0, 0, GRID_W * TILE, GRID_H * TILE);
    drawWalls();
    for (const e of state.enemies) drawTank(e, '#e04a4a');
    for (const b of state.bullets) {
      ctx.fillStyle = b.team === 'player' ? '#ffd23f' : '#ff8a5c';
      ctx.fillRect(b.x, b.y, b.size, b.size);
    }
    if (state.invuln > 0 && Math.floor(state.invuln * 8) % 2 === 0) {
      ctx.globalAlpha = 0.4;
    }
    drawTank(state.player, '#35e0b8');
    ctx.globalAlpha = 1;
  }

  // ---- HUD 与界面 ---------------------------------------------------------------
  const scoreEl = document.getElementById('score');
  const livesEl = document.getElementById('lives');
  const overlay = document.getElementById('overlay');
  const finalScoreEl = document.getElementById('final-score');

  let state = initialState();
  const keysState = {};
  let running = true;
  let lastTime = 0;

  function syncHud(st) {
    scoreEl.textContent = String(st.score);
    livesEl.textContent = String(st.lives);
    if (st.status === 'over') {
      finalScoreEl.textContent = String(st.score);
      overlay.classList.remove('hidden');
    } else {
      overlay.classList.add('hidden');
    }
  }

  function startGame() {
    state = initialState();
    syncHud(state);
    canvas.focus();
    if (!running) {
      running = true;
      lastTime = 0;
      requestAnimationFrame(gameLoop);
    }
  }

  // ---- 输入 -------------------------------------------------------------------
  document.addEventListener('keydown', (ev) => {
    if (KEYS_PLAYER[ev.key] !== undefined) {
      keysState[ev.key] = true;
      ev.preventDefault();
    }
    if (ev.key === ' ') {
      keysState.space = true;
      ev.preventDefault();
    }
    if (ev.key === 'r' || ev.key === 'R') {
      if (state.status === 'over') startGame();
    }
  });

  document.addEventListener('keyup', (ev) => {
    if (KEYS_PLAYER[ev.key] !== undefined) keysState[ev.key] = false;
    if (ev.key === ' ') keysState.space = false;
  });

  document.getElementById('restart').addEventListener('click', () => {
    if (state.status === 'over') startGame();
  });

  canvas.addEventListener('click', () => canvas.focus());

  // ---- 主循环 -------------------------------------------------------------------
  function gameLoop(now) {
    if (lastTime === 0) lastTime = now;
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    state = tick({ ...state, keys: keysState }, dt);
    render(state);
    syncHud(state);

    if (state.status === 'over') {
      running = false;
      return;
    }
    requestAnimationFrame(gameLoop);
  }

  requestAnimationFrame(gameLoop);
})();
