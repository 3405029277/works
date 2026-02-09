// Cloudflare Worker (module syntax)
// - /ws         : 五子棋权威房间（判胜/校验回合）
// - /relay      : 默认纯转发
// - /relay?game=xq : 中国象棋权威房间（座位+断线重连+回合校验+胜负/重开/换边）

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ===== 五子棋 =====
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const roomId = url.searchParams.get("room") || "default";
      const id = env.ROOM.idFromName(roomId);
      return env.ROOM.get(id).fetch(request);
    }

    // ===== 通用转发 / 中国象棋 =====
    if (url.pathname === "/relay") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const roomId = url.searchParams.get("room") || "default";
      const game = url.searchParams.get("game") || "relay";
      const name = `${game}:${roomId}`; // 隔离不同用途
      const id = env.RELAY.idFromName(name);
      return env.RELAY.get(id).fetch(request);
    }

    return new Response("OK");
  },
};

// ========================
// 五子棋房间（权威 · 座位制 · 断线重连 · 换边/再来一局）
// ========================
const SIZE = 19;
const GOMOKU_BLACK = 1, GOMOKU_WHITE = 2;
const GM_GRACE_MS = 3 * 60 * 1000; // 断线重连保座位时间（3分钟）

export class GomokuRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // ✅ WebSocket Hibernation API：只调用 acceptWebSocket
    this.state.acceptWebSocket(server);

    let room = (await this.state.storage.get("gm_room")) || this._defaultRoom();
    const now = Date.now();

    const tokenParam = (url.searchParams.get("token") || "").trim();
    const want = (url.searchParams.get("want") || "auto").trim().toLowerCase();

    const onlineCount = this._countOnlineByRoleWithRoom(room);

    // 1) token 直接回座
    let you = 0;
    let token = tokenParam || "";
    if (token && token === room.blackToken) you = GOMOKU_BLACK;
    else if (token && token === room.whiteToken) you = GOMOKU_WHITE;

    // 2) token 不匹配：按 want 分配（座位占用则观战）
    if (you === 0) {
      const canStealBlack = room.blackToken && (onlineCount[GOMOKU_BLACK] || 0) === 0 && (now - (room.blackLastSeen || 0) > GM_GRACE_MS);
      const canStealWhite = room.whiteToken && (onlineCount[GOMOKU_WHITE] || 0) === 0 && (now - (room.whiteLastSeen || 0) > GM_GRACE_MS);

      const wantBlack = want === "black" || want === "b" || want === "1";
      const wantWhite = want === "white" || want === "w" || want === "2";
      const wantSpectate = want === "spectate" || want === "watch" || want === "0";
      const wantAuto = want === "auto" || want === "";

      if (!wantSpectate && (wantBlack || wantAuto)) {
        if (!room.blackToken || canStealBlack) {
          you = GOMOKU_BLACK;
          token = crypto.randomUUID();
          room.blackToken = token;
          room.blackLastSeen = now;
        }
      }

      if (you === 0 && !wantSpectate && (wantWhite || wantAuto)) {
        if (!room.whiteToken || canStealWhite) {
          you = GOMOKU_WHITE;
          token = crypto.randomUUID();
          room.whiteToken = token;
          room.whiteLastSeen = now;
        }
      }
    } else {
      // 续座：刷新 lastSeen
      if (you === GOMOKU_BLACK) room.blackLastSeen = now;
      if (you === GOMOKU_WHITE) room.whiteLastSeen = now;
    }

    // 兜底：有座位但 token 为空
    if ((you === GOMOKU_BLACK || you === GOMOKU_WHITE) && !token) {
      token = crypto.randomUUID();
      if (you === GOMOKU_BLACK) room.blackToken = token;
      if (you === GOMOKU_WHITE) room.whiteToken = token;
    }

    await this.state.storage.put("gm_room", room);

    // 给 ws 绑 metadata（用于 message/close）
    if (server.serializeAttachment) server.serializeAttachment({ game: "gomoku", token });

    // ✅ 同 token（刷新/多开）只保留一条连接，避免人数/座位错乱
    if (token) this._kickSameToken(server, token);

    // 发 init（只给这个连接）
    server.send(JSON.stringify({
      type: "init",
      you,
      token: (you === GOMOKU_BLACK || you === GOMOKU_WHITE) ? token : "",
      moves: room.moves,
      current: room.current,
      gameOver: room.gameOver,
      winner: room.winner || 0,
      reason: room.reason || "",
      seats: { black: !!room.blackToken, white: !!room.whiteToken },
      votes: { rematch: room.rematch, swap: room.swap },
    }));

    // 广播在线人数/座位
    this._broadcastPresence();
    this._broadcastSeats(room);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let att = null;
    try { att = ws.deserializeAttachment ? ws.deserializeAttachment() : null; } catch {}
    if (!att || att.game !== "gomoku") return;

    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    let room = (await this.state.storage.get("gm_room")) || this._defaultRoom();
    const now = Date.now();

    const role = this._roleFromToken(att.token, room); // ✅ 关键：始终“以 token 映射角色”为准
    const isPlayer = (role === GOMOKU_BLACK || role === GOMOKU_WHITE);

    const reject = (reason) => {
      try { ws.send(JSON.stringify({ type: "reject", reason: String(reason || "操作无效") })); } catch {}
    };


    // ---- 走子 ----
    if (msg.type === "move") {
      if (!isPlayer) return reject("观战不能落子");
      if (room.gameOver) return reject("对局已结束");
      if (room.current !== role) return reject("还没轮到你");

      const r = msg.r | 0, c = msg.c | 0;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return reject("落子越界");
      if (isOccupied(room.moves, r, c)) return reject("该点已有棋子");

      room.moves.push({ r, c, p: role });

      if (role === GOMOKU_BLACK) room.blackLastSeen = now;
      if (role === GOMOKU_WHITE) room.whiteLastSeen = now;

      // 清空投票
      room.rematch = { [GOMOKU_BLACK]: false, [GOMOKU_WHITE]: false };
      room.swap = { [GOMOKU_BLACK]: false, [GOMOKU_WHITE]: false };

      if (checkWin(room.moves, r, c, role)) {
        room.gameOver = true;
        room.winner = role;
        room.reason = "五连";
        await this.state.storage.put("gm_room", room);
        this._broadcast({ type: "move", r, c, p: role, win: role });
        return;
      }

      room.current = (role === GOMOKU_BLACK) ? GOMOKU_WHITE : GOMOKU_BLACK;
      await this.state.storage.put("gm_room", room);
      this._broadcast({ type: "move", r, c, p: role, next: room.current });
      return;
    }

    // ---- 超时判负（可选：前端若发送）----
    if (msg.type === "timeout") {
      if (!isPlayer) return reject("观战不能落子");
      if (room.gameOver) return reject("对局已结束");
      if (room.current !== role) return reject("还没轮到你");

      room.gameOver = true;
      room.winner = (role === GOMOKU_BLACK) ? GOMOKU_WHITE : GOMOKU_BLACK;
      room.reason = "超时判负";
      await this.state.storage.put("gm_room", room);
      this._broadcast({ type: "move", r: -1, c: -1, p: role, win: room.winner, reason: room.reason });
      return;
    }

    // ---- 再来一局（双方确认）----
    if (msg.type === "rematch") {
      if (!isPlayer) return;
      if (!room.gameOver) return;

      room.rematch[role] = true;
      await this.state.storage.put("gm_room", room);

      // 通知对方/观战
      this._broadcast({ type: "rematch_pending" });
      this._broadcast({ type: "votes", votes: { rematch: room.rematch, swap: room.swap } });

      if (room.rematch[GOMOKU_BLACK] && room.rematch[GOMOKU_WHITE] && room.blackToken && room.whiteToken) {
        room.moves = [];
        room.current = GOMOKU_BLACK;
        room.gameOver = false;
        room.winner = 0;
        room.reason = "";
        room.rematch = { [GOMOKU_BLACK]: false, [GOMOKU_WHITE]: false };
        room.swap = { [GOMOKU_BLACK]: false, [GOMOKU_WHITE]: false };
        await this.state.storage.put("gm_room", room);

        this._broadcast({ type: "state", moves: [], current: room.current, gameOver: false });
        this._broadcast({ type: "votes", votes: { rematch: room.rematch, swap: room.swap } });
      }
      return;
    }

    // ---- 换边（双方确认；对局进行中不允许换）----
    if (msg.type === "swap") {
      if (!isPlayer) return;
      if (!room.gameOver && room.moves.length > 0) return;

      room.swap[role] = true;
      await this.state.storage.put("gm_room", room);

      this._broadcast({ type: "swap_pending" });
      this._broadcast({ type: "votes", votes: { rematch: room.rematch, swap: room.swap } });

      if (room.swap[GOMOKU_BLACK] && room.swap[GOMOKU_WHITE] && room.blackToken && room.whiteToken) {
        // 交换 token（等价于双方换边）
        const t = room.blackToken;
        room.blackToken = room.whiteToken;
        room.whiteToken = t;

        const ts = room.blackLastSeen;
        room.blackLastSeen = room.whiteLastSeen;
        room.whiteLastSeen = ts;

        // 新局
        room.moves = [];
        room.current = GOMOKU_BLACK;
        room.gameOver = false;
        room.winner = 0;
        room.reason = "";
        room.rematch = { [GOMOKU_BLACK]: false, [GOMOKU_WHITE]: false };
        room.swap = { [GOMOKU_BLACK]: false, [GOMOKU_WHITE]: false };

        await this.state.storage.put("gm_room", room);

        // 广播座位变化
        this._broadcastSeats(room);

        // ✅ 定向通知每条连接它现在是谁（避免前端“刷新/重连才知道角色”）
        for (const w of this.state.getWebSockets()) {
          let a = null;
          try { a = w.deserializeAttachment ? w.deserializeAttachment() : null; } catch {}
          if (!a || a.game !== "gomoku") continue;
          const who = this._roleFromToken(a.token, room);
          try { w.send(JSON.stringify({ type: "role", you: who })); } catch {}
        }

        this._broadcast({ type: "state", moves: [], current: room.current, gameOver: false });
        this._broadcast({ type: "votes", votes: { rematch: room.rematch, swap: room.swap } });
      }
      return;
    }

    // ---- 主动离座（可选：前端如发送）----
    if (msg.type === "gm_leave") {
      if (!isPlayer) return;
      if (role === GOMOKU_BLACK && att.token && att.token === room.blackToken) {
        room.blackToken = "";
        room.blackLastSeen = 0;
      }
      if (role === GOMOKU_WHITE && att.token && att.token === room.whiteToken) {
        room.whiteToken = "";
        room.whiteLastSeen = 0;
      }
      await this.state.storage.put("gm_room", room);
      this._broadcastSeats(room);
      this._broadcastPresence();
      return;
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    let att = null;
    try { att = ws.deserializeAttachment ? ws.deserializeAttachment() : null; } catch {}

    if (att?.game === "gomoku") {
      const now = Date.now();
      let room = (await this.state.storage.get("gm_room")) || this._defaultRoom();
      const role = this._roleFromToken(att.token, room);
      if (role === GOMOKU_BLACK) room.blackLastSeen = now;
      if (role === GOMOKU_WHITE) room.whiteLastSeen = now;
      await this.state.storage.put("gm_room", room);
      this._broadcastSeats(room);
    }

    this._broadcastPresence();
  }

  // ===== helpers =====
  _defaultRoom() {
    return {
      blackToken: "",
      whiteToken: "",
      blackLastSeen: 0,
      whiteLastSeen: 0,
      moves: [],
      current: GOMOKU_BLACK,
      gameOver: false,
      winner: 0,
      reason: "",
      rematch: { [GOMOKU_BLACK]: false, [GOMOKU_WHITE]: false },
      swap: { [GOMOKU_BLACK]: false, [GOMOKU_WHITE]: false },
    };
  }

  _roleFromToken(token, room) {
    if (!token) return 0;
    if (token === room.blackToken) return GOMOKU_BLACK;
    if (token === room.whiteToken) return GOMOKU_WHITE;
    return 0;
  }

  _countOnlineByRoleWithRoom(room) {
    const cnt = { [GOMOKU_BLACK]: 0, [GOMOKU_WHITE]: 0 };
    for (const ws of this.state.getWebSockets()) {
      let a = null;
      try { a = ws.deserializeAttachment ? ws.deserializeAttachment() : null; } catch {}
      if (a?.game === "gomoku") {
        const role = this._roleFromToken(a.token, room);
        if (role === GOMOKU_BLACK || role === GOMOKU_WHITE) cnt[role] = (cnt[role] || 0) + 1;
      }
    }
    return cnt;
  }

  _kickSameToken(currentWs, token) {
    if (!token) return;
    for (const ws of this.state.getWebSockets()) {
      if (ws === currentWs) continue;
      let a = null;
      try { a = ws.deserializeAttachment ? ws.deserializeAttachment() : null; } catch {}
      if (a?.game === "gomoku" && a.token && a.token === token) {
        try { ws.close(1000, "reconnect"); } catch {}
      }
    }
  }

  _broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  _broadcastPresence() {
    const n = this.state.getWebSockets().length;
    this._broadcast({ type: "presence", n });
  }

  _broadcastSeats(room) {
    this._broadcast({ type: "gm_seats", seats: { black: !!room.blackToken, white: !!room.whiteToken } });
  }
}

function isOccupied(moves, r, c) {
  return (moves || []).some((m) => m.r === r && m.c === c);
}

function checkWin(moves, r, c, p) {
  const s = new Set((moves || []).filter((m) => m.p === p).map((m) => `${m.r}#${m.c}`));
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let cnt = 1;
    for (let k = 1; k < 5; k++) if (s.has(`${r + dr*k}#${c + dc*k}`)) cnt++; else break;
    for (let k = 1; k < 5; k++) if (s.has(`${r - dr*k}#${c - dc*k}`)) cnt++; else break;
    if (cnt >= 5) return true;
  }
  return false;
}

// ========================
// /relay 默认通用转发
// /relay?game=xq 中国象棋权威房间
// ========================
const XQ_RED = 1;
const XQ_BLACK = 2;
const XQ_GRACE_MS = 3 * 60 * 1000; // 断线重连保座位时间（3分钟）

export class RelayRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const game = url.searchParams.get("game") || "relay";
    if (game === "xq") return this._fetchXQ(request, url);
    return this._fetchRelay();
  }

  // -------- 通用纯转发 --------
  async _fetchRelay() {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);
    if (server.serializeAttachment) server.serializeAttachment({ game: "relay" });

    this._broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  // -------- 中国象棋（权威房间）--------
  async _fetchXQ(request, url) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);

    let room = (await this.state.storage.get("xq_room")) || this._xqDefaultRoom();
    const now = Date.now();

    const tokenParam = (url.searchParams.get("token") || "").trim();
    const want = (url.searchParams.get("want") || "auto").trim().toLowerCase();

    const onlineCount = this._xqCountOnlineByRole();

    // 1) token 直接回座
    let youRole = 0;
    let token = tokenParam || "";
    if (token && token === room.redToken) youRole = XQ_RED;
    else if (token && token === room.blackToken) youRole = XQ_BLACK;

    // 2) token 不匹配：按 want 分配（座位占用则观战）
    if (youRole === 0) {
      const canStealRed = room.redToken && onlineCount[XQ_RED] === 0 && (now - (room.redLastSeen || 0) > XQ_GRACE_MS);
      const canStealBlack = room.blackToken && onlineCount[XQ_BLACK] === 0 && (now - (room.blackLastSeen || 0) > XQ_GRACE_MS);

      const wantRed = want === "red" || want === "r" || want === "1";
      const wantBlack = want === "black" || want === "b" || want === "2";
      const wantSpectate = want === "spectate" || want === "watch" || want === "0";
      const wantAuto = want === "auto" || want === "";

      if (!wantSpectate && (wantRed || wantAuto)) {
        if (!room.redToken || canStealRed) {
          youRole = XQ_RED;
          token = crypto.randomUUID();
          room.redToken = token;
          room.redLastSeen = now;
        }
      }

      if (youRole === 0 && !wantSpectate && (wantBlack || wantAuto)) {
        if (!room.blackToken || canStealBlack) {
          youRole = XQ_BLACK;
          token = crypto.randomUUID();
          room.blackToken = token;
          room.blackLastSeen = now;
        }
      }
    } else {
      // 续座：刷新 lastSeen
      if (youRole === XQ_RED) room.redLastSeen = now;
      if (youRole === XQ_BLACK) room.blackLastSeen = now;
    }

    if ((youRole === XQ_RED || youRole === XQ_BLACK) && !token) {
      token = crypto.randomUUID();
      if (youRole === XQ_RED) room.redToken = token;
      if (youRole === XQ_BLACK) room.blackToken = token;
    }

    await this.state.storage.put("xq_room", room);

    if (server.serializeAttachment) server.serializeAttachment({ game: "xq", role: youRole, token });

    // ✅ 同 token（刷新/多开）只保留一条连接，避免人数/座位错乱
    if (token) {
      for (const w of this.state.getWebSockets()) {
        if (w === server) continue;
        let a = null;
        try { a = w.deserializeAttachment ? w.deserializeAttachment() : null; } catch {}
        if (a?.game === "xq" && a.token && a.token === token) {
          try { w.close(1000, "reconnect"); } catch {}
        }
      }
    }

    server.send(JSON.stringify({
      type: "init",
      you: youRole,
      token: (youRole === XQ_RED || youRole === XQ_BLACK) ? token : "",
      moves: room.moves,
      current: room.current,
      gameOver: room.gameOver,
      winner: room.winner || 0,
      reason: room.reason || "",
      seats: { red: !!room.redToken, black: !!room.blackToken },
      votes: { rematch: room.rematch, swap: room.swap },
    }));

    this._broadcastXqSeats(room);
    this._broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  // ===== WebSocket Hibernation handler =====
  async webSocketMessage(ws, message) {
    let att = null;
    try { att = ws.deserializeAttachment ? ws.deserializeAttachment() : null; } catch {}
    if (!att || !att.game) return;

    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    if (att.game === "relay") {
      this._broadcast(msg);
      return;
    }

    if (att.game === "xq") {
      await this._handleXqMessage(ws, att, msg);
      return;
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    let att = null;
    try { att = ws.deserializeAttachment ? ws.deserializeAttachment() : null; } catch {}

    if (att?.game === "xq") {
      const now = Date.now();
      let room = (await this.state.storage.get("xq_room")) || this._xqDefaultRoom();
      if (att.role === XQ_RED) room.redLastSeen = now;
      if (att.role === XQ_BLACK) room.blackLastSeen = now;
      await this.state.storage.put("xq_room", room);
      this._broadcastXqSeats(room);
    }

    this._broadcastPresence();
  }

  // ===== broadcast =====
  _broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  _broadcastPresence() {
    const n = this.state.getWebSockets().length;
    this._broadcast({ type: "presence", n });
  }

  _broadcastXqSeats(room) {
    this._broadcast({ type: "xq_seats", seats: { red: !!room.redToken, black: !!room.blackToken } });
  }

  _xqCountOnlineByRole() {
    const cnt = { [XQ_RED]: 0, [XQ_BLACK]: 0 };
    for (const ws of this.state.getWebSockets()) {
      let a = null;
      try { a = ws.deserializeAttachment ? ws.deserializeAttachment() : null; } catch {}
      if (a?.game === "xq" && (a.role === XQ_RED || a.role === XQ_BLACK)) {
        cnt[a.role] = (cnt[a.role] || 0) + 1;
      }
    }
    return cnt;
  }

  _xqDefaultRoom() {
    return {
      redToken: "",
      blackToken: "",
      redLastSeen: 0,
      blackLastSeen: 0,
      moves: [],          // [{from:{r,c}, to:{r,c}, p:1|2}]
      current: XQ_RED,    // 轮到谁走：1红 2黑
      gameOver: false,
      winner: 0,          // 1红 2黑
      reason: "",
      rematch: { [XQ_RED]: false, [XQ_BLACK]: false },
      swap: { [XQ_RED]: false, [XQ_BLACK]: false },
    };
  }

  async _handleXqMessage(ws, att, msg) {
    let room = (await this.state.storage.get("xq_room")) || this._xqDefaultRoom();
    const role = att.role | 0;
    const isPlayer = (role === XQ_RED || role === XQ_BLACK);

    const reject = (reason, sync=false) => {
      try { ws.send(JSON.stringify({ type: "reject", reason: String(reason || "操作无效") })); } catch {}
      if (sync) {
        try {
          ws.send(JSON.stringify({
            type: "init",
            you: role,
            token: (att.token && isPlayer) ? String(att.token) : "",
            moves: room.moves,
            current: room.current,
            gameOver: room.gameOver,
            winner: room.winner || 0,
            reason: room.reason || "",
            seats: { red: !!room.redToken, black: !!room.blackToken },
            votes: { rematch: room.rematch, swap: room.swap },
          }));
        } catch {}
      }
    };

    // ---- 走子 ----
    if (msg.type === "xq_move") {
      if (!isPlayer) return reject("观战不能落子");
      if (room.gameOver) return reject("对局已结束");
      if (room.current !== role) return reject("还没轮到你");

      const from = msg.from || {};
      const to = msg.to || {};
      const fr = from.r | 0, fc = from.c | 0, tr = to.r | 0, tc = to.c | 0;
      if (fr < 0 || fr >= 10 || fc < 0 || fc >= 9) return reject("起点越界");
      if (tr < 0 || tr >= 10 || tc < 0 || tc >= 9) return reject("终点越界");

      const game = buildXqEngineFromMoves(room.moves);
      const color = role === XQ_RED ? 1 : -1;
      if (game.turn !== color) return reject("状态不同步（回合不一致）", true);

      const legal = game.findLegalMove(fr, fc, tr, tc);
      if (!legal) return reject("非法走法", true);

      game.applyMove(legal);
      room.moves.push({ from: { r: fr, c: fc }, to: { r: tr, c: tc }, p: role });

      const nextRole = role === XQ_RED ? XQ_BLACK : XQ_RED;
      room.current = nextRole;

      // 判断胜负：对手无合法步则结束
      const nextColor = nextRole === XQ_RED ? 1 : -1;
      const nextMoves = game.getMoves(nextColor);
      let winMsg = null;

      if (nextMoves.length === 0) {
        room.gameOver = true;
        room.winner = role;
        const inCheck = game.isChecked(nextColor);
        room.reason = inCheck ? "绝杀" : "困毙";
        winMsg = { win: role, reason: room.reason };
      } else {
        room.reason = "";
      }

      // 清空投票
      room.rematch = { [XQ_RED]: false, [XQ_BLACK]: false };
      room.swap = { [XQ_RED]: false, [XQ_BLACK]: false };

      // 刷新 lastSeen
      const now = Date.now();
      if (role === XQ_RED) room.redLastSeen = now;
      if (role === XQ_BLACK) room.blackLastSeen = now;

      await this.state.storage.put("xq_room", room);

      this._broadcast({
        type: "xq_move",
        from: { r: fr, c: fc },
        to: { r: tr, c: tc },
        p: role,
        next: room.current,
        ...winMsg,
      });

      if (room.gameOver) {
        this._broadcast({ type: "xq_over", winner: room.winner, reason: room.reason });
      }
      return;
    }

    // ---- 超时判负 ----
    if (msg.type === "xq_timeout") {
      if (!isPlayer) return reject("观战不能落子");
      if (room.gameOver) return reject("对局已结束");
      if (room.current !== role) return reject("还没轮到你");

      room.gameOver = true;
      room.winner = role === XQ_RED ? XQ_BLACK : XQ_RED;
      room.reason = "超时判负";
      await this.state.storage.put("xq_room", room);
      this._broadcast({ type: "xq_over", winner: room.winner, reason: room.reason });
      return;
    }

    // ---- 再来一局（双方确认）----
    if (msg.type === "xq_rematch") {
      if (!isPlayer) return;
      if (!room.gameOver) return;

      room.rematch[role] = true;
      await this.state.storage.put("xq_room", room);
      this._broadcast({ type: "xq_votes", votes: { rematch: room.rematch, swap: room.swap } });

      if (room.rematch[XQ_RED] && room.rematch[XQ_BLACK] && room.redToken && room.blackToken) {
        room.moves = [];
        room.current = XQ_RED;
        room.gameOver = false;
        room.winner = 0;
        room.reason = "";
        room.rematch = { [XQ_RED]: false, [XQ_BLACK]: false };
        room.swap = { [XQ_RED]: false, [XQ_BLACK]: false };
        await this.state.storage.put("xq_room", room);

        this._broadcast({ type: "xq_reset", reason: "rematch", current: room.current, moves: [] });
        this._broadcast({ type: "xq_votes", votes: { rematch: room.rematch, swap: room.swap } });
      }
      return;
    }

    // ---- 换边（双方确认；对局进行中不允许换）----
    if (msg.type === "xq_swap") {
      if (!isPlayer) return;
      if (!room.gameOver && room.moves.length > 0) return;

      room.swap[role] = true;
      await this.state.storage.put("xq_room", room);
      this._broadcast({ type: "xq_votes", votes: { rematch: room.rematch, swap: room.swap } });

      if (room.swap[XQ_RED] && room.swap[XQ_BLACK] && room.redToken && room.blackToken) {
        // 交换 token
        const t = room.redToken;
        room.redToken = room.blackToken;
        room.blackToken = t;

        const ts = room.redLastSeen;
        room.redLastSeen = room.blackLastSeen;
        room.blackLastSeen = ts;

        // 新局
        room.moves = [];
        room.current = XQ_RED;
        room.gameOver = false;
        room.winner = 0;
        room.reason = "";
        room.rematch = { [XQ_RED]: false, [XQ_BLACK]: false };
        room.swap = { [XQ_RED]: false, [XQ_BLACK]: false };

        await this.state.storage.put("xq_room", room);

        this._broadcastXqSeats(room);
        this._broadcast({ type: "xq_reset", reason: "swap", current: room.current, moves: [] });

        // 关闭所有连接，让客户端自动重连刷新身份
        for (const w of this.state.getWebSockets()) {
          try { w.close(1000, "swap"); } catch {}
        }
      }
      return;
    }

    // ---- 主动离座 ----
    if (msg.type === "xq_leave") {
      if (!isPlayer) return;
      // token 匹配才释放
      if (role === XQ_RED && att.token && att.token === room.redToken) {
        room.redToken = "";
        room.redLastSeen = 0;
      }
      if (role === XQ_BLACK && att.token && att.token === room.blackToken) {
        room.blackToken = "";
        room.blackLastSeen = 0;
      }
      await this.state.storage.put("xq_room", room);
      this._broadcastXqSeats(room);
      this._broadcastPresence();
      return;
    }
  }
}

// ========================
// 中国象棋：服务端走法校验（最小实现：复用前端同款规则）
// ========================
const XQ_RED_COLOR = 1;
const XQ_BLACK_COLOR = -1;
const XQ_ROLES = { K: 1, A: 2, E: 3, H: 4, R: 5, C: 6, P: 7 };
const XQ_ROWS = 10, XQ_COLS = 9;

const XQ_INIT_MAP = [
  ['R','H','E','A','K','A','E','H','R'],
  [0,0,0,0,0,0,0,0,0],
  [0,'C',0,0,0,0,0,'C',0],
  ['P',0,'P',0,'P',0,'P',0,'P'],
  [0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0],
  ['p',0,'p',0,'p',0,'p',0,'p'],
  [0,'c',0,0,0,0,0,'c',0],
  [0,0,0,0,0,0,0,0,0],
  ['r','h','e','a','k','a','e','h','r']
];

const XQ_CHAR_CFG = {
  'r': { t: XQ_ROLES.R, c: XQ_RED_COLOR },
  'h': { t: XQ_ROLES.H, c: XQ_RED_COLOR },
  'e': { t: XQ_ROLES.E, c: XQ_RED_COLOR },
  'a': { t: XQ_ROLES.A, c: XQ_RED_COLOR },
  'k': { t: XQ_ROLES.K, c: XQ_RED_COLOR },
  'c': { t: XQ_ROLES.C, c: XQ_RED_COLOR },
  'p': { t: XQ_ROLES.P, c: XQ_RED_COLOR },

  'R': { t: XQ_ROLES.R, c: XQ_BLACK_COLOR },
  'H': { t: XQ_ROLES.H, c: XQ_BLACK_COLOR },
  'E': { t: XQ_ROLES.E, c: XQ_BLACK_COLOR },
  'A': { t: XQ_ROLES.A, c: XQ_BLACK_COLOR },
  'K': { t: XQ_ROLES.K, c: XQ_BLACK_COLOR },
  'C': { t: XQ_ROLES.C, c: XQ_BLACK_COLOR },
  'P': { t: XQ_ROLES.P, c: XQ_BLACK_COLOR }
};

class XqEngine {
  constructor() { this.init(); }

  init() {
    this.board = Array(XQ_ROWS).fill(0).map(() => Array(XQ_COLS).fill(null));
    for (let r = 0; r < XQ_ROWS; r++) for (let c = 0; c < XQ_COLS; c++) {
      const ch = XQ_INIT_MAP[r][c];
      if (ch && XQ_CHAR_CFG[ch]) this.board[r][c] = { ...XQ_CHAR_CFG[ch] };
    }
    this.turn = XQ_RED_COLOR;
  }

  getMoves(color) {
    const moves = [];
    for (let r = 0; r < XQ_ROWS; r++) for (let c = 0; c < XQ_COLS; c++) {
      const p = this.board[r][c];
      if (p && p.c === color) {
        const raw = this.getRawMoves(r, c, p.t, color);
        for (const m of raw) {
          if (!this.checkSimulate(color, m)) moves.push(m);
        }
      }
    }
    return moves;
  }

  findLegalMove(fr, fc, tr, tc) {
    const legal = this.getMoves(this.turn);
    return legal.find(m => m.from.r === fr && m.from.c === fc && m.to.r === tr && m.to.c === tc) || null;
  }

  applyMove(move) {
    this.board[move.to.r][move.to.c] = this.board[move.from.r][move.from.c];
    this.board[move.from.r][move.from.c] = null;
    this.turn = (this.turn === XQ_RED_COLOR ? XQ_BLACK_COLOR : XQ_RED_COLOR);
  }

  getRawMoves(r, c, type, color) {
    const m = [];
    const push = (tr, tc) => {
      if (tr >= 0 && tr < XQ_ROWS && tc >= 0 && tc < XQ_COLS) {
        const t = this.board[tr][tc];
        if (!t || t.c !== color) m.push({ from: { r, c }, to: { r: tr, c: tc }, capture: t || null });
      }
    };

    if (type === XQ_ROLES.R) { // 车
      [[0,1],[0,-1],[1,0],[-1,0]].forEach(([dr,dc]) => {
        for (let i=1;;i++){
          const tr=r+dr*i, tc=c+dc*i;
          if (tr<0||tr>=XQ_ROWS||tc<0||tc>=XQ_COLS) break;
          const t=this.board[tr][tc];
          if (!t) m.push({ from:{r,c}, to:{r:tr,c:tc}, capture:null});
          else { if (t.c!==color) m.push({ from:{r,c}, to:{r:tr,c:tc}, capture:t}); break; }
        }
      });
    } else if (type === XQ_ROLES.C) { // 炮
      [[0,1],[0,-1],[1,0],[-1,0]].forEach(([dr,dc]) => {
        let platform=false;
        for (let i=1;;i++){
          const tr=r+dr*i, tc=c+dc*i;
          if (tr<0||tr>=XQ_ROWS||tc<0||tc>=XQ_COLS) break;
          const t=this.board[tr][tc];
          if (!platform){
            if (!t) m.push({ from:{r,c}, to:{r:tr,c:tc}, capture:null});
            else platform=true;
          } else {
            if (t){ if (t.c!==color) m.push({ from:{r,c}, to:{r:tr,c:tc}, capture:t}); break; }
          }
        }
      });
    } else if (type === XQ_ROLES.H) { // 马
      [[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]].forEach(([dr,dc])=>{
        const tr=r+dr, tc=c+dc;
        const lr=r+(Math.abs(dr)===2?Math.sign(dr):0);
        const lc=c+(Math.abs(dc)===2?Math.sign(dc):0);
        if (tr>=0&&tr<XQ_ROWS&&tc>=0&&tc<XQ_COLS&&!this.board[lr][lc]) push(tr,tc);
      });
    } else if (type === XQ_ROLES.E) { // 相/象
      [[2,2],[2,-2],[-2,2],[-2,-2]].forEach(([dr,dc])=>{
        const tr=r+dr, tc=c+dc;
        const er=r+dr/2, ec=c+dc/2;
        if ((color===XQ_RED_COLOR && tr<5) || (color===XQ_BLACK_COLOR && tr>4)) return;
        if (tr>=0&&tr<XQ_ROWS&&tc>=0&&tc<XQ_COLS&&!this.board[er][ec]) push(tr,tc);
      });
    } else if (type === XQ_ROLES.A) { // 仕/士
      [[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([dr,dc])=>{
        const tr=r+dr, tc=c+dc;
        if (tc<3||tc>5) return;
        if ((color===XQ_RED_COLOR && tr<7) || (color===XQ_BLACK_COLOR && tr>2)) return;
        push(tr,tc);
      });
    } else if (type === XQ_ROLES.K) { // 将/帅
      [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc])=>{
        const tr=r+dr, tc=c+dc;
        if (tc<3||tc>5) return;
        if ((color===XQ_RED_COLOR && tr<7) || (color===XQ_BLACK_COLOR && tr>2)) return;
        push(tr,tc);
      });
    } else if (type === XQ_ROLES.P) { // 兵/卒
      const dir = color===XQ_RED_COLOR ? -1 : 1;
      push(r+dir, c);
      if ((color===XQ_RED_COLOR && r<=4) || (color===XQ_BLACK_COLOR && r>=5)) { push(r,c+1); push(r,c-1); }
    }

    return m;
  }

  checkSimulate(color, move) {
    const old = this.board[move.to.r][move.to.c];
    this.board[move.to.r][move.to.c] = this.board[move.from.r][move.from.c];
    this.board[move.from.r][move.from.c] = null;
    const danger = this.isChecked(color);
    this.board[move.from.r][move.from.c] = this.board[move.to.r][move.to.c];
    this.board[move.to.r][move.to.c] = old;
    return danger;
  }

  isChecked(color) { return this.getCheckSource(color) !== null; }

  getCheckSource(color) {
    let king = null;
    for (let r=0;r<XQ_ROWS;r++) for (let c=0;c<XQ_COLS;c++){
      const p=this.board[r][c];
      if (p && p.t===XQ_ROLES.K && p.c===color) king={r,c};
    }
    if (!king) return null;

    const enemy = (color===XQ_RED_COLOR?XQ_BLACK_COLOR:XQ_RED_COLOR);

    // 飞将
    for (let r=0;r<XQ_ROWS;r++) for (let c=0;c<XQ_COLS;c++){
      const p=this.board[r][c];
      if (p && p.t===XQ_ROLES.K && p.c===enemy){
        if (c===king.c){
          let hasBlocker=false;
          for (let i=Math.min(r,king.r)+1;i<Math.max(r,king.r);i++){
            if (this.board[i][c]) {hasBlocker=true; break;}
          }
          if (!hasBlocker) return {type:"FLY"};
        }
      }
    }

    // 普通攻击（含炮）
    for (let r=0;r<XQ_ROWS;r++) for (let c=0;c<XQ_COLS;c++){
      const p=this.board[r][c];
      if (p && p.c===enemy){
        const moves=this.getRawMoves(r,c,p.t,enemy);
        if (moves.some(m=>m.to.r===king.r && m.to.c===king.c)) return {type:"NORMAL"};
      }
    }
    return null;
  }
}

function buildXqEngineFromMoves(moves) {
  const e = new XqEngine();
  for (const m of (moves||[])) {
    const legal = e.findLegalMove(m.from.r|0, m.from.c|0, m.to.r|0, m.to.c|0);
    if (!legal) continue;
    e.applyMove(legal);
  }
  return e;
}
