import os, socket, sys, json, time
from collections import defaultdict

# .env optional
try:
    from dotenv import load_dotenv
    if os.path.exists(".env"):
        load_dotenv(override=True, verbose=False)
except Exception:
    pass

from flask import Flask, request, send_from_directory, jsonify
from flask_socketio import SocketIO, join_room, leave_room, emit

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*")

app = Flask(__name__, static_folder="static")
socketio = SocketIO(app, cors_allowed_origins=ALLOWED_ORIGINS, async_mode="eventlet")

# presence: rooms -> { sid -> {name, mic, cam, joined_at} }
room_members: dict[str, dict[str, dict]] = defaultdict(dict)
# reverse index: sid -> room
sid_room: dict[str, str] = {}
# sid -> name
sid_name: dict[str, str] = {}

def now_ms():
    return int(time.time() * 1000)

def broadcast_rooms():
    """Send a compact snapshot of all rooms and members to everyone."""
    snapshot = []
    for room, members in room_members.items():
        people = []
        for sid, st in members.items():
            people.append({
                "sid": sid,
                "name": st.get("name") or f"Guest-{sid[:5]}",
                "mic": bool(st.get("mic", True)),
                "cam": bool(st.get("cam", True)),
                "joined_at": st.get("joined_at", now_ms()),
            })
        snapshot.append({
            "room": room,
            "count": len(members),
            "members": people,
        })
    socketio.emit("rooms", {"rooms": snapshot})

@app.route("/")
def root():
    # serve UI
    path = os.path.join(app.static_folder or "static", "index.html")
    if os.path.exists(path):
        return send_from_directory("static", "index.html")
    return "OK", 200

@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory("static", path)

@app.route("/api/rooms")
def api_rooms():
    data = []
    for room, members in room_members.items():
        data.append({
            "room": room,
            "count": len(members),
            "members": [
                {
                    "sid": sid,
                    "name": st.get("name") or f"Guest-{sid[:5]}",
                    "mic": bool(st.get("mic", True)),
                    "cam": bool(st.get("cam", True)),
                    "joined_at": st.get("joined_at", now_ms()),
                } for sid, st in members.items()
            ]
        })
    return jsonify({"rooms": data})

@socketio.on("connect")
def on_connect():
    print(f"[+] connect {request.sid}")

@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    print(f"[-] disconnect {sid}")
    room = sid_room.pop(sid, None)
    if room:
        room_members[room].pop(sid, None)
        if not room_members[room]:
            room_members.pop(room, None)
        socketio.emit("peer-left", {"sid": sid}, room=room)
    sid_name.pop(sid, None)
    broadcast_rooms()

@socketio.on("set-name")
def on_set_name(data):
    name = (data or {}).get("name", "").strip()
    if not name:
        return
    sid = request.sid
    sid_name[sid] = name
    room = sid_room.get(sid)
    if room and sid in room_members[room]:
        room_members[room][sid]["name"] = name
        broadcast_rooms()

@socketio.on("join")
def on_join(data):
    room = (data or {}).get("room", "").strip()
    name = (data or {}).get("name", "").strip()
    if not room:
        emit("error", {"message": "Room required"})
        return

    sid = request.sid
    join_room(room)
    sid_room[sid] = room
    if name:
        sid_name[sid] = name

    room_members[room][sid] = {
        "name": sid_name.get(sid) or f"Guest-{sid[:5]}",
        "mic": True,
        "cam": True,
        "joined_at": now_ms(),
    }
    others = [other for other in room_members[room].keys() if other != sid]
    emit("peers", {"peers": others, "you": sid}, to=sid)
    # NEW: immediate confirmation so client can update UI
    emit("joined", {"room": room, "you": sid, "name": room_members[room][sid]["name"]}, to=sid)

    print(f"[room:{room}] {sid} joined; {len(room_members[room])} member(s)")
    broadcast_rooms()

@socketio.on("leave")
def on_leave(data):
    sid = request.sid
    room = sid_room.pop(sid, None)
    if not room:
        return
    if sid in room_members[room]:
        room_members[room].pop(sid, None)
    leave_room(room)
    socketio.emit("peer-left", {"sid": sid}, room=room)
    if not room_members[room]:
        room_members.pop(room, None)
    print(f"[room:{room}] {sid} left; {len(room_members.get(room, {}))} member(s)")
    broadcast_rooms()

@socketio.on("status")
def on_status(data):
    sid = request.sid
    mic = (data or {}).get("mic")
    cam = (data or {}).get("cam")
    room = sid_room.get(sid)
    if not room:
        return
    st = room_members[room].get(sid) or {}
    if mic is not None:
        st["mic"] = bool(mic)
    if cam is not None:
        st["cam"] = bool(cam)
    st["name"] = sid_name.get(sid) or st.get("name") or f"Guest-{sid[:5]}"
    room_members[room][sid] = st
    socketio.emit("member-status", {
        "sid": sid,
        "name": st["name"],
        "mic": st.get("mic", True),
        "cam": st.get("cam", True),
    }, room=room)
    broadcast_rooms()

@socketio.on("signal")
def on_signal(data):
    target = (data or {}).get("to")
    if not target:
        return
    socketio.emit("signal", data, to=target)

# ---------- port helpers ----------
def is_port_free(host: str, port: int) -> bool:
    import socket as pysock
    with pysock.socket(pysock.AF_INET, pysock.SOCK_STREAM) as s:
        s.setsockopt(pysock.SOL_SOCKET, pysock.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False

def find_open_port(start_port: int, host: str = "0.0.0.0", max_increments: int = 100) -> int:
    for offset in range(0, max_increments + 1):
        candidate = start_port + offset
        if is_port_free(host, candidate):
            return candidate
    raise RuntimeError(f"No free port found from {start_port} to {start_port + max_increments}")

def parse_cli_port(default_port: int) -> int:
    argv = sys.argv[1:]
    for i, arg in enumerate(argv):
        if arg in ("--port", "-p") and i + 1 < len(argv):
            try:
                return int(argv[i + 1])
            except ValueError:
                pass
    return default_port

if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    base_port = parse_cli_port(int(os.getenv("PORT", "5000")))
    chosen_port = find_open_port(base_port, host=host, max_increments=100)

    print("=" * 72)
    print("Hububba Calls (Flask-SocketIO)")
    print(f" CORS: {ALLOWED_ORIGINS}")
    print(f" Host: {host}")
    print(f" Requested: {base_port} -> Using: {chosen_port}")
    print(f" UI:    http://localhost:{chosen_port}")
    print(f" Rooms: GET /api/rooms")
    print("=" * 72)

    socketio.run(app, host=host, port=chosen_port)
