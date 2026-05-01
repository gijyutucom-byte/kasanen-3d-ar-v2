// Mura-lab,info 信州大学教育学部 2025/06/27
// https://mura-lab.info/main/

import * as THREE from 'three';
import { STLLoader } from 'https://unpkg.com/three@0.150.0/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.150.0/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'https://unpkg.com/three@0.150.0/examples/jsm/controls/OrbitControls.js';

// ================================================================
// ユーティリティ
// ================================================================
function eachMesh(root, fn) {
  if (!root) return;
  if (root.traverse) root.traverse(o => (o.isMesh||o.isSkinnedMesh||o.isInstancedMesh) && fn(o));
  else if (root.isMesh) fn(root);
}
function forEachMaterial(mesh, fn) {
  if (!mesh.material) return;
  if (Array.isArray(mesh.material)) mesh.material.forEach(fn);
  else fn(mesh.material);
}

// ================================================================
// 木取りアプリ由来：STLを連結成分（部品）に分離する
// ================================================================
const PART_COLORS_HEX = [
  0xdbeafe, 0xfde68a, 0xfecdd3, 0xd1fae5, 0xe9d5ff,
  0xfed7aa, 0xbfdbfe, 0xfbcfe8, 0xfde2e4, 0xddd6fe,
  0xc7f9cc, 0xfaedcd
];

function separateGeometries(geometry) {
  const positions = geometry.attributes.position.array;
  const numTriangles = positions.length / 9;
  const visited = new Array(numTriangles).fill(false);
  const adjacency = new Map();
  const edgeToTriangles = new Map();
  const precision = 1e4;

  for (let i = 0; i < numTriangles; i++) {
    const verts = [];
    for (let j = 0; j < 3; j++) {
      const vi = i * 9 + j * 3;
      const x = Math.round(positions[vi]   * precision) / precision;
      const y = Math.round(positions[vi+1] * precision) / precision;
      const z = Math.round(positions[vi+2] * precision) / precision;
      verts.push(`${x}|${y}|${z}`);
    }
    for (let j = 0; j < 3; j++) {
      const v1 = verts[j], v2 = verts[(j+1)%3];
      const ek = v1 < v2 ? `${v1},${v2}` : `${v2},${v1}`;
      if (!edgeToTriangles.has(ek)) edgeToTriangles.set(ek, []);
      edgeToTriangles.get(ek).push(i);
    }
  }
  for (const tris of edgeToTriangles.values()) {
    if (tris.length === 2) {
      const [a, b] = tris;
      if (!adjacency.has(a)) adjacency.set(a, []);
      if (!adjacency.has(b)) adjacency.set(b, []);
      adjacency.get(a).push(b);
      adjacency.get(b).push(a);
    }
  }
  const result = [];
  for (let i = 0; i < numTriangles; i++) {
    if (!visited[i]) {
      const comp = [], queue = [i];
      visited[i] = true;
      while (queue.length) {
        const cur = queue.shift();
        comp.push(cur);
        for (const nb of (adjacency.get(cur)||[])) {
          if (!visited[nb]) { visited[nb]=true; queue.push(nb); }
        }
      }
      const pos = new Float32Array(comp.length * 9);
      for (let k=0;k<comp.length;k++)
        for (let v=0;v<9;v++) pos[k*9+v]=positions[comp[k]*9+v];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      result.push(g);
    }
  }
  return result;
}

// ================================================================
// 状態
// ================================================================
let wireOn = false;
let originalMaterials = new Map();
let coloredGroup = null;   // 色分け表示用グループ
let isColored    = false;

const dropZone       = document.getElementById('dropZone');
const modelControls  = document.getElementById('modelControls');
const btnLoadModel   = document.getElementById('btnLoadModel');
const modelInput     = document.getElementById('modelInput');
const bgControls     = document.getElementById('bgControls');
const btnToggleWire  = document.getElementById('btnToggleWire');
const btnShowStats   = document.getElementById('btnShowStats');
const statsPanel     = document.getElementById('statsPanel');
const btnColorParts  = document.getElementById('btnColorParts');
const btnCapture     = document.getElementById('btnCapture');
const btnImage       = document.getElementById('btnImage');
const btnCamera      = document.getElementById('btnCamera');
const btnReloadModel = document.getElementById('btnReloadModel');
const btnBackAR      = document.getElementById('btnBackAR');
const btnSwitchCamera= document.getElementById('btnSwitchCamera');
const fileInput      = document.getElementById('fileInput');
const video          = document.getElementById('video');
const canvas         = document.getElementById('arCanvas');

let scene, camera, renderer, controls, current;
let modelMeta = { type: '', generator: '' };
let raycaster, pointer, dragPlane, dragOffset, dragging = false;
let videoDevices=[], currentCameraIndex=0, currentStream=null;

// ================================================================
// Three.js 初期化
// ================================================================
function initThree(w, h) {
  scene    = new THREE.Scene();
  camera   = new THREE.PerspectiveCamera(45, w/h, 0.1, 10000);
  camera.position.set(0, 0, 150);

  renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true, preserveDrawingBuffer:true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(5, 10, 7.5);
  scene.add(dir);

  raycaster  = new THREE.Raycaster();
  pointer    = new THREE.Vector2();
  dragPlane  = new THREE.Plane();
  dragOffset = new THREE.Vector3();

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onOrientationChange);
  // 初期のVW/VH CSS変数をセット
  document.documentElement.style.setProperty('--vw', window.innerWidth * 0.01 + 'px');
  document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
  animate();
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

// スマホ回転時にviewport/フォントが縮まないよう orientationchange でも対応
function onOrientationChange() {
  // 回転後に実際のサイズが確定するまで少し待ってからリサイズ
  setTimeout(() => {
    onResize();
    // viewport の visual viewport に合わせて font-size の基準をリセット
    document.documentElement.style.setProperty('--vw', window.innerWidth * 0.01 + 'px');
    document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
  }, 200);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function fit(obj) {
  // まず正規化スケールを計算するために元バウンディングを取得
  const box0 = new THREE.Box3().setFromObject(obj);
  const sph0 = box0.getBoundingSphere(new THREE.Sphere());
  const r0 = sph0.radius;
  const TARGET = 100;
  const scale = r0 > 0 ? TARGET / (r0 * 2) : 1;

  // スケールをセット
  obj.scale.set(scale, scale, scale);

  // スケール後のバウンディングを再計算して中心・距離を正確に求める
  const box1 = new THREE.Box3().setFromObject(obj);
  const sph1 = box1.getBoundingSphere(new THREE.Sphere());
  const center = sph1.center;
  const r1     = sph1.radius;

  // オブジェクト中心をワールド原点に移動（確実に画面中央に収める）
  obj.position.sub(center);

  // カメラをモデル正面に配置
  const dist = r1 > 0 ? r1 * 2.5 : TARGET * 1.5;
  camera.position.set(0, 0, dist);
  camera.near = dist * 0.001;
  camera.far  = dist * 100;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
}

// ================================================================
// モデル読み込み
// ================================================================
async function handleModel(buf, name) {
  if (!renderer) initThree(window.innerWidth, window.innerHeight);
  if (current) scene.remove(current);
  if (coloredGroup) { scene.remove(coloredGroup); coloredGroup=null; }
  isColored = false;
  if (btnColorParts) btnColorParts.textContent = 'STL部品区別';

  name = name.toLowerCase();
  if (name.endsWith('.stl')) {
    modelMeta.type='stl'; modelMeta.generator='stl';
    const geom = new STLLoader().parse(buf);
    geom.computeVertexNormals();
    current = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
      color:0xaaaaaa, metalness:0.3, roughness:0.7
    }));
  } else {
    const gltf = await new Promise((res,rej)=>new GLTFLoader().parse(buf,'',res,rej));
    current = gltf.scene;
    try {
      const gen=(gltf?.parser?.json?.asset?.generator)||'';
      modelMeta.type='glb'; modelMeta.generator=String(gen||'');
    } catch(e){}
  }

  scene.add(current);
  fit(current);

  dropZone.style.display       = 'none';
  modelControls.style.display  = 'none';
  bgControls.style.display     = 'flex';
  canvas.style.display         = 'block';
  btnBackAR.style.display      = 'none';
  btnCapture.style.display     = 'none';

  // STLのときだけ色分けボタンを有効化
  if (btnColorParts) {
    btnColorParts.style.display = name.endsWith('.stl') ? 'inline-block' : 'none';
  }
}

// ================================================================
// STL部品色分け
// ================================================================
if (btnColorParts) {
  btnColorParts.addEventListener('click', () => {
    if (!current) return;

    if (isColored && coloredGroup) {
      // トグル：元に戻す
      scene.remove(coloredGroup);
      coloredGroup = null;
      scene.add(current);
      current.visible = true;
      isColored = false;
      btnColorParts.textContent = 'STL部品区別';
      return;
    }

    // STL geometry を取得
    let sourceGeom = null;
    eachMesh(current, m => { if (!sourceGeom) sourceGeom = m.geometry; });
    if (!sourceGeom) return;

    // 部品に分離
    const geos = separateGeometries(sourceGeom);
    if (geos.length <= 1) {
      // 1部品しかない場合も色を付けて表示
    }

    // 色分けグループを作成
    coloredGroup = new THREE.Group();

    // 元のモデルのスケール・位置を引き継ぐ
    coloredGroup.scale.copy(current.scale);
    coloredGroup.position.copy(current.position);
    coloredGroup.rotation.copy(current.rotation);

    geos.forEach((geo, idx) => {
      geo.computeVertexNormals();
      const col = PART_COLORS_HEX[idx % PART_COLORS_HEX.length];
      const mat = new THREE.MeshStandardMaterial({
        color: col,
        metalness: 0.1,
        roughness: 0.7,
        transparent: true,
        opacity: 0.92,
      });
      coloredGroup.add(new THREE.Mesh(geo, mat));
    });

    // 元モデルを隠して色分け表示
    current.visible = false;
    scene.add(coloredGroup);
    isColored = true;
    btnColorParts.textContent = `部品区別中 (${geos.length}個) ／元に戻す`;
  });
}

// ================================================================
// ファイル読み込みUI
// ================================================================
btnLoadModel.onclick = () => { modelInput.value=''; modelInput.click(); };
modelInput.onchange  = async () => {
  const f=modelInput.files[0]; if(!f) return;
  const buf=await f.arrayBuffer(); await handleModel(buf, f.name);
};

window.addEventListener('dragover', e=>e.preventDefault());
window.addEventListener('drop',     e=>e.preventDefault());
dropZone.addEventListener('drop', async e=>{
  e.preventDefault();
  const f=e.dataTransfer.files[0]; if(!f) return;
  const buf=await f.arrayBuffer(); await handleModel(buf, f.name);
});
canvas.addEventListener('drop', async e=>{
  e.preventDefault();
  const f=e.dataTransfer.files[0]; if(!f) return;
  const buf=await f.arrayBuffer(); await handleModel(buf, f.name);
});
canvas.addEventListener('dragover', e=>e.preventDefault());

// ================================================================
// モデル移動操作
// ================================================================
canvas.addEventListener('pointerdown', e=>{
  const activeObj = (isColored && coloredGroup) ? coloredGroup : current;
  if (!activeObj) return;
  pointer.x=(e.clientX/window.innerWidth)*2-1;
  pointer.y=-(e.clientY/window.innerHeight)*2+1;
  raycaster.setFromCamera(pointer,camera);
  const ints=raycaster.intersectObject(activeObj,true);
  if(ints.length){
    dragging=true;
    dragPlane.setFromNormalAndCoplanarPoint(
      camera.getWorldDirection(new THREE.Vector3()).negate(), ints[0].point);
    dragOffset.copy(ints[0].point).sub(activeObj.position);
    controls.enabled=false;
  }
});
canvas.addEventListener('pointermove', e=>{
  if(!dragging) return;
  const activeObj=(isColored&&coloredGroup)?coloredGroup:current;
  pointer.x=(e.clientX/window.innerWidth)*2-1;
  pointer.y=-(e.clientY/window.innerHeight)*2+1;
  raycaster.setFromCamera(pointer,camera);
  const pos=new THREE.Vector3();
  if(raycaster.ray.intersectPlane(dragPlane,pos)){
    activeObj.position.copy(pos.sub(dragOffset));
    // coloredGroupとcurrentを同期
    if(isColored&&coloredGroup) current.position.copy(coloredGroup.position);
    else if(coloredGroup) coloredGroup.position.copy(current.position);
  }
});
canvas.addEventListener('pointerup',    ()=>{ dragging=false; controls.enabled=true; });
canvas.addEventListener('pointerleave', ()=>{ dragging=false; controls.enabled=true; });

// ================================================================
// 背景操作
// ================================================================
btnImage.onclick=()=>{
  fileInput.accept='image/*';
  fileInput.onchange=async()=>{
    const f=fileInput.files[0]; if(!f) return;
    const url=URL.createObjectURL(f);
    new THREE.TextureLoader().load(url,tex=>{
      scene.background=tex; renderer.render(scene,camera);
    });
    video.style.display='none';
    canvas.style.display='block';
    btnBackAR.style.display='inline-block';
    btnCapture.style.display='inline-block';
  };
  fileInput.click();
};

btnCamera.onclick=async()=>{
  video.style.display='block'; canvas.style.display='block';
  bgControls.style.display='flex';
  btnBackAR.style.display='inline-block';
  btnCapture.style.display='inline-block';
  btnSwitchCamera.style.display='inline-block';
  try {
    const tmp=await navigator.mediaDevices.getUserMedia({video:true});
    tmp.getTracks().forEach(t=>t.stop());
    const devices=await navigator.mediaDevices.enumerateDevices();
    videoDevices=devices.filter(d=>d.kind==='videoinput');
    const bi=videoDevices.findIndex(d=>
      d.label.toLowerCase().includes('back')||
      d.label.toLowerCase().includes('environment')||
      d.label.includes('背面'));
    currentCameraIndex=(bi!==-1)?bi:0;
    await startCamera({video:{deviceId:{exact:videoDevices[currentCameraIndex].deviceId}}});
  } catch(err){
    console.warn('背面カメラ取得失敗:',err);
    await startCamera({video:{facingMode:'user'}});
  }
};

btnSwitchCamera.onclick=async()=>{
  if(videoDevices.length<=1) return;
  currentCameraIndex=(currentCameraIndex+1)%videoDevices.length;
  await startCamera({video:{deviceId:{exact:videoDevices[currentCameraIndex].deviceId}}});
};

async function startCamera(constraints){
  if(currentStream) currentStream.getTracks().forEach(t=>t.stop());
  const stream=await navigator.mediaDevices.getUserMedia(constraints);
  currentStream=stream; video.srcObject=stream;
  video.onloadedmetadata=()=>{ scene.background=new THREE.VideoTexture(video); };
}

btnCapture.onclick=()=>{
  const dataURL=renderer.domElement.toDataURL('image/jpeg',0.92);
  const now=new Date();
  const ts=`${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
  const a=document.createElement('a');
  a.href=dataURL; a.download=`capture_${ts}.jpg`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
};

btnReloadModel.onclick=()=>{
  if(current) scene.remove(current);
  if(coloredGroup){ scene.remove(coloredGroup); coloredGroup=null; }
  isColored=false;
  bgControls.style.display='none';
  canvas.style.display='none';
  video.style.display='none';
  modelControls.style.display='block';
  dropZone.style.display='flex';
  btnCapture.style.display='none';
  btnBackAR.style.display='none';
  btnSwitchCamera.style.display='none';
  if(currentStream){ currentStream.getTracks().forEach(t=>t.stop()); currentStream=null; }
};

btnBackAR.onclick=()=>{
  scene.background=new THREE.Color(0x000000);
  btnBackAR.style.display='none';
  btnCapture.style.display='none';
  btnSwitchCamera.style.display='none';
  video.style.display='none';
  canvas.style.display='block';
  if(currentStream){ currentStream.getTracks().forEach(t=>t.stop()); currentStream=null; }
};

// ================================================================
// ポリゴン表示切替
// ================================================================
if(btnToggleWire){
  btnToggleWire.onclick=()=>{
    if(!current) return;
    wireOn=!wireOn;
    const targets=[];
    eachMesh(current,m=>targets.push(m));
    if(isColored&&coloredGroup) eachMesh(coloredGroup,m=>targets.push(m));
    targets.forEach(m=>{
      forEachMaterial(m,mat=>{
        if(wireOn){
          if(!originalMaterials.has(mat))
            originalMaterials.set(mat,{
              wireframe:'wireframe' in mat?mat.wireframe:undefined,
              flatShading:'flatShading' in mat?mat.flatShading:undefined
            });
          if('wireframe' in mat) mat.wireframe=true;
          if('flatShading' in mat) mat.flatShading=true;
        } else {
          const saved=originalMaterials.get(mat);
          if(saved){
            if('wireframe' in mat&&saved.wireframe!==undefined) mat.wireframe=saved.wireframe;
            if('flatShading' in mat&&saved.flatShading!==undefined) mat.flatShading=saved.flatShading;
          } else {
            if('wireframe' in mat) mat.wireframe=false;
            if('flatShading' in mat) mat.flatShading=false;
          }
        }
        mat.needsUpdate=true;
      });
    });
    if(!wireOn) originalMaterials.clear();
  };
}

// ================================================================
// 統計情報
// ================================================================
function computeStats(root){
  let meshes=0,materials=0,tris=0,verts=0,drawCalls=0;
  eachMesh(root,m=>{
    meshes++; drawCalls++;
    const mat=m.material;
    if(Array.isArray(mat)) materials+=mat.length; else if(mat) materials+=1;
    const g=m.geometry; if(!g) return;
    if(g.index&&g.index.count) tris+=g.index.count/3;
    else if(g.attributes?.position) tris+=g.attributes.position.count/3;
    if(g.attributes?.position) verts+=g.attributes.position.count;
  });
  const box=new THREE.Box3().setFromObject(root);
  const size=new THREE.Vector3(); box.getSize(size);
  try{ const s=(root?.scale?.x)||1; if(s&&s!==0) size.divideScalar(s); }catch(e){}
  try{ const mx=Math.max(size.x,size.y,size.z); if(mx<1) size.multiplyScalar(1000); }catch(e){}
  return{meshes,materials,tris:Math.round(tris),verts:Math.round(verts),drawCalls,
    bbox:{w:+size.x.toFixed(3),h:+size.y.toFixed(3),d:+size.z.toFixed(3)}};
}

if(btnShowStats){
  // 統計パネルをダブルクリックで閉じる
  statsPanel.addEventListener('dblclick', () => {
    statsPanel.style.display = 'none';
  });
  statsPanel.title = 'ダブルクリックで閉じる';

  btnShowStats.onclick=()=>{
    if(!current) return;
    const s=computeStats(current);
    const show=(statsPanel.style.display==='none'||statsPanel.style.display==='');
    statsPanel.style.display=show?'block':'none';
    if(show){
      statsPanel.textContent=
`📐 3Dモデル統計情報

メッシュ数: ${s.meshes}
マテリアル数: ${s.materials}
三角形数: ${s.tris.toLocaleString()}
頂点数: ${s.verts.toLocaleString()}
ドローコール: ${s.drawCalls}

サイズ (mm) ※Tinkercad基準
  W: ${s.bbox.w}
  H: ${s.bbox.h}
  D: ${s.bbox.d}`;
    }
  };
}
