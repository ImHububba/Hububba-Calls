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

// Chat
const chatEl = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const chatSend = document.getElementById("chatSend");

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
  disable(chatInput, !joined); disable(chatSend, !joined);
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

elTakeOver?.addEventListener("click", ()=> tryJoin(true));

elLeave.addEventListener("click", ()=> {
  socket.emit("leave");
  cleanupAfterLeave();
});

function cleanupAfterLeave(){
  cleanupAllPeers();
  myRoom=""; currentOwner=""; elRoomTitle.textContent="No room"; elTimer.textContent="";
  if (timerHandle){ clearInterval(timerHandle); timerHandle=null; }
  updateButtonsJoined(false); myName=""; renderMeName();
  elConflictRow && (elConflictRow.style.display = "none");
  chatEl.innerHTML=""; // clear chat
}

// ---------------------------
// Mute / Cam / ShareScreen
// ---------------------------
let audioMuted=false, camHidden=false;
elMute.addEventListener("click", ()=>{ audioMuted=!audioMuted; localStream?.getAudioTracks().forEach(t=>t.enabled=!audioMuted); elMute.textContent=audioMuted?"Unmute":"Mute"; });
elCam.addEventListener("click",  ()=>{ camHidden=!camHidden;   localStream?.getVideoTracks().forEach(t=>t.enabled=!camHidden);   elCam.textContent=camHidden?"Show Cam":"Hide Cam"; });
elShare.addEventListener("click", async ()=>{
  if (!myRoom) return;
  try{
    if(!screenStream){
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false });
      for (const {pc} of peers.values()){
        const senders = pc.getSenders().filter(s=>s.track && s.track.kind==="video");
        if (senders[0]) senders[0].replaceTrack(screenStream.getVideoTracks()[0]);
      }
      elShare.textContent="Stop Share";
      screenStream.getVideoTracks()[0].addEventListener("ended", ()=>{
        for (const {pc} of peers.values()){
          const cam = localStream?.getVideoTracks()[0];
          const senders = pc.getSenders().filter(s=>s.track && s.track.kind==="video");
          if (cam && senders[0]) senders[0].replaceTrack(cam);
        }
        elShare.textContent="Share Screen"; screenStream=null;
      });
    }else{
      screenStream.getTracks().forEach(t=>t.stop()); screenStream=null; elShare.textContent="Share Screen";
    }
  }catch(e){ console.error("share failed", e); }
});

// ---------------------------
// Keep server state fresh
// ---------------------------
setInterval(()=> socket.emit("heartbeat",{}), 5_000);
setInterval(()=> socket.emit("request_rooms"), 7_000); // avoid stale room list

// ---------------------------
// WebRTC signaling
// ---------------------------
function makePC(forUser, initiator){
  const p = new RTCPeerConnection(rtcConfig);
  localStream?.getTracks().forEach(t=>p.addTrack(t, localStream));
  p.ontrack = (ev)=>{
    const v = addPeerCard(forUser);
    const stream = ev.streams[0];
    if (v.srcObject !== stream) v.srcObject = stream;
    // Set up remote VAD glow
    const obj = peers.get(forUser);
    try{ obj.stopVAD && obj.stopVAD(); }catch{}
    try{ obj.stopVAD = createVAD(stream, obj.wrap); }catch{}
  };
  p.onicecandidate = (ev)=>{
    if (!ev.candidate) return;
    socket.emit("webrtc-ice-candidate", { room:myRoom, from:myName, to:forUser, candidate:ev.candidate });
  };
  if (initiator){
    (async ()=>{
      const desc = await p.createOffer();
      await p.setLocalDescription(desc);
      socket.emit("webrtc-offer", { room:myRoom, from:myName, to:forUser, sdp:p.localDescription });
    })();
  }
  peers.get(forUser).pc = p;
  return p;
}

socket.on("webrtc-offer", async (data)=>{
  if (data.to!==myName || data.room!==myRoom) return;
  const from=data.from; if (!peers.has(from)) addPeerCard(from);
  const pc = peers.get(from).pc || makePC(from,false);
  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
  socket.emit("webrtc-answer",{ room:myRoom, from:myName, to:from, sdp:pc.localDescription });
});

socket.on("webrtc-answer", async (data)=>{
  if (data.to!==myName || data.room!==myRoom) return;
  const pc = peers.get(data.from)?.pc; if(!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
});

socket.on("webrtc-ice-candidate", async (data)=>{
  if (data.to!==myName || data.room!==myRoom) return;
  const pc = peers.get(data.from)?.pc; if(!pc) return;
  try{ await pc.addIceCandidate(data.candidate); }catch{}
});

// presence
socket.on("ready", ({user})=>{
  if(!myRoom || !myName || user===myName) return;
  if(!peers.has(user)) addPeerCard(user);
  const pc = peers.get(user).pc || makePC(user,true);
});
socket.on("peer_left", ({user})=> removePeerCard(user));

// server meta
socket.on("joined", (data)=>{
  myName = fmt(elName.value);
  myRoom = data.room;
  currentOwner = data.owner || "";
  elRoomTitle.textContent = `Room: ${myRoom}`;
  renderMeName();
  setTimerStart(data.created);

  // rebuild peers list from server truth
  peersGrid.innerHTML=""; cleanupAllPeers();
  for (const u of data.users){
    if (u !== myName) addPeerCard(u);
  }
  updateButtonsJoined(true);
  elConflictRow && (elConflictRow.style.display = "none");

  refreshAdminControls();
  socket.emit("request_rooms");

  // load chat history
  chatEl.innerHTML = "";
  (data.chat || []).forEach(renderChatMessage);
  scrollChatToBottom();
});

socket.on("owner_changed", ({room, owner})=>{
  if (room !== myRoom) return;
  currentOwner = owner || "";
  refreshAdminControls();
  toast(owner ? `Operator: ${owner}` : "No operator");
});

// conflicts / kicks
socket.on("join_error", (e)=> showError(e.msg || "Unable to join"));
socket.on("join_conflict", ({msg})=>{
  showError(msg || "Name already in room");
  elConflictRow && (elConflictRow.style.display = "flex");
});
socket.on("kick_result", (res)=> {
  if(res.ok){ toast(`Removed "${res.target}"`); socket.emit("request_rooms"); }
  else { showError(res.msg || "Kick failed"); }
});
socket.on("kicked", (info = {})=>{
  const reason = info.reason === "admin" ? `by ${info.by || "admin"}` : "due to duplicate session";
  showError(`You have been kicked from the room ${reason}.`);
  cleanupAfterLeave();
  socket.emit("request_rooms");
});

// rooms list
socket.on("rooms_update", (rooms)=> {
  elRooms.innerHTML="";
  rooms.forEach(r=>{
    const li=document.createElement("li");
    const users = r.users.length?` — ${r.users.join(", ")}`:"";
    li.innerHTML = `<b>${r.name}</b> (${r.users.length})${users}`;
    elRooms.appendChild(li);
  });
});

// ---------------------------
// Chat UI
// ---------------------------
function tsToTime(ts){
  try{
    const d = new Date(ts*1000);
    return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  }catch{ return ""; }
}

function renderChatMessage(m){
  const isMe = m.user && myName && m.user === myName;
  const row = document.createElement("div");
  row.className = "msg" + (m.type === "system" ? " system" : isMe ? " me" : "");
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (m.type === "system"){
    bubble.textContent = `• ${m.text}`;
  } else {
    const meta = document.createElement("div");
    meta.className = "meta";
    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = m.user || "unknown";
    // OP badge next to name if current owner (dynamic)
    if (currentOwner && m.user === currentOwner){
      const badge = document.createElement("span");
      badge.className = "op";
      badge.textContent = "(OP)";
      nameEl.appendChild(badge);
    }
    const timeEl = document.createElement("span");
    timeEl.textContent = " • " + tsToTime(m.ts);
    meta.appendChild(nameEl);
    meta.appendChild(timeEl);

    const body = document.createElement("div");
    body.textContent = m.text;

    bubble.appendChild(meta);
    bubble.appendChild(body);
  }

  row.appendChild(bubble);
  chatEl.appendChild(row);
}

function scrollChatToBottom(){
  chatEl.scrollTop = chatEl.scrollHeight;
}

chatSend.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e)=>{
  if (e.key === "Enter" && !e.shiftKey){
    e.preventDefault(); sendChat();
  }
});

function sendChat(){
  const txt = fmt(chatInput.value);
  if (!txt || !myRoom || !myName) return;
  socket.emit("chat_send", { room: myRoom, user: myName, text: txt });
  chatInput.value = "";
}

socket.on("chat_message", (m)=>{
  // ignore if not our room
  if (m.room && myRoom && m.room !== myRoom) return;
  renderChatMessage(m);
  scrollChatToBottom();
});

// ---------------------------
// Share Invite Modal
// ---------------------------
function openShareModal(){
  const who  = fmt(elName.value) || myName || "Someone";
  const room = fmt(elRoom.value) || myRoom;
  if(!room){ showError("Enter a room first"); return; }
  shareWho.textContent = who;
  shareCode.textContent = room;
  shareModal.classList.add("open");
  shareModal.setAttribute("aria-hidden","false");
}
function closeShareModal(){
  shareModal.classList.remove("open");
  shareModal.setAttribute("aria-hidden","true");
}
elShareInvite.addEventListener("click", openShareModal);
shareClose.addEventListener("click", closeShareModal);
shareModal.addEventListener("click", (e)=>{ if(e.target.dataset.close) closeShareModal(); });
shareCopy.addEventListener("click", async ()=>{
  const who  = shareWho.textContent;
  const room = shareCode.textContent;
  const url  = `${location.origin}/?room=${encodeURIComponent(room)}`;
  const text = `${who} invites you to join a room!\n${room}\n${url}`;
  try{ await navigator.clipboard.writeText(text); toast("Invite copied"); }catch{}
});

// ---------------------------
// Query params -> hydrate
// ---------------------------
(function(){
  const p=new URLSearchParams(location.search);
  const qRoom=p.get("room"); const qName=p.get("name");
  if(qRoom) elRoom.value=qRoom;
  if(qName) elName.value=qName;
})();

// Initial fetch
socket.emit("request_rooms");
