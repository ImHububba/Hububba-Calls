// Socket
const socket = io({ transports: ["websocket"] });

// UI
const elName = document.getElementById("displayName");
const elRoom = document.getElementById("roomInput");
const elJoin = document.getElementById("btnJoin");
const elLeave = document.getElementById("btnLeave");
const elMute = document.getElementById("btnMute");
const elCam  = document.getElementById("btnCam");
const elShare= document.getElementById("btnShare");
const elShareInvite = document.getElementById("btnShareInvite");
const elRooms= document.getElementById("roomsList");
const elErr  = document.getElementById("errorBox");
const elConflictRow = document.getElementById("conflictRow");
const elKickGhost = document.getElementById("btnKickGhost");

const elRoomTitle = document.getElementById("roomTitle");
const elTimer = document.getElementById("roomTimer");

const localVideo = document.getElementById("localVideo");
const meName = document.getElementById("meName");
const peersGrid = document.getElementById("peers");

const toastEl = document.getElementById("toast");

// State
let myName = "";
let myRoom = "";
let roomCreatedTs = 0;
let timerHandle = null;
let pendingConflict = null;

let localStream = null;
let screenStream = null;

// peers: name -> { pc, videoEl, wrap }
const peers = new Map();

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

// Helpers
const fmt = (s) => (s == null ? "" : String(s).trim());
const disable = (el, v) => (el.disabled = !!v);

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 1400);
}

function setTimerStart(ts) {
  roomCreatedTs = ts;
  if (timerHandle) clearInterval(timerHandle);
  const tick = () => {
    const elapsed = Math.max(0, Math.floor(Date.now()/1000 - roomCreatedTs));
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    elTimer.textContent = `• Live ${mm}:${ss}`;
  };
  tick();
  timerHandle = setInterval(tick, 1000);
}

function showError(msg) {
  elErr.style.display = "block";
  elErr.textContent = msg;
  setTimeout(() => (elErr.style.display = "none"), 3500);
}

function addPeerCard(name) {
  if (peers.has(name)) return peers.get(name).videoEl;

  const wrap = document.createElement("div");
  wrap.className = "peer";
  const v = document.createElement("video");
  v.autoplay = true; v.playsInline = true;
  const label = document.createElement("div");
  label.className = "name-label";
  label.textContent = name;

  wrap.appendChild(v);
  wrap.appendChild(label);
  peersGrid.appendChild(wrap);

  peers.set(name, { pc: null, videoEl: v, wrap });
  return v;
}

function removePeerCard(name) {
  const p = peers.get(name);
  if (!p) return;
  try { p.pc && p.pc.close(); } catch {}
  if (p.wrap?.parentNode) p.wrap.parentNode.removeChild(p.wrap);
  peers.delete(name);
}

function updateButtonsJoined(joined) {
  disable(elJoin, joined);
  disable(elLeave, !joined);
  disable(elMute, !joined);
  disable(elCam, !joined);
  disable(elShare, !joined);
}

// Start preview immediately
async function startPreview() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 1280, height: 720 } });
    localVideo.srcObject = localStream;
  } catch (e) {
    console.error("getUserMedia failed", e);
    showError("Camera/Mic blocked. Allow permissions.");
  }
}
startPreview();
meName.textContent = "(not joined)";

// Join / Leave
elJoin.addEventListener("click", () => {
  const n = fmt(elName.value);
  const r = fmt(elRoom.value);
  if (!n) return showError("Enter a display name");
  if (!r) return showError("Enter a room name");
  pendingConflict = null;
  socket.emit("join", { room: r, user: n });
});

elLeave.addEventListener("click", () => {
  socket.emit("leave");
  cleanupAfterLeave();
});

function cleanupAfterLeave() {
  for (const [name, obj] of peers.entries()) {
    try { obj.pc && obj.pc.close(); } catch {}
    if (obj.wrap?.parentNode) obj.wrap.parentNode.removeChild(obj.wrap);
  }
  peers.clear();
  myRoom = "";
  elRoomTitle.textContent = "No room";
  elTimer.textContent = "";
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  updateButtonsJoined(false);
  meName.textContent = "(not joined)";
  elConflictRow.style.display = "none";
}

// Mute / Cam / Share
let audioMuted = false;
let camHidden = false;

elMute.addEventListener("click", () => {
  audioMuted = !audioMuted;
  localStream?.getAudioTracks().forEach(t => (t.enabled = !audioMuted));
  elMute.textContent = audioMuted ? "Unmute" : "Mute";
});

elCam.addEventListener("click", () => {
  camHidden = !camHidden;
  localStream?.getVideoTracks().forEach(t => (t.enabled = !camHidden));
  elCam.textContent = camHidden ? "Show Cam" : "Hide Cam";
});

elShare.addEventListener("click", async () => {
  if (!myRoom) return;
  try {
    if (!screenStream) {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      for (const { pc } of peers.values()) {
        const senders = pc.getSenders().filter(s => s.track && s.track.kind === "video");
        if (senders[0]) senders[0].replaceTrack(screenStream.getVideoTracks()[0]);
      }
      elShare.textContent = "Stop Share";
      screenStream.getVideoTracks()[0].addEventListener("ended", () => {
        for (const { pc } of peers.values()) {
          const cam = localStream?.getVideoTracks()[0];
          const senders = pc.getSenders().filter(s => s.track && s.track.kind === "video");
          if (cam && senders[0]) senders[0].replaceTrack(cam);
        }
        elShare.textContent = "Share Screen";
        screenStream = null;
      });
    } else {
      screenStream.getTracks().forEach(t => t.stop());
      screenStream = null;
      elShare.textContent = "Share Screen";
    }
  } catch (e) {
    console.error("share failed", e);
  }
});

// Heartbeat to keep last_seen fresh
setInterval(() => socket.emit("heartbeat", {}), 8_000);

// Signaling
function makePC(forUser, initiator) {
  const p = new RTCPeerConnection(rtcConfig);
  localStream?.getTracks().forEach(t => p.addTrack(t, localStream));

  p.ontrack = (ev) => {
    const v = addPeerCard(forUser);
    if (v.srcObject !== ev.streams[0]) v.srcObject = ev.streams[0];
  };
  p.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    socket.emit("webrtc-ice-candidate", {
      room: myRoom, from: myName, to: forUser, candidate: ev.candidate
    });
  };

  if (initiator) {
    (async () => {
      const desc = await p.createOffer();
      await p.setLocalDescription(desc);
      socket.emit("webrtc-offer", { room: myRoom, from: myName, to: forUser, sdp: p.localDescription });
    })();
  }
  peers.get(forUser).pc = p;
  return p;
}

socket.on("webrtc-offer", async (data) => {
  if (data.to !== myName || data.room !== myRoom) return;
  const from = data.from;
  if (!peers.has(from)) addPeerCard(from);
  const pc = peers.get(from).pc || makePC(from, false);
  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("webrtc-answer", { room: myRoom, from: myName, to: from, sdp: pc.localDescription });
});

socket.on("webrtc-answer", async (data) => {
  if (data.to !== myName || data.room !== myRoom) return;
  const from = data.from;
  const pc = peers.get(from)?.pc;
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
});

socket.on("webrtc-ice-candidate", async (data) => {
  if (data.to !== myName || data.room !== myRoom) return;
  const from = data.from;
  const pc = peers.get(from)?.pc;
  if (!pc) return;
  try { await pc.addIceCandidate(data.candidate); } catch {}
});

// New user ready
socket.on("ready", ({ user }) => {
  if (!myRoom || !myName || user === myName) return;
  if (!peers.has(user)) addPeerCard(user);
  const pc = peers.get(user).pc || makePC(user, true);
});

// Peer left
socket.on("peer_left", ({ user }) => {
  removePeerCard(user);
});

// Server meta
socket.on("joined", (data) => {
  myName = fmt(elName.value);
  myRoom = data.room;
  elRoomTitle.textContent = `Room: ${myRoom}`;
  meName.textContent = myName;
  setTimerStart(data.created);
  for (const u of data.users) {
    if (u !== myName) addPeerCard(u);
  }
  updateButtonsJoined(true);
  elConflictRow.style.display = "none";
});

socket.on("join_error", (e) => {
  showError(e.msg || "Unable to join");
});

socket.on("join_conflict", ({ room, user, msg }) => {
  pendingConflict = { room, user };
  showError(msg || `Name "${user}" is already in room`);
  elConflictRow.style.display = "flex";
});

elKickGhost.addEventListener("click", () => {
  if (!pendingConflict) return;
  socket.emit("kick_user", { room: pendingConflict.room, target: pendingConflict.user });
});

socket.on("kick_result", (res) => {
  if (res.ok) {
    toast(`Removed "${res.target}"`);
    elConflictRow.style.display = "none";
    // try joining again shortly
    setTimeout(() => elJoin.click(), 200);
  } else {
    showError(res.msg || "Kick failed");
  }
});

socket.on("rooms_update", (rooms) => {
  elRooms.innerHTML = "";
  rooms.forEach(r => {
    const li = document.createElement("li");
    const users = r.users.length ? ` — ${r.users.join(", ")}` : "";
    li.innerHTML = `<b>${r.name}</b> (${r.users.length})${users}`;
    elRooms.appendChild(li);
  });
});

// Share Invite
elShareInvite.addEventListener("click", async () => {
  const r = fmt(elRoom.value) || myRoom || "";
  if (!r) { showError("Enter a room first"); return; }
  const url = `${window.location.origin}/?room=${encodeURIComponent(r)}`;
  const text = `Join me on HububbaCalls in room "${r}" — ${url}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: "HububbaCalls Invite", text, url });
    } else {
      await navigator.clipboard.writeText(text);
      toast("Invite copied");
    }
  } catch {
    try { await navigator.clipboard.writeText(text); toast("Invite copied"); }
    catch {}
  }
});

// Parse ?room=&name= on load
(function hydrateFromQuery(){
  const p = new URLSearchParams(window.location.search);
  const qRoom = p.get("room"); const qName = p.get("name");
  if (qRoom) elRoom.value = qRoom;
  if (qName) elName.value = qName;
})();

// Initial fetch
socket.emit("request_rooms");
