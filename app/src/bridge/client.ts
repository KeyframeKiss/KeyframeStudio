import { noteRequest } from '../lib/macros';
// WebSocket client for the in-game Keyframe Studio Bridge plugin.
// Request/response with ids, plus server-pushed events. Auto-reconnects.

type Listener = (data: unknown) => void;

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: number;
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<Listener>>();
  private reconnectTimer: number | undefined;
  private _status: ConnectionStatus = 'closed';
  private disposed = false;
  private attempt = 0;

  constructor(public url: string) {}

  get status() {
    return this._status;
  }

  connect() {
    if (this.disposed) return;
    window.clearTimeout(this.reconnectTimer);
    this.setStatus('connecting');
    // the bridge asks every connection for its token (only programs running as this Windows user can read it)
    const attempt = ++this.attempt;
    const token = window.studioEx?.bridgeToken?.() ?? Promise.resolve('');
    token
      .catch(() => '')
      .then((t) => {
        if (this.disposed || this.ws || attempt !== this.attempt) return;
        this.open(t ? `${this.url}/?token=${encodeURIComponent(t)}` : this.url);
      });
  }

  private open(url: string) {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.setStatus('open');
    ws.onmessage = (ev) => {
      // Binary frames = live preview images (experimental); everything else is JSON.
      if (typeof ev.data === 'string') this.onMessage(ev.data);
      else this.emit('$binary', ev.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const p of this.pending.values()) {
        window.clearTimeout(p.timer);
        p.reject(new Error('Disconnected'));
      }
      this.pending.clear();
      this.setStatus('closed');
      this.scheduleReconnect();
    };
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private scheduleReconnect() {
    if (this.disposed) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), 1500);
  }

  private setStatus(s: ConnectionStatus) {
    this._status = s;
    this.emit('$status', s);
  }

  private onMessage(raw: string) {
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; data?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.event) {
      this.emit(msg.event, msg.data);
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      window.clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'Request failed'));
    }
  }

  request<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 10000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to Studio'));
    const id = this.nextId++;
    noteRequest(cmd, args); // quick-action recording (only while recording; skips reads)
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Studio did not answer "${cmd}" in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, cmd, args }));
    });
  }

  /** Fire-and-forget (used for high-rate scrubbing). */
  send(cmd: string, args: Record<string, unknown> = {}) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ id: null, cmd, args }));
  }

  on(event: string, fn: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(event: string, data: unknown) {
    this.listeners.get(event)?.forEach((fn) => fn(data));
  }
}

const DEFAULT_PORT = 47615;

function resolveUrl() {
  const params = new URLSearchParams(location.search);
  const port = params.get('port') || localStorageGet('studioex.port') || String(DEFAULT_PORT);
  return `ws://127.0.0.1:${port}`;
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

export const bridge = new BridgeClient(resolveUrl());
