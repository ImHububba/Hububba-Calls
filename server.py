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

# Tunables (override via env if you want)
GRACE_SECONDS  = int(os.environ.get("DISCONNECT_GRACE_SECONDS", "5"))   # remove after brief tab close
STALE_SECONDS  = int(os.environ.get("DUPLICATE_STALE_SECONDS", "2"))    # consider duplicate "ghost" if > this
CHAT_MAX       = int(os.environ.get("CHAT_MAX", "200"))                 # per-room chat history cap
CHAT_TRIM_TO   = int(os.environ.get("CHAT_TRIM_TO", "160"))             # trim down to this when exceeding

# -------------------------------------------------------------------
# In-memory room state
# -------------------------------------------------------------------
# rooms = {
#   room: {
#       "created": ts,
#       "owner": "name" | None,
#       "users": { name: {"sid":sid, "last_seen":ts, "joined_at":ts} },
#       "chat": [ { "ts": ts, "type": "system"|"user", "user": "name"|None, "text": str } ]
#   }
# }
# sid_index = { sid: {"room": room, "user": name} }
rooms = {}
sid_index = {}

def now() -> float: return time.time()

def ensure_room(room: str):
    if room not in rooms:
        rooms[room] = {"created": now(), "owner": None, "users": {}, "chat": []}

def mark_seen(room: str, user: str, sid: str):
    ensure_room(room)
    cur = rooms[room]["users"].get(user)
    t = now()
    if not cur or cur.get("sid") != sid:
        rooms[room]["users"][user] = {"sid": sid, "last_seen": t, "joined_at": t}
    else:
        cur["last_seen"] = t
        cur["sid"] = sid
    sid_index[sid] = {"room": room, "user": user}

def remove_user(room: str, user: str, expect_sid: str | None = None):
    if room not in rooms: return
    u = rooms[room]["users"].get(user)
    if not u: return
    if expect_sid and u["sid"] != expect_sid: return
    rooms[room]["users"].pop(user, None)
    # clean sid index entries for that (room,user)
    for sid, meta in list(sid_index.items()):
        if meta["room"] == room and meta["user"] == user:
            sid_index.pop(sid, None)
    if not rooms[room]["users"]:
        rooms.pop(room, None)

def safe_disconnect(sid: str):
    try:
        socketio.server.disconnect(sid)
    except Exception:
        pass

def rooms_snapshot():
    t = now()
    out = []
    for r, v in rooms.items():
        out.append({
            "name": r,
            "users": sorted(v["users"].keys()),
            "elapsed": int(t - v["created"]),
            "owner": v.get("owner")
        })
    return sorted(out, key=lambda x: x["name"].lower())

def emit_rooms_update():
    socketio.emit("rooms_update", rooms_snapshot())

def transfer_owner_if_needed(room: str):
    """If room has no valid owner, promote the earliest joined remaining user."""
    if room not in rooms: return
    v = rooms[room]
    owner = v.get("owner")
    # Owner still valid?
    if owner and owner in v["users"]:
        return
    # No users? keep None; room might be deleted by caller later
    if not v["users"]:
        v["owner"] = None
        return
    # Promote earliest joined
    next_owner = min(v["users"].items(), key=lambda kv: kv[1].get("joined_at", now()))[0]
    v["owner"] = next_owner
    socketio.emit("owner_changed", {"room": room, "owner": next_owner}, to=room)
    add_chat(room, "system", None, f"{next_owner} is now operator")

def is_admin_sid(sid: str) -> bool:
    meta = sid_index.get(sid)
    if not meta: return False
    room, user = meta["room"], meta["user"]
    return rooms.get(room, {}).get("owner") == user

# ---------------- Chat helpers ----------------
def add_chat(room: str, mtype: str, user: str | None, text: str):
    """Append a chat message and trim."""
    if room not in rooms: return
    text = (text or "")[:500]
    msg = {"ts": int(now()), "type": mtype, "user": user, "text": text, "room": room}
    rooms[room]["chat"].append(msg)
    # Trim if too big
    if len(rooms[room]["chat"]) > CHAT_MAX:
        rooms[room]["chat"] = rooms[room]["chat"][-CHAT_TRIM_TO:]
    return msg

# -------------------------------------------------------------------
# HTTP
# -------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")

@app.route("/health")
def health(): return "OK", 200

# -------------------------------------------------------------------
# Socket.IO
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
    force = bool((data or {}).get("force", False))

    if not room:
        emit("join_error", {"field": "room", "msg": "Room name required"}); return
    if not user:
        emit("join_error", {"field": "user", "msg": "Display name required"}); return

    ensure_room(room)
    existing = rooms[room]["users"].get(user)

    if existing and existing["sid"] != request.sid:
        age = now() - existing["last_seen"]
        # Fast path: auto-evict ghosts or force-takeover
        if age >= STALE_SECONDS or force:
            try:
                emit("kicked", {"room": room, "by": "system", "reason": "name_taken"}, to=existing["sid"])
            except Exception:
                pass
            safe_disconnect(existing["sid"])
            remove_user(room, user, expect_sid=existing["sid"])
            emit_rooms_update()
        else:
            emit("join_conflict", {"room": room, "user": user, "msg": "That name is already in this room"})
            return

    was_empty = (len(rooms[room]["users"]) == 0)

    join_room(room)
    mark_seen(room, user, request.sid)

    # Make first joiner the owner
    if was_empty or rooms[room].get("owner") is None:
        rooms[room]["owner"] = user
        socketio.emit("owner_changed", {"room": room, "owner": user}, to=room)

    # announce join
    sysmsg = add_chat(room, "system", None, f"{user} joined")
    if sysmsg: socketio.emit("chat_message", sysmsg, to=room)

    # start mesh for others
    socketio.emit("ready", {"user": user}, to=room, skip_sid=request.sid)

    emit("joined", {
        "room": room,
        "created": rooms[room]["created"],
        "users": sorted(list(rooms[room]["users"].keys())),
        "owner": rooms[room]["owner"],
        "chat": rooms[room]["chat"][-100:]
    })
    emit_rooms_update()

@socketio.on("kick_user")
def on_kick_user(data):
    """Owner-only kick within the same room."""
    sid = request.sid
    meta = sid_index.get(sid)
    room = (data or {}).get("room", "").strip()
    target = (data or {}).get("target", "").strip()

    if not meta:
        emit("kick_result", {"ok": False, "msg": "Not joined"}); return
    if not room or not target:
        emit("kick_result", {"ok": False, "msg": "Missing room/target"}); return
    if meta["room"] != room:
        emit("kick_result", {"ok": False, "msg": "Wrong room"}); return
    if not is_admin_sid(sid):
        emit("kick_result", {"ok": False, "msg": "Not authorized"}); return
    if target == meta["user"]:
        emit("kick_result", {"ok": False, "msg": "Cannot kick yourself"}); return

    ex = rooms.get(room, {}).get("users", {}).get(target)
    if not ex:
        emit("kick_result", {"ok": False, "msg": "User not found"}); return

    # Notify the target and disconnect
    try:
        emit("kicked", {"room": room, "by": meta["user"], "reason": "admin"}, to=ex["sid"])
    except Exception:
        pass
    safe_disconnect(ex["sid"])
    remove_user(room, target, expect_sid=ex["sid"])
    transfer_owner_if_needed(room)
    emit_rooms_update()
    socketio.emit("peer_left", {"user": target}, to=room)
    # announce
    sysmsg = add_chat(room, "system", None, f"{target} was kicked by {meta['user']}")
    if sysmsg: socketio.emit("chat_message", sysmsg, to=room)
    emit("kick_result", {"ok": True, "target": target})

@socketio.on("leave")
def on_leave(_data):
    sid = request.sid
    meta = sid_index.get(sid)
    if not meta: return
    room, user = meta["room"], meta["user"]
    leave_room(room)
    remove_user(room, user, expect_sid=sid)
    transfer_owner_if_needed(room)
    emit_rooms_update()
    socketio.emit("peer_left", {"user": user}, to=room)
    sysmsg = add_chat(room, "system", None, f"{user} left")
    if sysmsg: socketio.emit("chat_message", sysmsg, to=room)

@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    meta = sid_index.get(sid)
    if not meta: return
    # update last seen then schedule cleanup
    mark_seen(meta["room"], meta["user"], sid)
    def cleanup(s):
        time.sleep(GRACE_SECONDS)
        m = sid_index.get(s)
        if not m: return
        r, u = m["room"], m["user"]
        current = rooms.get(r, {}).get("users", {}).get(u)
        if current and now() - current["last_seen"] >= GRACE_SECONDS:
            remove_user(r, u, expect_sid=current["sid"])
            transfer_owner_if_needed(r)
            emit_rooms_update()
            socketio.emit("peer_left", {"user": u}, to=r)
            sysmsg = add_chat(r, "system", None, f"{u} left")
            if sysmsg: socketio.emit("chat_message", sysmsg, to=r)
    threading.Thread(target=cleanup, args=(sid,), daemon=True).start()

# ---- WebRTC signaling routed by room+username ---------------------------
def _sid_for(room: str, name: str) -> str | None:
    u = rooms.get(room, {}).get("users", {}).get(name)
    return None if not u else u["sid"]

@socketio.on("webrtc-offer")
def on_webrtc_offer(data):
    room, to = data.get("room"), data.get("to")
    sid = _sid_for(room, to) if room and to else None
    if sid: emit("webrtc-offer", data, to=sid)

@socketio.on("webrtc-answer")
def on_webrtc_answer(data):
    room, to = data.get("room"), data.get("to")
    sid = _sid_for(room, to) if room and to else None
    if sid: emit("webrtc-answer", data, to=sid)

@socketio.on("webrtc-ice-candidate")
def on_webrtc_ice(data):
    room, to = data.get("room"), data.get("to")
    sid = _sid_for(room, to) if room and to else None
    if sid: emit("webrtc-ice-candidate", data, to=sid)

# ---------------- Chat events ----------------
@socketio.on("chat_send")
def on_chat_send(data):
    room = (data or {}).get("room", "").strip()
    user = (data or {}).get("user", "").strip()
    text = (data or {}).get("text", "")
    if not room or not user or not text:
        return
    # must be a current member
    if room not in rooms or user not in rooms[room]["users"]:
        return
    msg = add_chat(room, "user", user, text)
    if msg:
        socketio.emit("chat_message", msg, to=room)

# -------------------------------------------------------------------
# Entrypoint
# -------------------------------------------------------------------
def find_open_port(start: int) -> int:
    import socket
    port = start
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try: s.bind(("0.0.0.0", port))
            except OSError: port += 1; continue
            return port

if __name__ == "__main__":
    req = int(os.environ.get("PORT", "5000"))
    port = req if req > 0 else 5000
    if "PORT" not in os.environ:
        port = find_open_port(port)
    print("\n" + "="*70 + f"\nHububba Calls\n CORS: {allowed}\n Port: {port}\n" + "="*70 + "\n")
    socketio.run(app, host="0.0.0.0", port=port)
