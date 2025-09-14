import os
import time
import threading
from urllib.parse import urlparse

from flask import Flask, send_from_directory, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room

# NEW: for embed fetching
import requests
from bs4 import BeautifulSoup

ROOT = os.path.dirname(os.path.abspath(__file__))
app = Flask(
    __name__,
    static_folder=os.path.join(ROOT, "static"),
    static_url_path="/static",
)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev")

allowed = os.environ.get("ALLOWED_ORIGINS", "*")
socketio = SocketIO(app, cors_allowed_origins=allowed, async_mode="eventlet")

# Tunables
GRACE_SECONDS  = int(os.environ.get("DISCONNECT_GRACE_SECONDS", "5"))
STALE_SECONDS  = int(os.environ.get("DUPLICATE_STALE_SECONDS", "2"))
CHAT_MAX       = int(os.environ.get("CHAT_MAX", "200"))
CHAT_TRIM_TO   = int(os.environ.get("CHAT_TRIM_TO", "160"))

# ---- Simple embed cache ----
EMBED_CACHE = {}
EMBED_TTL   = int(os.environ.get("EMBED_TTL", "600"))  # 10 minutes

# -------------------------------------------------------------------
# In-memory room state
# -------------------------------------------------------------------
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
    if room not in rooms: return
    v = rooms[room]
    owner = v.get("owner")
    if owner and owner in v["users"]:  # still valid
        return
    if not v["users"]:
        v["owner"] = None
        return
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
    if room not in rooms: return
    text = (text or "")[:500]
    msg = {"ts": int(now()), "type": mtype, "user": user, "text": text, "room": room}
    rooms[room]["chat"].append(msg)
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

# ---------- NEW: embed preview endpoint ----------
@app.get("/embed")
def embed_preview():
    """Return metadata for imhububba links to render chat embeds."""
    url = (request.args.get("url") or "").strip()
    if not url:
        return jsonify({"ok": False, "error": "missing_url"}), 400

    try:
        p = urlparse(url)
        if p.scheme not in ("http", "https"):
            return jsonify({"ok": False, "error": "bad_scheme"}), 400
        host = (p.hostname or "").lower()
        # Restrict to Hububba host(s)
        if not (host.endswith("i.imhububba.com") or host.endswith("imhububba.com")):
            return jsonify({"ok": False, "error": "domain_not_allowed"}), 403

        cached = EMBED_CACHE.get(url)
        if cached and (now() - cached["_ts"] < EMBED_TTL):
            payload = cached.copy(); payload.pop("_ts", None)
            return jsonify({"ok": True, **payload})

        sess = requests.Session()
        sess.headers.update({"User-Agent": "HububbaCalls-Embed/1.0"})
        meta = {"source": url, "domain": host}

        # Try HEAD first (for direct images)
        try:
            h = sess.head(url, timeout=4, allow_redirects=True)
        except Exception:
            h = None

        if h is not None:
            ct = (h.headers.get("content-type") or "").split(";")[0].strip()
            cl = h.headers.get("content-length")
            size = None
            try:
                size = int(cl) if cl and cl.isdigit() else None
            except Exception:
                size = None

            meta.update({"content_type": ct, "bytes": size})

            if ct.startswith("image/"):
                # Direct image link; we can embed immediately
                meta.update({
                    "type": "image",
                    "title": os.path.basename(p.path) or "Image",
                    "image": url
                })
                EMBED_CACHE[url] = {**meta, "_ts": now()}
                return jsonify({"ok": True, **meta})

        # Otherwise fetch HTML & read OpenGraph
        try:
            r = sess.get(url, timeout=6)
            html = r.text[:200_000]
            soup = BeautifulSoup(html, "html.parser")

            def og(key):
                tag = soup.find("meta", property=f"og:{key}") or soup.find("meta", attrs={"name": f"og:{key}"})
                return (tag.get("content") or "").strip() if tag else None

            title = og("title") or (soup.title.string.strip() if soup.title and soup.title.string else None)
            desc  = og("description")
            image = og("image")
            site  = og("site_name")

            meta.update({
                "type": "html",
                "title": title,
                "description": desc,
                "image": image,
                "site_name": site
            })
        except Exception:
            meta.update({"type": "unknown"})

        EMBED_CACHE[url] = {**meta, "_ts": now()}
        return jsonify({"ok": True, **meta})

    except Exception as e:
        return jsonify({"ok": False, "error": "exception", "detail": str(e)}), 500

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

    if was_empty or rooms[room].get("owner") is None:
        rooms[room]["owner"] = user
        socketio.emit("owner_changed", {"room": room, "owner": user}, to=room)

    sysmsg = add_chat(room, "system", None, f"{user} joined")
    if sysmsg: socketio.emit("chat_message", sysmsg, to=room)

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

    try:
        emit("kicked", {"room": room, "by": meta["user"], "reason": "admin"}, to=ex["sid"])
    except Exception:
        pass
    safe_disconnect(ex["sid"])
    remove_user(room, target, expect_sid=ex["sid"])
    transfer_owner_if_needed(room)
    emit_rooms_update()
    socketio.emit("peer_left", {"user": target}, to=room)
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

@socketio.on("screenshare_state")
def on_screenshare_state(data):
    room = (data or {}).get("room", "").strip()
    user = (data or {}).get("user", "").strip()
    active = bool((data or {}).get("active", False))
    if not room or not user: return
    if room not in rooms or user not in rooms[room]["users"]: return
    socketio.emit("screenshare_state", {"room": room, "user": user, "active": active}, to=room)

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
