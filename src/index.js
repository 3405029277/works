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
      players: {},         // connId -> { color }
      moves: [],
      current: BLACK,
      gameOver: false,

      // 新增：投票（双方都点才生效）
      swapVotes: {},       // connId -> true
      rematchVotes: {},    // connId -> true
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

    // 绑定 connId 到这个 ws（用于之后定向发 role）
    server.serializeAttachment({ connId });

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

    // 广播在线人数 + 广播各自身份（保证角标及时正确）
    this._broadcastPresence();
    this._broadcastRoles(room);

    server.addEventListener("message", async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      // ======================
      // 1) 开始前换黑白（双方同意）
      // ======================
      if (msg.type === "swap") {
        // 只允许：未开局（没落子）+ 未结束
        if (room.gameOver) return;
        if (room.moves.length !== 0) return;

        const player = room.players[connId];
        if (!player || (player.color !== BLACK && player.color !== WHITE)) return;

        room.swapVotes[connId] = true;

        const ids = room.order.filter(
          (id) => room.players[id]?.color === BLACK || room.players[id]?.color === WHITE
        );

        const bothVoted = ids.length >= 2 && ids.every((id) => room.swapVotes[id]);

        if (bothVoted) {
          // 找到当前黑白并交换
          const blackId = ids.find((id) => room.players[id].color === BLACK);
          const whiteId = ids.find((id) => room.players[id].color === WHITE);
          if (blackId && whiteId) {
            room.players[blackId].color = WHITE;
            room.players[whiteId].color = BLACK;
          }
          room.swapVotes = {};
          room.rematchVotes = {};

          // 定向通知每个人：你现在是黑/白/观战
          this._broadcastRoles(room);

          await this.state.storage.put("room", room);
        } else {
          this._broadcast({ type: "swap_pending" });
          await this.state.storage.put("room", room);
        }
        return;
      }

      // ======================
      // 2) 再来一局（双方同意）
      // ======================
      if (msg.type === "rematch") {
        if (!room.gameOver) return;

        const player = room.players[connId];
        if (!player || (player.color !== BLACK && player.color !== WHITE)) return;

        room.rematchVotes[connId] = true;

        const ids = room.order.filter(
          (id) => room.players[id]?.color === BLACK || room.players[id]?.color === WHITE
        );

        const bothVoted = ids.length >= 2 && ids.every((id) => room.rematchVotes[id]);

        if (bothVoted) {
          room.moves = [];
          room.current = BLACK;     // 新局：黑先（你要改成“换先”也行，后面我教你）
          room.gameOver = false;
          room.rematchVotes = {};
          room.swapVotes = {};

          // 广播新状态（前端收到后清盘）
          this._broadcast({
            type: "state",
            moves: room.moves,
            current: room.current,
            gameOver: room.gameOver,
          });

          await this.state.storage.put("room", room);
        } else {
          this._broadcast({ type: "rematch_pending" });
          await this.state.storage.put("room", room);
        }
        return;
      }

      // ======================
      // 3) 原来的落子逻辑（权威判胜）
      // ======================
      if (msg.type !== "move") return;
      if (room.gameOver) return;

      const player = room.players[connId];
      if (!player || (player.color !== BLACK && player.color !== WHITE)) return;
      if (player.color !== room.current) return;

      const r = msg.r | 0, c = msg.c | 0;
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

      // 清理投票（防止有人掉线后卡住）
      delete room.swapVotes?.[connId];
      delete room.rematchVotes?.[connId];

      await this.state.storage.put("room", room);

      // 有人离开也广播在线人数
      this._broadcastPresence();
      this._broadcastRoles(room);
    });

    return new Response(null, { status: 101, webSocket: client });
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

  // 定向给每个连接发 role（你是谁：黑/白/观战）
  _broadcastRoles(room) {
    for (const ws of this.state.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment?.();
        const id = att?.connId;
        const you = id ? (room.players[id]?.color || 0) : 0;
        ws.send(JSON.stringify({ type: "role", you }));
      } catch {}
    }
  }
}

function isOccupied(moves, r, c) {
  return moves.some((m) => m.r === r && m.c === c);
}

function checkWin(moves, r, c, p) {
  const s = new Set(moves.filter((m) => m.p === p).map((m) => `${m.r}#${m.c}`));
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let cnt = 1;
    for (let k=1;k<5;k++) if (s.has(`${r+dr*k}#${c+dc*k}`)) cnt++; else break;
    for (let k=1;k<5;k++) if (s.has(`${r-dr*k}#${c-dr*k}`)) cnt++; else break;
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
      try { msg = JSON.parse(evt.data); } catch { return; }
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
      try { ws.send(msg); } catch {}
    }
  }

  _broadcastPresence() {
    const n = this.state.getWebSockets().length;
    this._broadcast({ type: "presence", n });
  }
}
