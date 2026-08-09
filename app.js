import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/controls/OrbitControls.js';
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';

const socket=io();
const roomFromPath=location.pathname.split('/game/')[1];
let gameId=roomFromPath||location.hash.replace('#game=','');
let color=null, chess=new Chess(), selected=null, localStream=null, pc=null;
const rtc={iceServers:[{urls:'stun:stun.l.google.com:19302'}]};
const boardEl=document.getElementById('three');

if(!gameId){
  const r=await fetch('/api/games',{method:'POST'});
  const d=await r.json();
  gameId=d.gameId;
  history.replaceState({},'',`/game/${gameId}`);
}
document.getElementById('roomLabel').textContent=`Room ${gameId}`;

const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(38,boardEl.clientWidth/boardEl.clientHeight,.1,100);
camera.position.set(0,9.5,10.5);
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(boardEl.clientWidth,boardEl.clientHeight);
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.outputColorSpace=THREE.SRGBColorSpace;
boardEl.appendChild(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=true;controls.minDistance=8;controls.maxDistance=16;controls.maxPolarAngle=Math.PI/2.15;

scene.add(new THREE.HemisphereLight(0xdce7ff,0x12131f,2));
const key=new THREE.DirectionalLight(0xffffff,4);
key.position.set(-5,12,7);key.castShadow=true;key.shadow.mapSize.set(2048,2048);scene.add(key);
const glow=new THREE.PointLight(0x8977ff,7,25);glow.position.set(-6,4,-5);scene.add(glow);
const glow2=new THREE.PointLight(0x42d9ff,5,20);glow2.position.set(7,3,4);scene.add(glow2);

const board=new THREE.Group();scene.add(board);
const lightMat=new THREE.MeshPhysicalMaterial({color:0xe0e7ef,roughness:.35,metalness:.08});
const darkMat=new THREE.MeshPhysicalMaterial({color:0x343b49,roughness:.28,metalness:.12});
for(let r=0;r<8;r++)for(let c=0;c<8;c++){
  const m=new THREE.Mesh(new THREE.BoxGeometry(1,.25,1),(r+c)%2?darkMat:lightMat);
  m.position.set(c-3.5,0,r-3.5);m.receiveShadow=true;m.userData={r,c};board.add(m);
}
const frame=new THREE.Mesh(new THREE.BoxGeometry(8.65,.55,8.65),new THREE.MeshPhysicalMaterial({color:0x141827,metalness:.7,roughness:.18,clearcoat:1}));
frame.position.y=-.25;frame.receiveShadow=true;board.add(frame);

const pieceGroup=new THREE.Group();scene.add(pieceGroup);
const pieceMeshes=new Map();

function makePiece(type,side){
  const g=new THREE.Group();
  const mat=new THREE.MeshPhysicalMaterial({color:side==='w'?0xf2f4f7:0x0f1118,metalness:.35,roughness:.2,clearcoat:1});
  const base=new THREE.Mesh(new THREE.CylinderGeometry(.30,.43,.18,32),mat);base.position.y=.15;g.add(base);
  const body=new THREE.Mesh(new THREE.CylinderGeometry(.16,.27,.65,32),mat);body.position.y=.56;g.add(body);
  if(type==='p'){
    const h=new THREE.Mesh(new THREE.SphereGeometry(.24,32,32),mat);h.position.y=1.02;g.add(h);
  }else{
    const cap=new THREE.Mesh(new THREE.CylinderGeometry(.28,.20,.25,32),mat);cap.position.y=1.04;g.add(cap);
    const crown=new THREE.Mesh(new THREE.SphereGeometry(.20,24,24),mat);crown.position.y=1.28;g.add(crown);
  }
  g.scale.setScalar(.82);
  g.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true}});
  return g;
}
function sync3D(){
  for(const p of pieceMeshes.values())pieceGroup.remove(p);
  pieceMeshes.clear();
  const boardState=chess.board();
  for(let r=0;r<8;r++)for(let c=0;c<8;c++){
    const p=boardState[r][c]; if(!p)continue;
    const mesh=makePiece(p.type,p.color);
    mesh.position.set(c-3.5,.15,r-3.5);
    mesh.userData={r,c,square:`${String.fromCharCode(97+c)}${8-r}`};
    pieceGroup.add(mesh);pieceMeshes.set(mesh.userData.square,mesh);
  }
}
sync3D();

const ray=new THREE.Raycaster(), pointer=new THREE.Vector2();
renderer.domElement.addEventListener('pointerdown',e=>{
  const rect=renderer.domElement.getBoundingClientRect();
  pointer.x=((e.clientX-rect.left)/rect.width)*2-1;
  pointer.y=-((e.clientY-rect.top)/rect.height)*2+1;
  ray.setFromCamera(pointer,camera);
  const hits=ray.intersectObjects(pieceGroup.children,true);
  if(hits.length){
    let o=hits[0].object;while(o.parent&&o.parent!==pieceGroup)o=o.parent;
    if(o.userData.square){
      const sq=o.userData.square;
      const p=chess.get(sq);
      if(p&&p.color===color) selected=sq;
    }
    return;
  }
  const squares=ray.intersectObjects(board.children,false).filter(x=>x.object.userData.square===undefined&&x.object.userData.r!==undefined);
  if(!selected||!squares.length)return;
  const {r,c}=squares[0].object.userData;
  const to=`${String.fromCharCode(97+c)}${8-r}`;
  socket.emit('game:move',{gameId,from:selected,to,promotion:'q'});
  selected=null;
});

socket.emit('game:join',{gameId,name:'Supernova'});
socket.on('game:state',s=>{color=s.color||'w';try{chess.load(s.fen)}catch{}sync3D()});
socket.on('game:move',s=>{try{chess.load(s.fen)}catch{}sync3D()});
socket.on('game:error',e=>console.warn(e.message));

function addMessage(text,mine){
  const d=document.createElement('div');d.className='message'+(mine?' mine':'');d.textContent=text;
  document.getElementById('messages').appendChild(d);
  document.getElementById('messages').scrollTop=999999;
}
document.getElementById('chatForm').onsubmit=e=>{
  e.preventDefault();const i=document.getElementById('chatInput');const t=i.value.trim();if(!t)return;
  socket.emit('chat:send',{gameId,message:t});i.value='';
};
socket.on('chat:message',m=>addMessage(m.message,m.sender===socket.id));

document.getElementById('share').onclick=async()=>{
  const url=location.origin+`/game/${gameId}`;
  await navigator.clipboard.writeText(url);alert('Game link copied');
};

async function openMedia(video){
  localStream=await navigator.mediaDevices.getUserMedia({audio:true,video});
  document.getElementById('localVideo').srcObject=localStream;
  document.getElementById('callWindow').classList.add('open');
}
async function makePeer(target){
  pc=new RTCPeerConnection(rtc);
  localStream?.getTracks().forEach(t=>pc.addTrack(t,localStream));
  pc.ontrack=e=>document.getElementById('remoteVideo').srcObject=e.streams[0];
  pc.onicecandidate=e=>{if(e.candidate)socket.emit('call:ice',{target,candidate:e.candidate})};
}
document.getElementById('audioCall').onclick=()=>openMedia(false);
document.getElementById('videoCall').onclick=()=>openMedia(true);
document.getElementById('screen').onclick=async()=>{
  const s=await navigator.mediaDevices.getDisplayMedia({video:true});
  const t=s.getVideoTracks()[0];
  const sender=pc?.getSenders().find(x=>x.track?.kind==='video');
  if(sender)await sender.replaceTrack(t);
  t.onended=()=>console.log('screen share ended');
};
document.getElementById('endCall').onclick=()=>{
  localStream?.getTracks().forEach(t=>t.stop());pc?.close();pc=null;
  document.getElementById('callWindow').classList.remove('open');
};
document.getElementById('mute').onclick=()=>{
  localStream?.getAudioTracks().forEach(t=>t.enabled=!t.enabled);
};
document.getElementById('camera').onclick=()=>{
  localStream?.getVideoTracks().forEach(t=>t.enabled=!t.enabled);
};
document.getElementById('newGame').onclick=async()=>{
  const r=await fetch('/api/games',{method:'POST'});const d=await r.json();location.href=d.url;
};
document.getElementById('draw').onclick=()=>alert('Draw offer requires the authenticated game protocol.');
document.getElementById('resign').onclick=()=>alert('Resignation requires the authenticated game protocol.');

addEventListener('resize',()=>{
  const w=boardEl.clientWidth,h=boardEl.clientHeight;
  camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h);
});
renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera)});
