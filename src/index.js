export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ===== 五子棋：权威房间（判胜/校验回合）=====
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const roomId = url.searchParams.get("room") || "default";
      const id = env.ROOM.idFromName(roomId);
      return env.ROOM.get(id).fetch(request);
    }

    // ===== 通用转发房间：给中国象棋等复用（不做规则校验）=====
    if (url.pathname === "/relay") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const roomId = url.searchParams.get("room") || "default";
      const id = env.RELAY.idFromName(roomId);
      return env.RELAY.get(id).fetch(request);
    }

    return new Response("OK");
  },
};

const SIZE = 19;
const BLACK = 1, WHITE = 2;

// ========================
// 五子棋房间（权威）
// ========================
export class GomokuRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let room = (await this.state.storage.get("room")) || {
      order: [],
      players: {},
      moves: [],
      current: BLACK,
      gameOver: false,
    };

    const connId = crypto.randomUUID();

    // 分配身份：第 1 人黑，第 2 人白，其余观战(0)
    let color = 0;
    if (room.order.length === 0) color = BLACK;
    else if (room.order.length === 1) color = WHITE;

    room.players[connId] = { color };
    room.order.push(connId);

    // 让 DO 记住 WebSocket，方便广播
    this.state.acceptWebSocket(server);

    // 先把当前房间状态发给这个新连接
    server.send(
      JSON.stringify({
        type: "init",
        you: color,
        moves: room.moves,
        current: room.current,
        gameOver: room.gameOver,
      })
    );

    // 广播在线人数（所有人都能显示“房间：N人”）
    this._broadcastPresence();

    server.addEventListener("message", async (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.type !== "move") return;
      if (room.gameOver) return;

      const player = room.players[connId];
      if (!player || (player.color !== BLACK && player.color !== WHITE)) return;
      if (player.color !== room.current) return;

      const r = msg.r | 0,
        c = msg.c | 0;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return;
      if (isOccupied(room.moves, r, c)) return;

      room.moves.push({ r, c, p: player.color });

      if (checkWin(room.moves, r, c, player.color)) {
        room.gameOver = true;
        this._broadcast({ type: "move", r, c, p: player.color, win: player.color });
      } else {
        room.current = room.current === BLACK ? WHITE : BLACK;
        this._broadcast({ type: "move", r, c, p: player.color, next: room.current });
      }

      await this.state.storage.put("room", room);
    });

    server.addEventListener("close", async () => {
      delete room.players[connId];
      room.order = room.order.filter((x) => x !== connId);
      await this.state.storage.put("room", room);

      // 有人离开也广播在线人数
      this._broadcastPresence();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  _broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  _broadcastPresence() {
    const n = this.state.getWebSockets().length;
    this._broadcast({ type: "presence", n });
  }
}

function isOccupied(moves, r, c) {
  return moves.some((m) => m.r === r && m.c === c);
}

function checkWin(moves, r, c, p) {
  const s = new Set(moves.filter((m) => m.p === p).map((m) => `${m.r}#${m.c}`));
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of dirs) {
    let cnt = 1;
    for (let k = 1; k < 5; k++) if (s.has(`${r + dr * k}#${c + dc * k}`)) cnt++;
    else break;
    for (let k = 1; k < 5; k++) if (s.has(`${r - dr * k}#${c - dc * k}`)) cnt++;
    else break;
    if (cnt >= 5) return true;
  }
  return false;
}

// ========================
// 通用转发房间（给中国象棋等复用）
// - 不做规则校验
// - 收到什么就广播什么
// - 也会广播 presence 在线人数
// ========================
export class RelayRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    this.state.acceptWebSocket(server);

    // 新连接进来，广播人数
    this._broadcastPresence();

    server.addEventListener("message", (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      // 原样广播
      this._broadcast(msg);
    });

    server.addEventListener("close", () => {
      this._broadcastPresence();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  _broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  _broadcastPresence() {
    const n = this.state.getWebSockets().length;
    this._broadcast({ type: "presence", n });
  }
}
