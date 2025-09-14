import os
import time
import threading
from flask import Flask, send_from_directory, request
from flask_socketio import SocketIO, emit, join_room, leave_room

ROOT = os.path.dirname(os.path.abspath(__file__))
app = Flask(
    __name__,
    static_folder=os.path.join(ROOT, "static"),
    static_url_path="/static",
)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev")

allowed = os.environ.get("ALLOWED_ORIGINS", "*")
socketio = SocketIO(app, cors_allowed_origins=allowed, async_mode="eventlet")

# How long to wait before removing a truly disconnected user (grace on tab close)
GRACE_SECONDS = int(os.environ.get("DISCONNECT_GRACE_SECONDS", "8"))
# If a duplicate name hasn't heartbeat'd for this many seconds, treat it as a ghost immediately
STALE_SECONDS = int(os.environ.get("DUPLICATE_STALE_SECONDS", "5"))

# -------------------------------------------------------------------
# In-memory room state
# rooms: {
#   "<room>": {
#       "created": <ts>,
#       "users": { "<name>": {"sid": <sid>, "last_seen": <ts>} }
#   }
# }
# sid_index: { <sid>: {"room": <room>, "user": <name>} }
# -------------------------------------------------------------------
rooms = {}
sid_index = {}

def now() -> float:
    return time.time()

def ensure_room(room: str):
    if room not in rooms:
        rooms[room] = {"created": now(), "users": {}}

def safe_disconnect(sid: str):
    try:
        socketio.server.disconnect(sid)
    except Exception:
        pass

def mark_seen(room: str, user: str, sid: str):
    ensure_room(room)
    rooms[room]["users"][user] = {"sid": sid, "last_seen": now()}
    sid_index[sid] = {"room": room, "user": user}

def remove_user(room: str, user: str, expect_sid: str | None = None):
    if room not in rooms:
        return
    u = rooms[room]["users"].get(user)
    if not u:
        return
    if expect_sid and u["sid"] != expect_sid:
        return
    rooms[room]["users"].pop(user, None)
    # clean sid_index
    for sid, meta in list(sid_index.items()):
        if meta["room"] == room and meta["user"] == user:
            sid_index.pop(sid, None)
    # delete empty room
    if not rooms[room]["users"]:
        rooms.pop(room, None)

def rooms_snapshot():
    t = now()
    out = []
    for r, v in rooms.items():
        out.append({
            "name": r,
            "users": sorted(list(v["users"].keys())),
            "elapsed": int(t - v["created"]),
        })
    return sorted(out, key=lambda x: x["name"].lower())

def emit_rooms_update():
    socketio.emit("rooms_update", rooms_snapshot())

# -------------------------------------------------------------------
# HTTP
# -------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")

@app.route("/health")
def health():
    return "OK", 200

# -------------------------------------------------------------------
# Socket.IO events
# -------------------------------------------------------------------
@socketio.on("connect")
def on_connect():
    emit("hello", {"ok": True})

@socketio.on("heartbeat")
def on_heartbeat(_=None):
    sid = request.sid
    meta = sid_index.get(sid)
    if meta:
        mark_seen(meta["room"], meta["user"], sid)

@socketio.on("request_rooms")
def on_request_rooms():
    emit("rooms_update", rooms_snapshot())

@socketio.on("join")
def on_join(data):
    room = (data or {}).get("room", "").strip()
    user = (data or {}).get("user", "").strip()

    if not room:
        emit("join_error", {"field": "room", "msg": "Room name required"})
        return
    if not user:
        emit("join_error", {"field": "user", "msg": "Display name required"})
        return

    ensure_room(room)
    existing = rooms[room]["users"].get(user)

    if existing and existing["sid"] != request.sid:
        age = now() - existing["last_seen"]
        # FAST auto-evict if the holder is stale (ghost)
        if age >= STALE_SECONDS:
            safe_disconnect(existing["sid"])
            remove_user(room, user, expect_sid=existing["sid"])
            emit_rooms_update()
        else:
            # Active conflict -> let client decide to kick manually
            emit("join_conflict", {
                "room": room,
                "user": user,
                "msg": "That name is already in this room"
            })
            return

    join_room(room)
    mark_seen(room, user, request.sid)

    # notify peers to start WebRTC
    socketio.emit("ready", {"user": user}, to=room, skip_sid=request.sid)

    emit("joined", {
        "room": room,
        "created": rooms[room]["created"],
        "users": sorted(list(rooms[room]["users"].keys()))
    })

    emit_rooms_update()

@socketio.on("kick_user")
def on_kick_user(data):
    """Manual kick (used to clear a stuck duplicate name)."""
    room = (data or {}).get("room", "").strip()
    target = (data or {}).get("target", "").strip()
    if not room or not target:
        emit("kick_result", {"ok": False, "msg": "Missing room/target"})
        return
    ex = rooms.get(room, {}).get("users", {}).get(target)
    if not ex:
        emit("kick_result", {"ok": False, "msg": "User not found"})
        return
    safe_disconnect(ex["sid"])
    remove_user(room, target, expect_sid=ex["sid"])
    emit_rooms_update()
    socketio.emit("peer_left", {"user": target}, to=room)
    emit("kick_result", {"ok": True, "target": target})

@socketio.on("leave")
def on_leave(_data):
    sid = request.sid
    meta = sid_index.get(sid)
    if not meta:
        return
    room = meta["room"]
    user = meta["user"]
    leave_room(room)
    remove_user(room, user, expect_sid=sid)
    emit_rooms_update()
    socketio.emit("peer_left", {"user": user}, to=room)

@socketio.on("disconnect")
def on_disconnect():
    # Wait a short grace; if they don't come back, remove them.
    sid = request.sid
    meta = sid_index.get(sid)
    if not meta:
        return
    # mark last_seen at disconnect time
    mark_seen(meta["room"], meta["user"], sid)
    def delayed_cleanup(s):
        time.sleep(GRACE_SECONDS)
        m = sid_index.get(s)
        if not m:
            return
        r, u = m["room"], m["user"]
        current = rooms.get(r, {}).get("users", {}).get(u)
        if not current:
            sid_index.pop(s, None)
            return
        if now() - current["last_seen"] >= GRACE_SECONDS:
            remove_user(r, u, expect_sid=current["sid"])
            emit_rooms_update()
            socketio.emit("peer_left", {"user": u}, to=r)
    threading.Thread(target=delayed_cleanup, args=(sid,), daemon=True).start()

# ---- Signaling routed by room+username ---------------------------------
def _sid_for(room: str, name: str) -> str | None:
    u = rooms.get(room, {}).get("users", {}).get(name)
    return None if not u else u["sid"]

@socketio.on("webrtc-offer")
def on_webrtc_offer(data):
    room, to = data.get("room"), data.get("to")
    sid = _sid_for(room, to) if room and to else None
    if sid:
        emit("webrtc-offer", data, to=sid)

@socketio.on("webrtc-answer")
def on_webrtc_answer(data):
    room, to = data.get("room"), data.get("to")
    sid = _sid_for(room, to) if room and to else None
    if sid:
        emit("webrtc-answer", data, to=sid)

@socketio.on("webrtc-ice-candidate")
def on_webrtc_ice(data):
    room, to = data.get("room"), data.get("to")
    sid = _sid_for(room, to) if room and to else None
    if sid:
        emit("webrtc-ice-candidate", data, to=sid)

# -------------------------------------------------------------------
# Entrypoint (auto-pick open port for local dev)
# -------------------------------------------------------------------
def find_open_port(start: int) -> int:
    import socket
    port = start
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("0.0.0.0", port))
            except OSError:
                port += 1
                continue
            return port

if __name__ == "__main__":
    req = int(os.environ.get("PORT", "5000"))
    port = req if req > 0 else 5000
    if "PORT" not in os.environ:
        port = find_open_port(port)
    print(
        "\n" + "=" * 70 +
        f"\nHububba Calls (Socket.IO)\n CORS: {allowed}\n Host: 0.0.0.0\n Port: {port}\n" +
        "=" * 70 + "\n"
    )
    socketio.run(app, host="0.0.0.0", port=port)
