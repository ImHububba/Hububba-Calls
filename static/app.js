// elements
const displayNameEl = document.getElementById("displayName");
const roomEl        = document.getElementById("room");
const previewBtn    = document.getElementById("previewBtn");
const joinBtn       = document.getElementById("joinBtn");
const leaveBtn      = document.getElementById("leaveBtn");
const muteBtn       = document.getElementById("muteBtn");
const camBtn        = document.getElementById("camBtn");
const screenBtn     = document.getElementById("screenBtn");
const roomsListEl   = document.getElementById("roomsList");
const participantsEl= document.getElementById("participants");
const localVideo    = document.getElementById("localVideo");
const statusbar     = document.getElementById("statusbar");

// socket (same-origin Flask-SocketIO)
const socket = io({ autoConnect:false });

// rtc
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const pcByPeer = new Map();
let mySid=null, currentRoom=null, localStream=null, micEnabled=true, camEnabled=true;

// ---------- helpers ----------
function showStatus(text, kind="info"){
  const colors = { info:"#a9b2c2", ok:"#2bd27b", warn:"#ffb24e", error:"#ff6b6b" };
  statusbar.textContent = text;
  statusbar.style.color = colors[kind] || colors.info;
  statusbar.style.display = "block";
}
function uiJoined(joined){
  joinBtn.disabled = joined; leaveBtn.disabled = !joined;
  muteBtn.disabled = !localStream; camBtn.disabled = !localStream; screenBtn.disabled = !joined;
  roomEl.disabled  = joined; displayNameEl.disabled = joined;
  joinBtn.textContent = joined ? "Joined" : "Join";
}
function ensurePreviewButtons(){
  const has = !!localStream;
  previewBtn.textContent = has ? "Preview Ready" : "Enable Preview";
  previewBtn.disabled = has;
  muteBtn.disabled = !has;
  camBtn.disabled = !has;
}

// ---------- media ----------
async function startPreview(){
  if (localStream) return;
  try{
    showStatus("Requesting camera & mic…");
    // localhost is HTTPS-exempt; elsewhere use https
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:true });
    localVideo.srcObject = localStream;
    micEnabled = true; camEnabled = true;
    ensurePreviewButtons();
    showStatus("Preview ready. Join any room to connect.", "ok");
  }catch(err){
    console.error(err);
    showStatus("Could not access camera/mic. Check browser permissions.", "error");
  }
}
function setMic(enabled){
  micEnabled = enabled;
  if (localStream) localStream.getAudioTracks().forEach(t=> t.enabled = enabled);
  muteBtn.textContent = enabled ? "Mute" : "Unmute";
  if (currentRoom) socket.emit("status",{ mic: enabled });
}
function setCam(enabled){
  camEnabled = enabled;
  if (localStream) localStream.getVideoTracks().forEach(t=> t.enabled = enabled);
  camBtn.textContent = enabled ? "Hide Cam" : "Show Cam";
  if (currentRoom) socket.emit("status",{ cam: enabled });
}

// ---------- WebRTC ----------
async function createPC(peerSid){
  const pc = new RTCPeerConnection(rtcConfig);
  pc.onicecandidate = e=>{
    if (e.candidate) socket.emit("signal",{to:peerSid,from:mySid,type:"candidate",payload:e.candidate});
  };
  pc.ontrack = e=>{
    let vid = document.getElementById(`v_${peerSid}`);
    if (!vid){
      vid = document.createElement("video");
      vid.id = `v_${peerSid}`; vid.autoplay = true; vid.playsInline = true;
      vid.style.width = "100%"; vid.style.aspectRatio="16/9"; vid.style.background="#000"; vid.style.borderRadius="12px";
      const row = document.getElementById(`p_${peerSid}`) || participantsEl;
      const wrap = document.createElement("div"); wrap.style.marginTop = "8px"; wrap.appendChild(vid);
      row.appendChild(wrap);
    }
    vid.srcObject = e.streams[0];
  };
  if (localStream) localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));
  pcByPeer.set(peerSid, pc);
  return pc;
}
async function callPeer(peerSid){
  const pc = await createPC(peerSid);
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  socket.emit("signal",{to:peerSid, from:mySid, type:"offer", payload:offer});
}
async function handleOffer(from, offer){
  const pc = await createPC(from);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
  socket.emit("signal",{to:from, from:mySid, type:"answer", payload:ans});
}
async function handleAnswer(from, ans){
  const pc = pcByPeer.get(from); if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(ans));
}
async function handleCandidate(from, cand){
  const pc = pcByPeer.get(from); if (!pc) return;
  try{ await pc.addIceCandidate(new RTCIceCandidate(cand)); }catch(e){ console.error(e); }
}

// ---------- UI events ----------
previewBtn.addEventListener("click", startPreview);

joinBtn.addEventListener("click", async ()=>{
  const room = roomEl.value.trim();
  const name = displayNameEl.value.trim() || "Guest";
  if (!room){ showStatus("Enter a room name.", "warn"); roomEl.focus(); return; }

  joinBtn.textContent = "Joining…";
  joinBtn.disabled = true;

  if (!localStream){
    await startPreview();
    if (!localStream){ joinBtn.textContent = "Join"; joinBtn.disabled = false; return; }
  }

  if (!socket.connected){
    socket.connect(); // same-origin
    showStatus("Connecting to server…");
  }

  socket.emit("set-name",{ name });
  socket.emit("join",{ room, name });
});

leaveBtn.addEventListener("click", ()=>{
  if (!currentRoom) return;
  socket.emit("leave",{ room: currentRoom });
  for (const [,pc] of pcByPeer){ pc.close(); }
  pcByPeer.clear();
  participantsEl.innerHTML = "";
  uiJoined(false);
  currentRoom=null; mySid=null;
  showStatus("Left room.", "info");
});

muteBtn.addEventListener("click", ()=> setMic(!micEnabled));
camBtn.addEventListener("click",  ()=> setCam(!camEnabled));

screenBtn.addEventListener("click", async ()=>{
  if (!localStream) return;
  try{
    const screen = await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
    const track = screen.getVideoTracks()[0];
    for (const [,pc] of pcByPeer){
      const s = pc.getSenders().find(x=>x.track && x.track.kind==="video");
      if (s) await s.replaceTrack(track);
    }
    const old = localStream.getVideoTracks()[0];
    if (old){ localStream.removeTrack(old); old.stop(); }
    localStream.addTrack(track); localVideo.srcObject = localStream;
    showStatus("Sharing screen…", "ok");
    track.addEventListener("ended", async ()=>{
      const cam = await navigator.mediaDevices.getUserMedia({video:true});
      const camTrack = cam.getVideoTracks()[0];
      for (const [,pc] of pcByPeer){
        const s = pc.getSenders().find(x=>x.track && x.track.kind==="video");
        if (s) await s.replaceTrack(camTrack);
      }
      const cur = localStream.getVideoTracks()[0];
      if (cur){ localStream.removeTrack(cur); cur.stop(); }
      localStream.addTrack(camTrack); localVideo.srcObject = localStream;
      showStatus("Screen share stopped.", "info");
    });
  }catch(e){
    console.error(e);
    showStatus("Screen share cancelled.", "warn");
  }
});

// ---------- socket events ----------
socket.on("connect", ()=>{ mySid = socket.id; });

socket.on("joined", ({room, you, name})=>{
  mySid = you; currentRoom = room;
  uiJoined(true);
  ensurePreviewButtons();
  showStatus(`Joined “${room}” as ${name}.`, "ok");
  socket.emit("status",{ mic: micEnabled, cam: camEnabled });
});

socket.on("peers", async ({peers, you})=>{
  mySid = you;
  for (const sid of peers) await callPeer(sid);
});

socket.on("peer-left", ({sid})=>{
  const pc = pcByPeer.get(sid); if (pc) pc.close();
  pcByPeer.delete(sid);
  removeParticipant(sid);
});

socket.on("signal", async ({from, type, payload})=>{
  if (from === mySid) return;
  if (type === "offer") await handleOffer(from, payload);
  else if (type === "answer") await handleAnswer(from, payload);
  else if (type === "candidate") await handleCandidate(from, payload);
});

socket.on("rooms", ({rooms})=>{
  renderRooms(rooms);
  if (!currentRoom) return;
  const cur = rooms.find(r=>r.room===currentRoom);
  if (!cur){ participantsEl.innerHTML=""; return; }
  const present = new Set();
  for (const m of cur.members){ upsertParticipant(m); present.add(m.sid); }
  for (const el of Array.from(participantsEl.querySelectorAll(".p-row"))){
    const sid = el.id?.replace("p_",""); if (sid && !present.has(sid)) el.remove();
  }
});

socket.on("member-status", p=> upsertParticipant(p));

socket.on("disconnect", ()=>{
  if (currentRoom){
    uiJoined(false);
    showStatus("Disconnected from server.", "warn");
    currentRoom=null;
  }
});

socket.on("error", (e)=>{
  console.error(e);
  showStatus(e?.message || "Error occurred.", "error");
  uiJoined(false);
  joinBtn.textContent = "Join";
  joinBtn.disabled = false;
});

// ---------- auto-start preview on load ----------
document.addEventListener("DOMContentLoaded", () => {
  startPreview();          // show webcam immediately
  ensurePreviewButtons();  // enable Mute/Hide Cam
});
