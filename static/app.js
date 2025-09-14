// Socket
const socket = io({ transports: ["websocket"] });

// UI refs
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

const shareModal = document.getElementById("shareModal");
const shareWho   = document.getElementById("shareWho");
const shareCode  = document.getElementById("shareCode");
const shareCopy  = document.getElementById("shareCopy");
const shareClose = document.getElementById("shareClose");

const stage = document.getElementById("stage");

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
let screenActive = false;

const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// Map of remote user -> peerConnection & helpers
const peers = new Map();

// Tiles: displayName -> { wrap, video, label, stopVAD? }
const tiles = new Map();

const isAdmin = () => !!myName && !!currentOwner && myName === currentOwner;

// --------------------------- helpers
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
  if (on){ if (!tag){ tag = document.createElement("span"); tag.className="op"; tag.textContent="(OP)"; labelEl.appendChild(tag); } }
  else { if (tag) tag.remove(); }
}

function refreshOpBadges(){
  for (const [name, tile] of tiles.entries()){
    const pure = name.replace(" (Sharing Screen)","");
    applyOpBadge(tile.label, pure === currentOwner);
  }
}

function refreshKickButtons(){
  for (const [name, tile] of tiles.entries()){
    const isScreen = name.endsWith(" (Sharing Screen)");
    const pure = name.replace(" (Sharing Screen)","");
    let btn = tile.wrap.querySelector("button.kick");
    const shouldShow = isAdmin() && pure !== myName && !isScreen; // no kick on screen tiles
    if (shouldShow){
      if (!btn){
        btn = document.createElement("button");
        btn.className = "kick"; btn.textContent = "Kick";
        btn.addEventListener("click", () => socket.emit("kick_user", { room: myRoom, target: pure }));
        tile.wrap.appendChild(btn);
      }
    } else {
      if (btn) btn.remove();
    }
  }
}

function ensureTile(name){
  if (tiles.has(name)) return tiles.get(name);
  const wrap = document.createElement("div"); wrap.className="tile";
  const v = document.createElement("video"); v.autoplay = true; v.playsInline = true; if (name === myName || name === "You") v.muted = true;
  const label = document.createElement("div"); label.className="name-label"; label.textContent = name;
  wrap.appendChild(v); wrap.appendChild(label);
  stage.appendChild(wrap);
  const t = { wrap, video: v, label, stopVAD: null };
  tiles.set(name, t);
  refreshOpBadges(); refreshKickButtons();
  return t;
}
function removeTile(name){
  const t = tiles.get(name); if (!t) return;
  try{ t.stopVAD && t.stopVAD(); }catch{}
  if (t.wrap?.parentNode) t.wrap.parentNode.removeChild(t.wrap);
  tiles.delete(name);
}
function renameTile(oldName, newName){
  if (oldName === newName) return;
  const t = tiles.get(oldName); if (!t) return;
  tiles.delete(oldName); tiles.set(newName, t);
  t.label.textContent = newName;
  refreshOpBadges(); refreshKickButtons();
}

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
  const THRESH = 12, DECAY_RATE = 0.92;

  function loop(){
    analyser.getByteFrequencyData(data);
    let sum = 0; for (let i=0;i<data.length;i++) sum += data[i];
    const level = sum / data.length;
    decay = Math.max(level, decay * DECAY_RATE);
    if (decay > THRESH) glowEl.classList.add("speaking");
    else glowEl.classList.remove("speaking");
    raf = requestAnimationFrame(loop);
  }
  loop();
  return () => { try{ cancelAnimationFrame(raf); }catch{} try{ src.disconnect(); }catch{} try{ analyser.disconnect(); }catch{} };
}

// --------------------------- preview
(async function startPreview(){
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:{ width:1280, height:720 } });
    const t = ensureTile("You");
    t.video.srcObject = localStream;
    try{ t.stopVAD = createVAD(localStream, t.wrap); }catch{}
  }catch(e){
    console.error("getUserMedia failed", e);
    showError("Camera/Mic blocked. Allow permissions.");
  }
})();

// --------------------------- Join / Leave
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
  for (const p of peers.values()){ try{ p.pc.close(); }catch{} }
  peers.clear();
  for (const name of Array.from(tiles.keys())){
    if (name !== "You") removeTile(name);
  }
  myRoom=""; currentOwner=""; elRoomTitle.textContent="No room"; elTimer.textContent="";
  if (timerHandle){ clearInterval(timerHandle); timerHandle=null; }
  updateButtonsJoined(false); myName="";
  if (tiles.has("You")) applyOpBadge(tiles.get("You").label, false);
  elConflictRow && (elConflictRow.style.display = "none");
  chatEl.innerHTML="";
  screenActive = false; screenStream = null;
}

// --------------------------- Mute / Cam / ShareScreen
let audioMuted=false, camHidden=false;
elMute.addEventListener("click", ()=>{ audioMuted=!audioMuted; localStream?.getAudioTracks().forEach(t=>t.enabled=!audioMuted); elMute.textContent=audioMuted?"Unmute":"Mute"; });
elCam.addEventListener("click",  ()=>{ camHidden=!camHidden;   localStream?.getVideoTracks().forEach(t=>t.enabled=!camHidden);   elCam.textContent=camHidden?"Show Cam":"Hide Cam"; });

elShare.addEventListener("click", async ()=>{
  if (!myRoom) return;
  try{
    if(!screenActive){
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false });
      const screenTrack = screenStream.getVideoTracks()[0];

      const screenName = `${myName} (Sharing Screen)`;
      const tile = ensureTile(screenName);
      tile.video.srcObject = screenStream;

      for (const peer of peers.values()){
        const sender = peer.pc.addTrack(screenTrack, screenStream);
        if (!peer.screenSenders) peer.screenSenders = new Set();
        peer.screenSenders.add(sender);
      }
      screenTrack.addEventListener("ended", stopScreenShare);
      screenActive = true; elShare.textContent = "Stop Share";
      socket.emit("screenshare_state", { room: myRoom, user: myName, active: true });
    } else {
      stopScreenShare();
    }
  }catch(e){ console.error("share failed", e); }
});

function stopScreenShare(){
  if (!screenActive) return;
  try{ screenStream.getTracks().forEach(t=>t.stop()); }catch{}
  for (const peer of peers.values()){
    if (peer.screenSenders){
      for (const s of Array.from(peer.screenSenders)){ try{ peer.pc.removeTrack(s); }catch{} peer.screenSenders.delete(s); }
    }
  }
  removeTile(`${myName} (Sharing Screen)`);
  screenActive = false; elShare.textContent = "Share Screen";
  socket.emit("screenshare_state", { room: myRoom, user: myName, active: false });
}

// --------------------------- Keep state fresh
setInterval(()=> socket.emit("heartbeat",{}), 5_000);
setInterval(()=> socket.emit("request_rooms"), 7_000);

// --------------------------- WebRTC
function makePC(forUser, initiator){
  const pc = new RTCPeerConnection(rtcConfig);
  const info = {
    pc,
    makingOffer:false,
    ignoreOffer:false,
    polite: myName < forUser,
    screenSenders: new Set(),
    cameraStreamId: null
  };
  peers.set(forUser, info);

  localStream?.getTracks().forEach(t=>pc.addTrack(t, localStream));

  pc.ontrack = (ev)=>{
    const stream = ev.streams[0];
    if (ev.track.kind === "video"){
      if (!info.cameraStreamId){
        info.cameraStreamId = stream.id;
        const camTile = ensureTile(forUser);
        if (camTile.video.srcObject !== stream) camTile.video.srcObject = stream;
      } else if (stream.id !== info.cameraStreamId) {
        const scrTile = ensureTile(`${forUser} (Sharing Screen)`);
        if (scrTile.video.srcObject !== stream) scrTile.video.srcObject = stream;
      }
    }
  };

  pc.onicecandidate = (ev)=>{
    if (!ev.candidate) return;
    socket.emit("webrtc-ice-candidate", { room:myRoom, from:myName, to:forUser, candidate:ev.candidate });
  };

  pc.onnegotiationneeded = async ()=>{
    try{
      info.makingOffer = true;
      await pc.setLocalDescription();
      socket.emit("webrtc-offer", { room:myRoom, from:myName, to:forUser, sdp:pc.localDescription });
    }catch(e){ console.warn("negotiationneeded failed", e); }
    finally{ info.makingOffer = false; }
  };

  if (initiator){
    (async ()=>{
      try{
        await pc.setLocalDescription(await pc.createOffer());
        socket.emit("webrtc-offer", { room:myRoom, from:myName, to:forUser, sdp:pc.localDescription });
      }catch(e){ console.error(e); }
    })();
  }
  return pc;
}

socket.on("webrtc-offer", async (data)=>{
  if (data.to!==myName || data.room!==myRoom) return;
  const from = data.from;
  let peer = peers.get(from);
  if (!peer){ const pc = makePC(from, false); peer = peers.get(from); }
  const pc = peer.pc;

  const offer = new RTCSessionDescription(data.sdp);
  const offerCollision = peer.makingOffer || pc.signalingState !== "stable";
  peer.ignoreOffer = !peer.polite && offerCollision;
  if (peer.ignoreOffer) return;

  try{
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    socket.emit("webrtc-answer",{ room:myRoom, from:myName, to:from, sdp:pc.localDescription });
  }catch(e){
    console.error("error applying offer", e);
  }
});

socket.on("webrtc-answer", async (data)=>{
  if (data.to!==myName || data.room!==myRoom) return;
  const from = data.from;
  const pc = peers.get(from)?.pc; if(!pc) return;
  try{ await pc.setRemoteDescription(new RTCSessionDescription(data.sdp)); }catch(e){ console.error("answer setRemote failed", e); }
});

socket.on("webrtc-ice-candidate", async (data)=>{
  if (data.to!==myName || data.room!==myRoom) return;
  const pc = peers.get(data.from)?.pc; if(!pc) return;
  try{ await pc.addIceCandidate(data.candidate); }catch(e){ /* ignore */ }
});

// presence
socket.on("ready", ({user})=>{
  if(!myRoom || !myName || user===myName) return;
  let peer = peers.get(user);
  if (!peer){ const pc = makePC(user,true); }
});
socket.on("peer_left", ({user})=>{
  removeTile(user);
  removeTile(`${user} (Sharing Screen)`);
  const p = peers.get(user);
  if (p){ try{ p.pc.close(); }catch{} peers.delete(user); }
});

// server meta
socket.on("joined", (data)=>{
  myName = fmt(elName.value);
  myRoom = data.room;
  currentOwner = data.owner || "";
  elRoomTitle.textContent = `Room: ${myRoom}`;
  setTimerStart(data.created);

  if (tiles.has("You")) renameTile("You", myName);

  for (const name of Array.from(tiles.keys())){
    if (name !== myName) removeTile(name);
  }
  for (const u of data.users){
    if (u !== myName) ensureTile(u);
  }

  updateButtonsJoined(true);
  elConflictRow && (elConflictRow.style.display = "none");
  refreshOpBadges(); refreshKickButtons();

  socket.emit("request_rooms");

  chatEl.innerHTML = "";
  (data.chat || []).forEach(renderChatMessage);
  scrollChatToBottom();
});

socket.on("owner_changed", ({room, owner})=>{
  if (room !== myRoom) return;
  currentOwner = owner || "";
  refreshOpBadges(); refreshKickButtons();
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

// --------------------------- Chat
function tsToTime(ts){
  try{ const d = new Date(ts*1000); return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
  catch{ return ""; }
}
function renderChatMessage(m){
  const isMe = m.user && myName && m.user === myName;
  const row = document.createElement("div");
  row.className = "msg" + (m.type === "system" ? " system" : isMe ? " me" : "");
  const bubble = document.createElement("div"); bubble.className = "bubble";

  if (m.type === "system"){
    bubble.textContent = `• ${m.text}`;
  } else {
    const meta = document.createElement("div"); meta.className = "meta";
    const nameEl = document.createElement("span"); nameEl.className = "name"; nameEl.textContent = m.user || "unknown";
    if (currentOwner && m.user === currentOwner){ const badge=document.createElement("span"); badge.className="op"; badge.textContent="(OP)"; nameEl.appendChild(badge); }
    const timeEl = document.createElement("span"); timeEl.textContent = " • " + tsToTime(m.ts);
    meta.appendChild(nameEl); meta.appendChild(timeEl);
    const body = document.createElement("div"); body.textContent = m.text;
    bubble.appendChild(meta); bubble.appendChild(body);

    // embeds for hububba links
    const links = extractHububbaLinks(m.text);
    links.forEach(url => addEmbed(bubble, url));
  }
  row.appendChild(bubble); chatEl.appendChild(row);
}
function scrollChatToBottom(){ chatEl.scrollTop = chatEl.scrollHeight; }

chatSend.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e)=>{ if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); sendChat(); } });
function sendChat(){
  const txt = fmt(chatInput.value);
  if (!txt || !myRoom || !myName) return;
  socket.emit("chat_send", { room: myRoom, user: myName, text: txt });
  chatInput.value = "";
}
socket.on("chat_message", (m)=>{ if (m.room && myRoom && m.room !== myRoom) return; renderChatMessage(m); scrollChatToBottom(); });

// --------------------------- Screenshare UI hint
socket.on("screenshare_state", ({room,user,active})=>{
  if (room !== myRoom) return;
  const screenName = `${user} (Sharing Screen)`;
  if (active){ ensureTile(screenName); }
  else { removeTile(screenName); }
});

// --------------------------- Share Invite Modal
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

// --------------------------- Query params hydrate
(function(){
  const p=new URLSearchParams(location.search);
  const qRoom=p.get("room"); const qName=p.get("name");
  if(qRoom) elRoom.value=qRoom;
  if(qName) elName.value=qName;
})();

// Initial
socket.emit("request_rooms");

/* =======================
   EMBED HELPERS
   ======================= */

function extractHububbaLinks(text){
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const all = Array.from(text.matchAll(urlRegex)).map(m=>m[1]);
  return all.filter(u => {
    try{
      const host = new URL(u).hostname.toLowerCase();
      return host.endsWith("i.imhububba.com") || host.endsWith("imhububba.com");
    }catch{ return false; }
  });
}

function humanBytes(b){
  if (!Number.isFinite(b) || b <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let i = 0; let n = b;
  while (n >= 1024 && i < units.length-1){ n/=1024; i++; }
  return `${n.toFixed(n>=10?0:1)} ${units[i]}`;
}

function addEmbed(container, url){
  const box = document.createElement("div");
  box.className = "embed loading";
  box.innerHTML = `
    <div class="embed__row">
      <div class="embed__media"></div>
      <div class="embed__body">
        <div class="embed__title mono">${url}</div>
        <div class="embed__meta">Loading preview…</div>
        <div class="embed__actions" style="display:none;"></div>
      </div>
    </div>
  `;
  container.appendChild(box);

  fetch(`/embed?url=${encodeURIComponent(url)}`)
    .then(r=>r.json())
    .then(data=>{
      box.classList.remove("loading");
      const media = box.querySelector(".embed__media");
      const title = box.querySelector(".embed__title");
      const meta  = box.querySelector(".embed__meta");
      const actions = box.querySelector(".embed__actions");

      if (!data.ok){
        title.textContent = url;
        meta.textContent = "No preview available";
        return;
      }

      title.textContent = data.title || data.site_name || data.domain || "Preview";

      media.innerHTML = "";
      const showImg = data.image && typeof data.image === "string";
      if (data.type === "image"){
        const img = document.createElement("img");
        img.src = data.image || data.source || url;
        media.appendChild(img);
        const sizeTxt = humanBytes(data.bytes);
        meta.textContent = `Image${sizeTxt?` • ${sizeTxt}`:""} • ${data.content_type || ""}`.trim();
      } else if (showImg){
        const img = document.createElement("img");
        img.src = data.image;
        media.appendChild(img);
        meta.textContent = data.site_name ? `${data.site_name} • ${data.domain}` : data.domain;
        if (data.description){
          const d = document.createElement("div");
          d.className = "embed__desc";
          d.textContent = data.description;
          box.querySelector(".embed__body").appendChild(d);
        }
      } else {
        meta.textContent = data.domain || new URL(url).hostname;
      }

      actions.style.display = "flex";
      const openBtn = document.createElement("button");
      openBtn.textContent = "Open";
      openBtn.addEventListener("click", ()=> window.open(url, "_blank", "noopener"));
      const copyBtn = document.createElement("button");
      copyBtn.textContent = "Copy Link";
      copyBtn.addEventListener("click", async ()=> {
        try{ await navigator.clipboard.writeText(url); toast("Link copied"); }catch{}
      });
      actions.appendChild(openBtn); actions.appendChild(copyBtn);
    })
    .catch(()=>{
      box.classList.remove("loading");
      const meta  = box.querySelector(".embed__meta");
      meta.textContent = "Failed to load preview";
    });
}
