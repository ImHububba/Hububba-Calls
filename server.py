import os
import time
import threading
from flask import Flask, send_from_directory, request
from flask_socketio import SocketIO, emit, join_room, leave_room

# -----------------------------
# Flask / Socket.IO setup
# -----------------------------
ROOT = os.path.dirname(os.path.abspath(__file__))
app = Flask(
    __name__,
    static_folder=os.path.join(ROOT, "static"),
    static_url_path="/static",
)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev")

# CORS: allow everything by default; tighten via env if you want
allowed = os.environ.get("ALLOWED_ORIGINS", "*")
socketio = SocketIO(app, cors_allowed_origins=allowed, async_mode="eventlet")

GRACE_SECONDS = int(os.environ.get("DISCONNECT_GRACE_SECONDS", "30"))

# -----------------------------
# In-memory room state
# rooms: {
#   "<room>": {
#       "created": <ts>,
#       "users": { "<name>": {"sid": <sid>, "last_seen": <ts>} }
#   }
# }
# sid_index: { <sid>: {"room": <room>, "user": <name>} }
# -----------------------------
rooms = {}
sid_index = {}

def now() -> float:
    return time.time()

def rooms_snapshot():
    out = []
    t = now()
    for r, v in rooms.items():
        out.append({
            "name": r,
            "users": sorted(list(v["users"].keys())),
            "elapsed": int(t - v["created"]),
        })
    return sorted(out, key=lambda x: x["name"].lower())

def emit_rooms_update():
    socketio.emit("rooms_update", rooms_snapshot())

def ensure_room(room: str):
    if room not in rooms:
        rooms[room] = {"created": now(), "users": {}}

def mark_seen(room: str, user: str, sid: str):
    ensure_room(room)
    rooms[room]["users"][user] = {"sid": sid, "last_seen": now()}
    sid_index[sid] = {"room": room, "user": user}

def remove_user(room: str, user: str, expect_sid: str | None = None):
    """Remove a user from a room. If expect_sid is passed, only remove if sid matches."""
    if room not in rooms:
        return
    u = rooms[room]["users"].get(user)
    if not u:
        return
    if expect_sid and u["sid"] != expect_sid:
        return
    rooms[room]["users"].pop(user, None)
    # drop stale sid_index entries
    bad_sids = [sid for sid, meta in sid_index.items()
                if meta["room"] == room and meta["user"] == user]
    for s in bad_sids:
        sid_index.pop(s, None)
    # delete room if empty
    if not rooms[room]["users"]:
        rooms.pop(room, None)

def delayed_cleanup(sid: str):
    """Wait GRACE_SECONDS; if user did not rejoin, remove them."""
    time.sleep(GRACE_SECONDS)
    meta = sid_index.get(sid)
    if not meta:
        return  # user already rejoined under a new sid or was removed
    room = meta["room"]
    user = meta["user"]
    # If last_seen is older than grace, remove
    u = rooms.get(room, {}).get("users", {}).get(user)
    if not u:
        sid_index.pop(sid, None)
        return
    if now() - u["last_seen"] >= GRACE_SECONDS:
        remove_user(room, user, expect_sid=u["sid"])
        emit_rooms_update()

# -----------------------------
# HTTP
# -----------------------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")

@app.route("/health")
def health():
    return "OK", 200

# -----------------------------
# Socket.IO events
# -----------------------------
@socketio.on("connect")
def on_connect():
    emit("hello", {"ok": True})

@socketio.on("heartbeat")
def on_heartbeat(data=None):
    """Keep last_seen fresh while the tab is alive."""
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

    # name taken protection with grace
    if existing and existing["sid"] != request.sid:
        recent = now() - existing["last_seen"] < GRACE_SECONDS
        if recent:
            emit("join_error", {"field": "user", "msg": "That name is already in this room"})
            return
        # stale holder; allow takeover

    join_room(room)
    mark_seen(room, user, request.sid)

    # tell everyone a peer is ready (mesh fanout)
    socketio.emit("ready", {"user": user}, to=room, skip_sid=request.sid)

    # send joined+room meta to the new client
    emit("joined", {
        "room": room,
        "created": rooms[room]["created"],
        "users": sorted(list(rooms[room]["users"].keys()))
    })

    emit_rooms_update()

@socketio.on("leave")
def on_leave(data):
    sid = request.sid
    meta = sid_index.get(sid)
    if not meta:
        return
    room = meta["room"]
    user = meta["user"]
    leave_room(room)
    remove_user(room, user, expect_sid=sid)
    emit_rooms_update()
    # notify peers that user left
    socketio.emit("peer_left", {"user": user}, to=room)

@socketio.on("disconnect")
def on_disconnect():
    # don't remove instantly—start grace timer
    sid = request.sid
    meta = sid_index.get(sid)
    if meta:
        # mark last_seen at disconnect time
        mark_seen(meta["room"], meta["user"], sid)
        threading.Thread(target=delayed_cleanup, args=(sid,), daemon=True).start()

# ---------- Signaling: target-by-username via server routing ----------

def _sid_for(room: str, name: str) -> str | None:
    u = rooms.get(room, {}).get("users", {}).get(name)
    return None if not u else u["sid"]

@socketio.on("webrtc-offer")
def on_webrtc_offer(data):
    room = data.get("room")
    to = data.get("to")
    if not room or not to:
        return
    sid = _sid_for(room, to)
    if sid:
        emit("webrtc-offer", data, to=sid)

@socketio.on("webrtc-answer")
def on_webrtc_answer(data):
    room = data.get("room")
    to = data.get("to")
    if not room or not to:
        return
    sid = _sid_for(room, to)
    if sid:
        emit("webrtc-answer", data, to=sid)

@socketio.on("webrtc-ice-candidate")
def on_webrtc_ice(data):
    room = data.get("room")
    to = data.get("to")
    if not room or not to:
        return
    sid = _sid_for(room, to)
    if sid:
        emit("webrtc-ice-candidate", data, to=sid)

# -----------------------------
# Entrypoint (auto-pick open port)
# -----------------------------
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
        # find next open if 5000 is busy (local dev convenience)
        port = find_open_port(port)
    print(
        "\n" + "=" * 70 +
        f"\nHububba Calls (Socket.IO)\n CORS: {allowed}\n Host: 0.0.0.0\n Port: {port}\n" +
        "=" * 70 + "\n"
    )
    socketio.run(app, host="0.0.0.0", port=port)
