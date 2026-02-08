export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const roomId = url.searchParams.get("room") || "default";
      const id = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("OK");
  },
};

const SIZE = 19;
const BLACK = 1, WHITE = 2;

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

    let color = 0;
    if (room.order.length === 0) color = BLACK;
    else if (room.order.length === 1) color = WHITE;

    room.players[connId] = { color };
    room.order.push(connId);

    // 让 DO 能记住 WebSocket，方便广播
    this.state.acceptWebSocket(server);

    server.send(JSON.stringify({
      type: "init",
      you: color,
      moves: room.moves,
      current: room.current,
      gameOver: room.gameOver,
    }));

    server.addEventListener("message", async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
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
        room.current = (room.current === BLACK ? WHITE : BLACK);
        this._broadcast({ type: "move", r, c, p: player.color, next: room.current });
      }

      await this.state.storage.put("room", room);
    });

    server.addEventListener("close", async () => {
      delete room.players[connId];
      room.order = room.order.filter(x => x !== connId);
      await this.state.storage.put("room", room);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  _broadcast(payload) {
    const msg = JSON.stringify(payload);
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      try { ws.send(msg); } catch {}
    }
  }
}

function isOccupied(moves, r, c) {
  return moves.some(m => m.r === r && m.c === c);
}

function checkWin(moves, r, c, p) {
  const s = new Set(moves.filter(m => m.p === p).map(m => `${m.r}#${m.c}`));
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let cnt = 1;
    for (let k=1;k<5;k++) if (s.has(`${r+dr*k}#${c+dc*k}`)) cnt++; else break;
    for (let k=1;k<5;k++) if (s.has(`${r-dr*k}#${c-dc*k}`)) cnt++; else break;
    if (cnt >= 5) return true;
  }
  return false;
}
