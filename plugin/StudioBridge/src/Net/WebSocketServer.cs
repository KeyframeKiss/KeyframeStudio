using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace StudioEX.Bridge.Net
{
    /// <summary>
    /// Tiny RFC 6455 WebSocket server (text frames only), bound to localhost.
    /// Runs accept/read loops on background threads; callbacks fire on those threads,
    /// so consumers must marshal onto Unity's main thread themselves.
    /// </summary>
    public sealed class WebSocketServer : IDisposable
    {
        private const string Guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

        private readonly int _port;
        private TcpListener _listener;
        private Thread _acceptThread;
        private volatile bool _running;
        private readonly List<WsClient> _clients = new List<WsClient>();
        private int _nextId = 1;

        public event Action<WsClient> ClientConnected;
        public event Action<WsClient> ClientDisconnected;
        public event Action<WsClient, string> MessageReceived;
        public event Action<string> Log;

        public WebSocketServer(int port) { _port = port; }

        public int ClientCount { get { lock (_clients) return _clients.Count; } }

        public void Start()
        {
            _listener = new TcpListener(IPAddress.Loopback, _port);
            _listener.Start();
            _running = true;
            _acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "StudioEX.WsAccept" };
            _acceptThread.Start();
        }

        public void Broadcast(string text)
        {
            WsClient[] snapshot;
            lock (_clients) snapshot = _clients.ToArray();
            foreach (var c in snapshot) c.Send(text);
        }

        public void BroadcastBinary(byte[] data)
        {
            WsClient[] snapshot;
            lock (_clients) snapshot = _clients.ToArray();
            foreach (var c in snapshot) c.SendBinary(data);
        }

        private void AcceptLoop()
        {
            while (_running)
            {
                try
                {
                    var tcp = _listener.AcceptTcpClient();
                    tcp.NoDelay = true;
                    // Writes happen on Unity's main thread: a client that stops reading must not freeze the game.
                    tcp.SendTimeout = 2000;
                    var client = new WsClient(this, tcp, Interlocked.Increment(ref _nextId));
                    var t = new Thread(client.Run) { IsBackground = true, Name = "StudioEX.WsClient" + client.Id };
                    t.Start();
                }
                catch (SocketException) { if (!_running) return; }
                catch (ObjectDisposedException) { return; }
                catch (Exception e) { Log?.Invoke("Accept error: " + e); }
            }
        }

        internal void OnOpen(WsClient c)
        {
            lock (_clients) _clients.Add(c);
            ClientConnected?.Invoke(c);
        }

        internal void OnClose(WsClient c)
        {
            bool removed;
            lock (_clients) removed = _clients.Remove(c);
            if (removed) ClientDisconnected?.Invoke(c);
        }

        internal void OnMessage(WsClient c, string msg) => MessageReceived?.Invoke(c, msg);
        internal void OnLog(string msg) => Log?.Invoke(msg);

        public void Dispose()
        {
            _running = false;
            try { _listener?.Stop(); } catch { }
            WsClient[] snapshot;
            lock (_clients) snapshot = _clients.ToArray();
            foreach (var c in snapshot) c.Close();
        }

        internal static string ComputeAccept(string key)
        {
            using (var sha1 = SHA1.Create())
                return Convert.ToBase64String(sha1.ComputeHash(Encoding.ASCII.GetBytes(key.Trim() + Guid)));
        }
    }

    public sealed class WsClient
    {
        private readonly WebSocketServer _server;
        private readonly TcpClient _tcp;
        private NetworkStream _stream;
        private readonly object _writeLock = new object();
        private volatile bool _open;

        public int Id { get; }

        internal WsClient(WebSocketServer server, TcpClient tcp, int id)
        {
            _server = server;
            _tcp = tcp;
            Id = id;
        }

        internal void Run()
        {
            try
            {
                _stream = _tcp.GetStream();
                // a connection that never finishes its handshake mustn't hold a thread forever
                _stream.ReadTimeout = 10000;
                if (!Handshake()) { _tcp.Close(); return; }
                _stream.ReadTimeout = Timeout.Infinite;
                _open = true;
                _server.OnOpen(this);
                ReadLoop();
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
            catch (Exception e) { _server.OnLog("Client " + Id + " error: " + e); }
            finally
            {
                _open = false;
                try { _tcp.Close(); } catch { }
                _server.OnClose(this);
            }
        }

        private bool Handshake()
        {
            // Read HTTP upgrade request headers byte by byte until CRLFCRLF.
            var buf = new List<byte>(1024);
            int matched = 0;
            byte[] terminator = { 13, 10, 13, 10 };
            while (matched < 4)
            {
                int b = _stream.ReadByte();
                if (b < 0) return false;
                buf.Add((byte)b);
                matched = b == terminator[matched] ? matched + 1 : (b == 13 ? 1 : 0);
                if (buf.Count > 16384) return false;
            }
            string request = Encoding.ASCII.GetString(buf.ToArray());
            string key = null, origin = null;
            foreach (var line in request.Split(new[] { "\r\n" }, StringSplitOptions.None))
            {
                int colon = line.IndexOf(':');
                if (colon <= 0) continue;
                var name = line.Substring(0, colon).Trim();
                if (name.Equals("Sec-WebSocket-Key", StringComparison.OrdinalIgnoreCase)) key = line.Substring(colon + 1).Trim();
                else if (name.Equals("Origin", StringComparison.OrdinalIgnoreCase)) origin = line.Substring(colon + 1).Trim();
            }
            // Browsers don't apply CORS to WebSockets: refuse web pages so a random site can't drive Studio.
            // Allowed: no Origin (scripts/tools), file:// and null (packaged app), loopback dev servers.
            if (!OriginAllowed(origin))
            {
                _server.OnLog("Rejected WebSocket from origin " + origin);
                var body = Encoding.ASCII.GetBytes("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
                _stream.Write(body, 0, body.Length);
                return false;
            }
            // …and an origin can be faked (a sandboxed iframe sends "null"), so every client also proves it can read
            // the bridge token, which only programs running as this Windows user can (see BridgeToken)
            int eol = request.IndexOf("\r\n", StringComparison.Ordinal);
            if (!BridgeToken.Matches(BridgeToken.FromRequestLine(eol > 0 ? request.Substring(0, eol) : request)))
            {
                _server.OnLog("Rejected a connection without the bridge token (origin " + (origin ?? "none") + ")");
                var body = Encoding.ASCII.GetBytes("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
                _stream.Write(body, 0, body.Length);
                return false;
            }
            if (key == null)
            {
                var body = Encoding.ASCII.GetBytes("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
                _stream.Write(body, 0, body.Length);
                return false;
            }
            string response =
                "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Accept: " + WebSocketServer.ComputeAccept(key) + "\r\n\r\n";
            var bytes = Encoding.ASCII.GetBytes(response);
            _stream.Write(bytes, 0, bytes.Length);
            return true;
        }

        private static bool OriginAllowed(string origin)
        {
            if (string.IsNullOrEmpty(origin) || origin == "null" || origin.StartsWith("file://", StringComparison.OrdinalIgnoreCase)) return true;
            try
            {
                var u = new Uri(origin);
                return u.IsLoopback && (u.Scheme == "http" || u.Scheme == "https");
            }
            catch { return false; }
        }

        private void ReadExactly(byte[] buffer, int count)
        {
            int read = 0;
            while (read < count)
            {
                int n = _stream.Read(buffer, read, count - read);
                if (n <= 0) throw new IOException("Connection closed");
                read += n;
            }
        }

        private void ReadLoop()
        {
            var header = new byte[8];
            var mask = new byte[4];
            var message = new MemoryStream();
            int messageOpcode = 0;

            while (_open)
            {
                ReadExactly(header, 2);
                bool fin = (header[0] & 0x80) != 0;
                int opcode = header[0] & 0x0F;
                bool masked = (header[1] & 0x80) != 0;
                long len = header[1] & 0x7F;
                if (len == 126)
                {
                    ReadExactly(header, 2);
                    len = (header[0] << 8) | header[1];
                }
                else if (len == 127)
                {
                    ReadExactly(header, 8);
                    len = 0;
                    for (int i = 0; i < 8; i++) len = (len << 8) | header[i];
                }
                if (len < 0 || len > 64 * 1024 * 1024) throw new IOException("Frame too large");
                if (masked) ReadExactly(mask, 4);
                var payload = new byte[len];
                if (len > 0) ReadExactly(payload, (int)len);
                if (masked)
                    for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i & 3];

                switch (opcode)
                {
                    case 0x0: // continuation
                    case 0x1: // text
                    case 0x2: // binary (treated as text)
                        if (opcode != 0) { messageOpcode = opcode; message.SetLength(0); }
                        else if (messageOpcode == 0) break; // stray continuation frame
                        message.Write(payload, 0, payload.Length);
                        if (message.Length > 64 * 1024 * 1024) throw new IOException("Message too large");
                        if (fin)
                        {
                            if (messageOpcode == 0x1 || messageOpcode == 0x2)
                                _server.OnMessage(this, Encoding.UTF8.GetString(message.ToArray()));
                            message.SetLength(0);
                            messageOpcode = 0;
                        }
                        break;
                    case 0x8: // close
                        SendFrame(0x8, payload);
                        _open = false;
                        return;
                    case 0x9: // ping
                        SendFrame(0xA, payload);
                        break;
                    case 0xA: // pong
                        break;
                }
            }
        }

        public void Send(string text)
        {
            if (!_open) return;
            try { SendFrame(0x1, Encoding.UTF8.GetBytes(text)); }
            catch (Exception) { Close(); }
        }

        public void SendBinary(byte[] data)
        {
            if (!_open) return;
            try { SendFrame(0x2, data); }
            catch (Exception) { Close(); }
        }

        private void SendFrame(int opcode, byte[] payload)
        {
            lock (_writeLock)
            {
                var stream = _stream;
                if (stream == null) return;
                int len = payload.Length;
                byte[] head;
                if (len < 126)
                    head = new byte[] { (byte)(0x80 | opcode), (byte)len };
                else if (len <= 0xFFFF)
                    head = new byte[] { (byte)(0x80 | opcode), 126, (byte)(len >> 8), (byte)len };
                else
                {
                    head = new byte[10];
                    head[0] = (byte)(0x80 | opcode);
                    head[1] = 127;
                    long l = len;
                    for (int i = 0; i < 8; i++) head[9 - i] = (byte)(l >> (8 * i));
                }
                stream.Write(head, 0, head.Length);
                stream.Write(payload, 0, len);
                stream.Flush();
            }
        }

        public void Close()
        {
            _open = false;
            try { _tcp.Close(); } catch { }
        }
    }
}
