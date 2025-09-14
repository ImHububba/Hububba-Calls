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
const elTakeOver = document.getElementById("btnTakeOver");

const elRoomTitle = document.getElementById("roomTitle");
const elTimer = document.getElementById("roomTimer");
const toastEl = document.getElementById("toast");

// Share modal
const shareModal = document.getElementById("shareModal");
const shareWho   = document.getElementById("shareWho");
const shareCode  = document.getElementById("shareCode");
const shareCopy  = document.getElementById("shareCopy");
const shareClose = document.getElementById("shareClose");

// Video / peers
const localVideo = document.getElementById("localVideo");
const meName = document.getElementById("meName");
const meCard = document.getElementById("meCard");
const peersGrid = document.getElementById("peers");

// State
let myName = "";
let myRoom = "";
let currentOwner = "";
let roomCreatedTs = 0;
let timerHandle = null;

let localStream = null;
let screenStream = null;

// peers: name -> { pc, videoEl, wrap, labelEl, stopVAD? }
const peers = new Map();

const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const isAdmin = () => !!myName && !!currentOwner && myName === currentOwner;

// ---------------------------
// Helpers
// ---------------------------
const fmt = (s) => (s == null ? "" : String(s).trim());
const disable = (el, v) => (el.disabled = !!v);
function toast(msg){ toastEl.textContent = msg; toastEl.classList.add("show"); setTimeout(()=>toastEl.classList.remove("show"), 1400); }
function showError(msg){ elErr.style.display="block"; elErr.textContent=msg; setTimeout(()=>elErr.style.display="none", 3500); }

function setTimerStart(ts){
  roomCreatedTs = ts;
  if (timerHandle) clearInterval(timerHandle);
  const tick = () => {
    const elapsed = Math.max(0, Math.floor(Date.now()/1000 - roomCreatedTs));
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    elTimer.textContent = `• Live ${mm}:${ss}`;
  };
  tick(); timerHandle = setInterval(tick, 1000);
}

function updateButtonsJoined(joined){
  disable(elJoin, joined); disable(elLeave, !joined);
  disable(elMute, !joined); disable(elCam,!joined); disable(elShare,!joined);
}

function applyOpBadge(labelEl, on){
  if (!labelEl) return;
  let tag = labelEl.querySelector(".op");
  if (on){
    if (!tag){
      tag = document.createElement("span");
      tag.className = "op";
      tag.textContent = "(OP)";
      labelEl.appendChild(tag);
    }
  } else {
    if (tag) tag.remove();
  }
}

function renderMeName(){
  meName.textContent = myName || "(not joined)";
  applyOpBadge(meName, isAdmin());
}

function refreshAdminControls(){
  // Toggle kick buttons on peer tiles
  for (const [name,obj] of peers.entries()){
    // never show kick on yourself
    let btn = obj.wrap.querySelector("button.kick");
    if (isAdmin() && name !== myName){
      if (!btn){
        btn = document.createElement("button");
        btn.className = "kick"; btn.textContent = "Kick";
        btn.addEventListener("click", () => socket.emit("kick_user", { room: myRoom, target: name }));
        obj.wrap.appendChild(btn);
      }
    } else {
      if (btn) btn.remove();
    }
    // OP badge on labels
    applyOpBadge(obj.labelEl, name === currentOwner);
  }
  // OP badge on self label
  applyOpBadge(meName, isAdmin());
}

// ---------------------------
// Voice Activity Detection (glow)
// ---------------------------
let audioCtx = null;
function ensureAudioCtx(){
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(()=>{});
  return audioCtx;
}
function createVAD(stream, glowEl){
  const ctx = ensureAudioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const data = new Uint8Array(analyser.frequencyBinCount);
  src.connect(analyser);

  let raf = null;
  let decay = 0;
  const THRESH = 12; // empirical loudness threshold
  const DECAY_RATE = 0.92;

  function loop(){
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i=0;i<data.length;i++) sum += data[i];
    const level = sum / data.length; // 0..255
    decay = Math.max(level, decay * DECAY_RATE);
    if (decay > THRESH) glowEl.classList.add("speaking");
    else glowEl.classList.remove("speaking");
    raf = requestAnimationFrame(loop);
  }
  loop();

  return () => { try{ cancelAnimationFrame(raf); }catch{} try{ src.disconnect(); }catch{} try{ analyser.disconnect(); }catch{} };
}

// ---------------------------
// DOM builders
// ---------------------------
function addPeerCard(name){
  if (peers.has(name)) return peers.get(name).videoEl;

  const wrap = document.createElement("div"); wrap.className="peer";
  const v = document.createElement("video"); v.autoplay=true; v.playsInline=true;
  const label = document.createElement("div"); label.className="name-label"; label.textContent=name;
  wrap.appendChild(v); wrap.appendChild(label);

  peersGrid.appendChild(wrap);
  peers.set(name, { pc:null, videoEl:v, wrap, labelEl:label, stopVAD:null });

  // Add OP badge & kick control if applicable
  applyOpBadge(label, name === currentOwner);
  refreshAdminControls();

  return v;
}

function removePeerCard(name){
  const p = peers.get(name); if(!p) return;
  try{ p.pc && p.pc.close(); }catch{}
  try{ p.stopVAD && p.stopVAD(); }catch{}
  if (p.wrap?.parentNode) p.wrap.parentNode.removeChild(p.wrap);
  peers.delete(name);
}

function cleanupAllPeers(){
  for (const [name,obj] of peers.entries()){
    try{ obj.pc && obj.pc.close(); }catch{}
    try{ obj.stopVAD && obj.stopVAD(); }catch{}
    if (obj.wrap?.parentNode) obj.wrap.parentNode.removeChild(obj.wrap);
  }
  peers.clear();
}

// ---------------------------
// Local preview immediately
// ---------------------------
(async function startPreview(){
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:{ width:1280, height:720 } });
    localVideo.srcObject = localStream;
    try{ const stop = createVAD(localStream, meCard); meCard._stopVAD = stop; }catch{}
  }catch(e){
    console.error("getUserMedia failed", e);
    showError("Camera/Mic blocked. Allow permissions.");
  }
})();
renderMeName();

// ---------------------------
// Join / Leave
// ---------------------------
let lastJoinForce = false;

elJoin.addEventListener("click", ()=> tryJoin(false));
function tryJoin(force){
  const n = fmt(elName.value); const r = fmt(elRoom.value);
  if(!n) return showError("Enter a display name");
  if(!r) return showError("Enter a room name");
  lastJoinForce = !!force;
  socket.emit("join", { room:r, user:n, force: !!force });
}

elTakeOver?.addEventListener("click", ()=> tryJoin(t
