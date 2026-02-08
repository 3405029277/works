// online.js — 通用联机模块（Cloudflare Worker WebSocket）
// 依赖：无。会挂在 window.OnlineClient 上。

(function () {
  class OnlineClient {
    constructor(opts) {
      this.wsBase = opts.wsBase;          // 例如 "wss://ws.cjx88.eu.cc"
      this.wsPath = opts.wsPath || "/ws"; // "/ws"(五子棋) 或 "/relay"(通用转发)
      this.onMessage = opts.onMessage || (() => {});
      this.onStatus = opts.onStatus || (() => {});
      this.onPresence = opts.onPresence || (() => {});
      this.onRole = opts.onRole || (() => {});
      this.autoReconnect = opts.autoReconnect !== false;
      this.reconnectDelay = opts.reconnectDelay || 1000;

      this.ws = null;
      this.roomId = null;
      this.role = 0; // 0观战 1黑 2白（/ws 会给 you；/relay 默认仍为 0）
      this.count = 0;

      this._reconnectTimer = null;
    }

    _getRoomId() {
      const u = new URL(location.href);
      let r = u.searchParams.get("room");
      if (!r) {
        r = Math.random().toString(36).slice(2, 10);
        u.searchParams.set("room", r);
        history.replaceState(null, "", u.toString());
      }
      return r;
    }

    _url() {
      return `${this.wsBase}${this.wsPath}?room=${encodeURIComponent(this.roomId)}`;
    }

    connect() {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }

      this.roomId = this._getRoomId();
      this.role = 0;
      this.onRole(this.role);

      if (this.ws) {
        try { this.ws.close(); } catch {}
        this.ws = null;
      }

      this.onStatus("connecting");
      this.ws = new WebSocket(this._url());

      this.ws.onopen = () => this.onStatus("open");

      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        // /ws 会发 init: {type:"init", you, moves, current...}
        if (msg.type === "init") {
          this.role = msg.you || 0;
          this.onRole(this.role);
        }

        // /ws 和 /relay 都会发 presence: {type:"presence", n}
        if (msg.type === "presence" && typeof msg.n === "number") {
          this.count = msg.n;
          this.onPresence(this.count);
        }

        this.onMessage(msg);
      };

      this.ws.onerror = () => this.onStatus("error");

      this.ws.onclose = () => {
        this.onStatus("closed");
        if (!this.autoReconnect) return;
        this._reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      };
    }

    close() {
      this.autoReconnect = false;

      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }

      if (this.ws) {
        try { this.ws.close(); } catch {}
        this.ws = null;
      }

      this.role = 0;
      this.count = 0;
      this.onRole(this.role);
      this.onPresence(this.count);
      this.onStatus("closed");
    }

    send(obj) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      this.ws.send(JSON.stringify(obj));
      return true;
    }

    copyLink() {
      return navigator.clipboard.writeText(location.href);
    }
  }

  window.OnlineClient = OnlineClient;
})();
