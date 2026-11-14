import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OBJLoader} from 'three/addons/loaders/OBJLoader.js';
import {MTLLoader} from 'three/addons/loaders/MTLLoader.js';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
import {extractTriangles,generateSlice,makeAtlas} from './slicer.js';

const $ = id => document.getElementById(id);
const ui = {
  file:$('modelFile'), drop:$('dropzone'),demo:$('demoBtn'),
  layers:$('layers'),layersOut:$('layersOut'),resolution:$('resolution'),
  resolutionSlider:$('resolutionSlider'),resolutionOut:$('resolutionOut'),
  atlasEstimate:$('atlasEstimate'),resolutionPresets:[...document.querySelectorAll('[data-resolution]')],
  direction:$('direction'),directionOut:$('directionOut'),
  extrude:$('extrude'),thickness:$('thickness'),thicknessOut:$('thicknessOut'),
  thicknessSetting:$('thicknessSetting'),generate:$('generateBtn'),
  status:$('status'),name:$('modelName'),stats:$('modelStats'),
  png:$('pngBtn'),json:$('jsonBtn'),atlas:$('atlas'),atlasSize:$('atlasSize'),
  atlasEmpty:$('atlasEmpty'),slice:$('sliceCanvas'),sliceInspect:$('sliceInspect'),
  sliceIndex:$('sliceIndex'),speed:$('speed'),speedOut:$('speedOut'),
  pause:$('pauseBtn'),previewNote:$('previewNote')
};
let model=null, slices=[], atlas=null, sourceName='survey-rover', job=0;
let spinning=true, elapsedTime=0;
function status(message,error=false) {ui.status.textContent=message;ui.status.classList.toggle('error',error);}
function safeFileName(name){return name.replace(/\.[^.]+$/,'').replace(/[^a-z0-9_-]+/gi,'_').toLowerCase()||'model';}
function rangeLabel(input,out,suffix=''){out.textContent=input.value+suffix;}
rangeLabel(ui.layers,ui.layersOut);rangeLabel(ui.direction,ui.directionOut,'%');
rangeLabel(ui.thickness,ui.thicknessOut,'%');rangeLabel(ui.speed,ui.speedOut,'%');
for(const [input,out,suffix] of [[ui.layers,ui.layersOut,''],[ui.direction,ui.directionOut,'%'],
                                  [ui.thickness,ui.thicknessOut,'%'],[ui.speed,ui.speedOut,'%']])
  input.addEventListener('input',()=>rangeLabel(input,out,suffix));
const SPRITE_RESOLUTIONS=[16,24,32,48,64,96,128,192,256];
function clampResolution(value){
  const number=Number.parseFloat(value);
  return Number.isFinite(number)?Math.max(16,Math.min(256,Math.round(number))):96;
}
function updateAtlasEstimate(){
  const count=+ui.layers.value;
  const res=clampResolution(ui.resolution.value);
  const columns=Math.ceil(Math.sqrt(count));
  const rows=Math.ceil(count/columns);
  const cell=res+4; // Two pixels of transparent padding on each edge.
  ui.atlasEstimate.textContent='EST. ATLAS '+(cell*columns)+' × '+(cell*rows)+' PX · '+columns+' COLS × '+rows+' ROWS';
}
function syncResolutionUI(){
  const res=clampResolution(ui.resolution.value);
  ui.resolutionOut.textContent=res+' × '+res+' px';
  let nearest=0;
  for(let i=1;i<SPRITE_RESOLUTIONS.length;i++){
    if(Math.abs(SPRITE_RESOLUTIONS[i]-res)<Math.abs(SPRITE_RESOLUTIONS[nearest]-res))nearest=i;
  }
  ui.resolutionSlider.value=String(nearest);
  ui.resolutionPresets.forEach(button=>{
    const selected=+button.dataset.resolution===res;
    button.classList.toggle('active',selected);
    button.setAttribute('aria-pressed',String(selected));
  });
  updateAtlasEstimate();
}
function setResolution(value,regenerate=false){
  ui.resolution.value=String(clampResolution(value));
  syncResolutionUI();
  if(regenerate&&model)generate();
}
// Live labels/estimated atlas update while dragging, but only re-slice on release.
ui.resolutionSlider.addEventListener('input',()=>setResolution(SPRITE_RESOLUTIONS[+ui.resolutionSlider.value]));
ui.resolutionSlider.addEventListener('change',()=>{if(model)generate();});
ui.resolution.addEventListener('input',()=>{
  const v=Number(ui.resolution.value);
  if(ui.resolution.value.trim()!==''&&Number.isFinite(v)&&v>=16&&v<=256)syncResolutionUI();
});
ui.resolution.addEventListener('change',()=>setResolution(ui.resolution.value,true));
ui.resolutionPresets.forEach(button=>button.addEventListener('click',()=>setResolution(button.dataset.resolution,true)));
ui.layers.addEventListener('input',updateAtlasEstimate);
syncResolutionUI();

ui.extrude.addEventListener('change',()=>{
  ui.thicknessSetting.style.opacity=ui.extrude.checked?'1':'.45';
  if(slices.length)rebuildStack();
});
ui.thickness.addEventListener('change',()=>{if(slices.length)rebuildStack();});
ui.speed.addEventListener('input',()=>{if(+ui.speed.value>0 && !spinning){} });
ui.pause.addEventListener('click',()=>{
  spinning=!spinning;ui.pause.textContent=spinning?'Ⅱ':'▶';
  ui.pause.setAttribute('aria-label',spinning?'Pause rotation':'Resume rotation');
});
for(const el of [ui.layers,ui.direction])el.addEventListener('change',()=>{if(model)generate();});
ui.generate.addEventListener('click',generate);
ui.demo.addEventListener('click',loadDemo);

const renderer=new THREE.WebGLRenderer({canvas:$('scene'),antialias:true,alpha:true,powerPreference:'high-performance'});
renderer.setClearColor(0x000000,0);
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
const scene=new THREE.Scene();
const camera=new THREE.OrthographicCamera(-2,2,2,-2,.01,100);
camera.position.set(4,5.15,4);camera.lookAt(0,0,0);
const controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=true;controls.dampingFactor=.08;controls.enablePan=false;
controls.minZoom=.4;controls.maxZoom=5;controls.target.set(0,0,0);
const turntable=new THREE.Group();scene.add(turntable);
const grid=new THREE.GridHelper(3.8,19,0x526069,0x344047);
grid.material.transparent=true;grid.material.opacity=.24;grid.position.y=-1.15;scene.add(grid);
let viewHeight=3.4;
function resize(){
  const box=renderer.domElement.getBoundingClientRect();
  if(!box.width||!box.height)return;
  renderer.setSize(box.width,box.height,false);
  const aspect=box.width/box.height;
  camera.left=-viewHeight*aspect/2;camera.right=viewHeight*aspect/2;
  camera.top=viewHeight/2;camera.bottom=-viewHeight/2;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(renderer.domElement);resize();
const clock=new THREE.Clock();
function animate(){
  requestAnimationFrame(animate);
  const dt=Math.min(clock.getDelta(),.08);
  if(spinning && turntable.children.length){
    const speed=+ui.speed.value/100;
    turntable.rotation.y+=dt*speed*.95;
    elapsedTime+=dt;
  }
  controls.update();renderer.render(scene,camera);
}
animate();

function makeDemo() {
  const root=new THREE.Group();
  const material = color=>new THREE.MeshStandardMaterial({color,roughness:.9});
  const cream=material('#d1c0a0'),orange=material('#e38b4b'),
    dark=material('#3d474b'),steel=material('#879296'),
    glass=material('#7fabb0'),light=material('#efcb73');
  function add(g,m,x=0,y=0,z=0,rx=0,ry=0,rz=0){
    const mesh=new THREE.Mesh(g,m);
    mesh.position.set(x,y,z);mesh.rotation.set(rx,ry,rz);root.add(mesh);return mesh;
  }
  add(new THREE.BoxGeometry(1.6,.43,.95),cream,0,-.17,0);
  add(new THREE.BoxGeometry(1.45,.12,1.06),orange,0,.085,0);
  add(new THREE.BoxGeometry(.76,.68,.7),cream,-.17,.45,0);
  add(new THREE.BoxGeometry(.67,.27,.72),glass,-.17,.72,0);
  add(new THREE.BoxGeometry(.23,.3,.64),dark,.62,.29,0);
  add(new THREE.BoxGeometry(.48,.22,.71),dark,.48,-.42,0);
  for(const x of [-.58,.58]) for(const z of [-.58,.58]){
    add(new THREE.CylinderGeometry(.30,.30,.21,14,1),dark,x,-.46,z,0,0,Math.PI/2);
    add(new THREE.CylinderGeometry(.145,.145,.23,12,1),steel,x,-.46,z,0,0,Math.PI/2);
  }
  add(new THREE.CylinderGeometry(.075,.085,.74,9),steel,-.38,1.13,-.12);
  add(new THREE.SphereGeometry(.17,12,8),orange,-.38,1.56,-.12);
  add(new THREE.BoxGeometry(.26,.08,.27),light,.46,.5,.05);
  add(new THREE.CylinderGeometry(.13,.13,.2,12),steel,.50,.60,.05);
  add(new THREE.TorusGeometry(.16,.065,8,18),orange,.5,.78,.05,Math.PI/2);
  add(new THREE.BoxGeometry(.11,.36,.13),dark,-.65,.43,.30);
  return root;
}
async function loadDemo() {
  job++;
  ui.name.textContent='Demo · Survey Rover';
  ui.stats.textContent='Procedural sample · all faces colored';
  sourceName='survey-rover';
  await useModel(makeDemo(),sourceName);
}
async function useModel(root,name) {
  try {
    status('Preparing geometry…');
    model=extractTriangles(root);
    ui.stats.textContent=model.meshCount+' meshes · '+model.triangleCount.toLocaleString()+' triangles';
    if(model.triangleCount>250000) status('Large model — slicing can take a while');
    await generate();
  }catch(err){console.error(err);ui.generate.disabled=false;status(err.message||'Model loading failed',true);}
}

ui.drop.addEventListener('click',e=>{if(e.target!==ui.file)ui.file.click();});
ui.drop.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();ui.file.click();}});
ui.file.addEventListener('change',()=>loadFiles([...ui.file.files]));
for(const ev of ['dragenter','dragover'])ui.drop.addEventListener(ev,e=>{e.preventDefault();ui.drop.classList.add('dragging');});
for(const ev of ['dragleave','drop'])ui.drop.addEventListener(ev,e=>{e.preventDefault();ui.drop.classList.remove('dragging');});
ui.drop.addEventListener('drop',e=>loadFiles([...e.dataTransfer.files]));

async function loadFiles(files) {
  const supported=['glb','gltf','obj','stl','fbx'];
  const file=files.find(f=>supported.includes(f.name.split('.').pop().toLowerCase()));
  if(!file){status('Select a GLB, GLTF, OBJ, STL or FBX model.',true);return;}
  const token=++job;
  status('Loading '+file.name+'…');
  const blobs=new Map();
  for(const f of files)blobs.set(f.name.toLowerCase(),URL.createObjectURL(f));
  const manager=new THREE.LoadingManager();
  manager.setURLModifier(url=>{
    const basename=decodeURIComponent(url.split('?')[0].split('/').pop()).toLowerCase();
    return blobs.get(basename)||url;
  });
  try {
    const ext=file.name.split('.').pop().toLowerCase();
    let root;
    if(ext==='glb'||ext==='gltf'){
      const loader=new GLTFLoader(manager);
      const data=ext==='glb'?await file.arrayBuffer():await file.text();
      root=await new Promise((resolve,reject)=>loader.parse(data,'',gltf=>resolve(gltf.scene),reject));
    }else if(ext==='obj'){
      const loader=new OBJLoader(manager);
      const mtl=files.find(f=>f.name.toLowerCase().endsWith('.mtl'));
      if(mtl){
        const materials=new MTLLoader(manager).parse(await mtl.text(),'');
        materials.preload();loader.setMaterials(materials);
      }
      root=loader.parse(await file.text());
    }else if(ext==='stl'){
      const geometry=new STLLoader(manager).parse(await file.arrayBuffer());
      root=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:'#b6bcbc'}));
    }else{
      root=new FBXLoader(manager).parse(await file.arrayBuffer(),'');
    }
    if(token!==job)return;
    sourceName=safeFileName(file.name);
    ui.name.textContent=file.name;
    await useModel(root,sourceName);
  }catch(err){console.error(err);ui.generate.disabled=false;status('Import failed: '+(err.message||err),true);}
  finally {setTimeout(()=>{for(const url of blobs.values())URL.revokeObjectURL(url);},5000);}
}

function nextFrame(){return new Promise(resolve=>requestAnimationFrame(resolve));}
async function generate() {
  if(!model)return;
  const token=++job;
  const count=+ui.layers.value,res=clampResolution(ui.resolution.value),dir=+ui.direction.value/100;
  ui.generate.disabled=true;ui.png.disabled=true;ui.json.disabled=true;
  const made=[];
  try {
    status('Generating 0 / '+count+' layers…');
    await nextFrame();
    const minY=model.bounds.minY,dy=model.bounds.height/count;
    for(let i=0;i<count;i++){
      if(token!==job)return;
      const planeY=minY+dy*(i+.5);
      made.push(generateSlice(model,res,planeY,dir,dy));
      if(i%2===1||i===count-1){
        status('Generating '+(i+1)+' / '+count+' layers…');
        await nextFrame();
      }
    }
    if(token!==job)return;
    slices=made;
    atlas=makeAtlas(slices,res,2);
    ui.atlas.width=atlas.canvas.width;ui.atlas.height=atlas.canvas.height;
    ui.atlas.getContext('2d').clearRect(0,0,ui.atlas.width,ui.atlas.height);
    ui.atlas.getContext('2d').drawImage(atlas.canvas,0,0);
    ui.atlas.style.display='block';ui.atlasEmpty.style.display='none';
    ui.atlasSize.textContent=atlas.canvas.width+' × '+atlas.canvas.height+' PX';
    const maxDisplayWidth=Math.max(120,ui.atlas.parentElement.clientWidth-20);
    ui.atlas.style.width=Math.min(atlas.canvas.width,maxDisplayWidth)+'px';
    ui.sliceInspect.max=count-1;ui.sliceInspect.value=Math.floor(count/2);
    updateSliceInspection();
    rebuildStack();
    ui.png.disabled=false;ui.json.disabled=false;
    status('Ready · '+count+' colored slices · '+res+'px each');
  } catch(err){console.error(err);status('Slice generation failed: '+(err.message||err),true);}
  finally {if(token===job)ui.generate.disabled=false;}
}
function updateSliceInspection() {
  if(!slices.length)return;
  const i=Math.min(slices.length-1,+ui.sliceInspect.value);
  ui.slice.width=slices[i].width;ui.slice.height=slices[i].height;
  const ctx=ui.slice.getContext('2d');ctx.clearRect(0,0,ui.slice.width,ui.slice.height);
  ctx.drawImage(slices[i],0,0);
  ui.sliceIndex.textContent='LAYER '+String(i+1).padStart(2,'0')+' / '+slices.length;
}
ui.sliceInspect.addEventListener('input',updateSliceInspection);

function clearStack() {
  turntable.traverse(obj=>{
    if(obj.geometry)obj.geometry.dispose();
    if(obj.material){
      const list=Array.isArray(obj.material)?obj.material:[obj.material];
      for(const mat of list){mat.map?.dispose();mat.dispose();}
    }
  });
  turntable.clear();
}
function makeWallGeometry() {
  const positions=[],colors=[];
  const res=slices[0].width,extent=model.bounds.width;
  const stepY=model.bounds.height/slices.length;
  const thick=stepY*(+ui.thickness.value)/100;
  const pixel=extent/res;
  const linear=new THREE.Color();
  // Emits just exterior texel edges. Every opaque pixel acquires height,
  // turning a flat layer into a tight, textured solid slab with no air gaps.
  function quad(x0,z0,x1,z1,y0,y1,rgba,shading){
    linear.setRGB(rgba[0]/255,rgba[1]/255,rgba[2]/255,THREE.SRGBColorSpace).multiplyScalar(shading);
    const corners=[[x0,y0,z0],[x1,y0,z1],[x1,y1,z1],[x0,y1,z0]];
    const indices=[0,1,2,0,2,3];
    for(const i of indices){positions.push(...corners[i]);colors.push(linear.r,linear.g,linear.b);}
  }
  for(let k=0;k<slices.length;k++){
    const ctx=slices[k].getContext('2d',{willReadFrequently:true});
    const data=ctx.getImageData(0,0,res,res).data;
    const yCenter=model.bounds.minY+(k+.5)*stepY;
    const y0=yCenter-thick/2,y1=yCenter+thick/2;
    const has=(x,y)=>x>=0&&y>=0&&x<res&&y<res&&data[(y*res+x)*4+3]>127;
    for(let y=0;y<res;y++)for(let x=0;x<res;x++){
      if(!has(x,y))continue;
      const idx=(y*res+x)*4,rgba=data.subarray(idx,idx+3);
      const x0=(x/res-.5)*extent,x1=x0+pixel;
      const z0=(y/res-.5)*extent,z1=z0+pixel;
      if(!has(x-1,y))quad(x0,z1,x0,z0,y0,y1,rgba,.79);
      if(!has(x+1,y))quad(x1,z0,x1,z1,y0,y1,rgba,.90);
      if(!has(x,y-1))quad(x0,z0,x1,z0,y0,y1,rgba,.72);
      if(!has(x,y+1))quad(x1,z1,x0,z1,y0,y1,rgba,.83);
    }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geo.computeBoundingSphere();
  return geo;
}
function rebuildStack(){
  if(!model||!slices.length)return;
  clearStack();
  const dy=model.bounds.height/slices.length;
  const thickness=ui.extrude.checked?dy*(+ui.thickness.value)/100:0;
  const size=model.bounds.width;
  for(let i=0;i<slices.length;i++){
    const texture=new THREE.CanvasTexture(slices[i]);
    texture.colorSpace=THREE.SRGBColorSpace;
    texture.magFilter=THREE.NearestFilter;
    texture.minFilter=THREE.NearestFilter;
    texture.generateMipmaps=false;
    const mat=new THREE.MeshBasicMaterial({map:texture,transparent:true,alphaTest:.5,side:THREE.DoubleSide,depthWrite:true});
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(size,size),mat);
    mesh.rotation.x=-Math.PI/2;
    mesh.position.y=model.bounds.minY+(i+.5)*dy+thickness/2+.00001*i;
    mesh.renderOrder=i;
    turntable.add(mesh);
  }
  if(ui.extrude.checked){
    const geometry=makeWallGeometry();
    const wall=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide}));
    turntable.add(wall);
  }
  grid.position.y=model.bounds.minY-.09;
  ui.previewNote.textContent=slices.length+' SPRITES · '+slices[0].width+'² PX · '+(ui.extrude.checked?'EXTRUDED':'FLAT');
  viewHeight=Math.max(model.bounds.height*1.8,model.bounds.width*1.62,2.7);
  resize();
}
function downloadBlob(blob,name) {
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
ui.png.addEventListener('click',()=>{
  if(!atlas)return;
  atlas.canvas.toBlob(blob=>{if(blob)downloadBlob(blob,sourceName+'_atlas.png');},'image/png');
});
ui.json.addEventListener('click',()=>{
  if(!atlas||!model)return;
  const meta={
    format:'Spritestacker atlas v1',source:ui.name.textContent,
    atlas:{width:atlas.canvas.width,height:atlas.canvas.height,columns:atlas.columns,rows:atlas.rows,padding:atlas.padding},
    slicing:{axis:'Y',projection:'top-down XZ',order:'bottom-to-top',layerCount:slices.length,resolution:slices[0].width,
      layerStep:model.bounds.height/slices.length,minY:model.bounds.minY,
      sizeXZ:model.bounds.width,normalInfluence:+ui.direction.value/100,
      extrude:ui.extrude.checked,slabThicknessRatio:+ui.thickness.value/100},
    layers:atlas.tiles.map((tile,i)=>({...tile,y:model.bounds.minY+(i+.5)*model.bounds.height/slices.length}))
  };
  downloadBlob(new Blob([JSON.stringify(meta,null,2)],{type:'application/json'}),sourceName+'_atlas.json');
});
loadDemo();
