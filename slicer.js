import * as THREE from 'three';

// The source mesh is evaluated in world space so that hierarchy transforms,
// rotated parts and differently scaled meshes all produce the same slice grid.
const scratchUV = new THREE.Vector2();
const imageCache = new WeakMap();
const defaultColor = new THREE.Color('#b6b9b8');
const clampByte = v => Math.max(0, Math.min(255, Math.round(v)));
const srgbToLinear = v => v < 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
const linearToSrgb = v => v < 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

function texturePixels(texture) {
  if (!texture?.image) return null;
  if (imageCache.has(texture)) return imageCache.get(texture);
  let pixels = null;
  try {
    const img = texture.image;
    const width = img.width || img.videoWidth, height = img.height || img.videoHeight;
    if (width && height) {
      if (img.data && (img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray)) {
        // DataTextures may have RGB or RGBA channels; don't read the next texel's
        // red channel as alpha when only three channels are present.
        const channels = img.data.length / (width * height);
        if(channels === 3 || channels === 4)
          pixels = {data:img.data, width, height, channels};
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d', {willReadFrequently:true});
        ctx.drawImage(img, 0, 0, width, height);
        pixels = { data:ctx.getImageData(0,0,width,height).data, width, height, channels:4 };
      }
      if (texture.matrixAutoUpdate) texture.updateMatrix();
    }
  } catch (err) { console.warn('Cannot sample diffuse map; using base material color', err); }
  // Failed / not-yet-loaded image reads must not be cached permanently.
  // The loader may finish supplying the bitmap after this slice was requested.
  if(pixels)imageCache.set(texture, pixels);
  return pixels;
}

// Evaluate albedo exactly as the shader does: sRGB texture pixels and linear
// material/vertex multipliers are combined in LINEAR space, encoded once at output.
// transformUv() already applies texture.flipY; do not flip the V coordinate again.
function sampleMaterial(mat, vertex) {
  const base = mat?.color || defaultColor;
  let r = base.r * vertex.r, g = base.g * vertex.g, b = base.b * vertex.b;
  const tex = mat?.map;
  if (tex) {
    const src=texturePixels(tex);
    // Returning the material tint alone here can create white specks wherever a
    // texture image is unavailable or the mesh has missing/invalid UVs.
    if(!src)return null;
    const channel = Math.max(0, Math.min(3, tex.channel || 0));
    const uk = channel ? 'u' + channel : 'u';
    const vk = channel ? 'v' + channel : 'v';
    const u=vertex[uk],v=vertex[vk];
    if(!Number.isFinite(u)||!Number.isFinite(v))return null;
    scratchUV.set(u,v);
    tex.transformUv(scratchUV);
    if(!Number.isFinite(scratchUV.x)||!Number.isFinite(scratchUV.y))return null;
    const x = Math.max(0, Math.min(src.width - 1, Math.floor(scratchUV.x * src.width)));
    const y = Math.max(0, Math.min(src.height - 1, Math.floor(scratchUV.y * src.height)));
    const p = (y * src.width + x) * src.channels;
    const alpha = src.channels===4 ? src.data[p+3]/255 : 1;
    // Alpha testing belongs to the source material, not to the packed atlas.
    // Ignore invisible texture texels as seeds and projection candidates.
    // Opaque materials intentionally ignore the PNG's alpha channel.
    if((mat?.transparent || (mat?.alphaTest??0)>0) &&
       alpha*(mat?.opacity??1) <= Math.max(1/255,mat?.alphaTest??0))return null;
    const decode = tex.colorSpace === THREE.LinearSRGBColorSpace ? v => v : srgbToLinear;
    r *= decode(src.data[p] / 255);
    g *= decode(src.data[p+1] / 255);
    b *= decode(src.data[p+2] / 255);
  } else if (mat?.transparent && (mat?.opacity??1) <= 1/255) {
    return null;
  }
  return [clampByte(linearToSrgb(Math.max(0,r))*255),
          clampByte(linearToSrgb(Math.max(0,g))*255),
          clampByte(linearToSrgb(Math.max(0,b))*255)];
}

function sampleSurface(mat, a, b, t) {
  return sampleMaterial(mat, interpolate(a, b, t));
}

export function extractTriangles(root) {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty()) throw new Error('The file contains no supported polygon geometry.');
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  if (size.y < 1e-8 || Math.max(size.x,size.z) < 1e-8)
    throw new Error('The model needs 3D volume across the vertical and horizontal axes.');
  const unit = Math.max(size.x,size.y,size.z);
  const scale = 2 / unit;
  const v = new THREE.Vector3();
  const tris = [];
  let meshCount = 0;
  const diffuseMaps = new Set();
  root.traverse(obj => {
    if (!obj.isMesh || !obj.visible || !obj.geometry?.getAttribute('position')) return;
    const geo = obj.geometry, pos = geo.getAttribute('position'),
      uv = geo.getAttribute('uv'), uv1 = geo.getAttribute('uv1'),
      uv2 = geo.getAttribute('uv2'), uv3 = geo.getAttribute('uv3'),
      vc = geo.getAttribute('color');
    const index = geo.index;
    const n = index ? index.count : pos.count;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const groups = geo.groups || [];
    meshCount++;
    function vertex(i) {
      v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld).sub(center).multiplyScalar(scale);
      return {x:v.x,y:v.y,z:v.z,u:uv?uv.getX(i):NaN,v:uv?uv.getY(i):NaN,
        u1:uv1?uv1.getX(i):undefined,v1:uv1?uv1.getY(i):undefined,
        u2:uv2?uv2.getX(i):undefined,v2:uv2?uv2.getY(i):undefined,
        u3:uv3?uv3.getX(i):undefined,v3:uv3?uv3.getY(i):undefined,
        r:vc?vc.getX(i):1,g:vc?vc.getY(i):1,b:vc?vc.getZ(i):1};
    }
    for (let j=0; j+2<n; j+=3) {
      const a=vertex(index?index.getX(j):j);
      const b=vertex(index?index.getX(j+1):j+1);
      const c=vertex(index?index.getX(j+2):j+2);
      const nx=(b.y-a.y)*(c.z-a.z)-(b.z-a.z)*(c.y-a.y);
      const nz=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
      const mag=Math.hypot(nx,nz);
      let m=0;
      if (mats.length>1) for (const group of groups) if (j>=group.start && j<group.start+group.count) {m=group.materialIndex;break;}
      const material=mats[m]||mats[0];
      if(material?.map?.image)diffuseMaps.add(material.map);
      tris.push({a,b,c,nx:mag? -nx/mag:0,nz:mag? -nz/mag:0,
        mat:material,minY:Math.min(a.y,b.y,c.y),maxY:Math.max(a.y,b.y,c.y)});
    }
  });
  if (!tris.length) throw new Error('The model has no triangle faces.');
  const w = Math.max(size.x,size.z)*scale*1.14;
  return {tris,bounds:{width:w,depth:w,minY:-size.y*scale/2,maxY:size.y*scale/2,height:size.y*scale},meshCount,triangleCount:tris.length,textureCount:diffuseMaps.size};
}

const interpolate = (a,b,t) => ({
  x:a.x+(b.x-a.x)*t, z:a.z+(b.z-a.z)*t,
  u:a.u+(b.u-a.u)*t, v:a.v+(b.v-a.v)*t,
  u1:(a.u1??a.u)+((b.u1??b.u)-(a.u1??a.u))*t,
  v1:(a.v1??a.v)+((b.v1??b.v)-(a.v1??a.v))*t,
  u2:(a.u2??a.u)+((b.u2??b.u)-(a.u2??a.u))*t,
  v2:(a.v2??a.v)+((b.v2??b.v)-(a.v2??a.v))*t,
  u3:(a.u3??a.u)+((b.u3??b.u)-(a.u3??a.u))*t,
  v3:(a.v3??a.v)+((b.v3??b.v)-(a.v3??a.v))*t,
  r:a.r+(b.r-a.r)*t, g:a.g+(b.g-a.g)*t, b:a.b+(b.b-a.b)*t
});

function intersect(tri, y) {
  if (y <= tri.minY || y >= tri.maxY) return null;
  const {a,b,c}=tri, list=[];
  for (const [p,q] of [[a,b],[b,c],[c,a]]) {
    if ((p.y<=y && q.y>y)||(q.y<=y && p.y>y))
      list.push(interpolate(p,q,(y-p.y)/(q.y-p.y)));
  }
  return list.length===2 ? {a:list[0],b:list[1],nx:tri.nx,nz:tri.nz,mat:tri.mat} : null;
}

function rasterContours(segments, resolution, width) {
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width=maskCanvas.height=resolution;
  const ctx=maskCanvas.getContext('2d',{willReadFrequently:true});
  const toPx = p => ({x:(p.x/width+0.5)*resolution,
                          y:(p.z/width+0.5)*resolution});
  const edges = segments.map(s=>({...s,p:toPx(s.a),q:toPx(s.b)}));
  const key = p => Math.round(p.x*10000)+','+Math.round(p.y*10000);
  const joined = new Map();
  edges.forEach((s,i) => {
    for (const [k,other] of [[key(s.p),'a'],[key(s.q),'b']]) {
      if(!joined.has(k)) joined.set(k,[]);
      joined.get(k).push({i,other});
    }
  });
  const seen = new Uint8Array(edges.length);
  ctx.fillStyle='#fff';
  let closed=0;
  // Fill every closed contour independently: inner cavities aren't punched out.
  // That is intentional for solid-looking sprite stacks from hollow meshes.
  for(let i=0;i<edges.length;i++){
    if(seen[i])continue;
    const start=edges[i].p, pts=[start,edges[i].q];
    let end=edges[i].q, current=i;
    seen[i]=1;
    for(let step=0;step<edges.length;step++){
      if(key(end)===key(start))break;
      const options=joined.get(key(end))||[];
      const next=options.find(o=>!seen[o.i]);
      if(!next)break;
      seen[next.i]=1; current=next.i;
      end=next.other==='a'?edges[current].q:edges[current].p;
      pts.push(end);
    }
    if(pts.length>3 && key(end)===key(start)){
      closed++;
      ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);
      for(let j=1;j<pts.length;j++)ctx.lineTo(pts[j].x,pts[j].y);
      ctx.closePath();ctx.fill();
    }
  }
  // Open/non-manifold contour fallback: regular parity scanline rasterization.
  if(!closed && edges.length){
    for(let row=0;row<resolution;row++){
      const y=row+.5, intersections=[];
      for(const s of edges){
        if((s.p.y<=y&&s.q.y>y)||(s.q.y<=y&&s.p.y>y))
          intersections.push(s.p.x+(y-s.p.y)*(s.q.x-s.p.x)/(s.q.y-s.p.y));
      }
      intersections.sort((a,b)=>a-b);
      for(let j=0;j+1<intersections.length;j+=2)
        ctx.fillRect(intersections[j],row,intersections[j+1]-intersections[j],1);
    }
  }
  const raw=ctx.getImageData(0,0,resolution,resolution).data;
  const mask=new Uint8Array(resolution*resolution);
  for(let i=0;i<mask.length;i++)mask[i]=raw[i*4+3]>0?1:0;
  return {edges,mask};
}

class MinHeap {
  constructor(){this.a=[];}
  push(i,v){
    const a=this.a;let p=a.length;a.push({i,v});
    while(p){const q=(p-1)>>1;if(a[q].v<=v)break;a[p]=a[q];p=q;}a[p]={i,v};
  }
  pop(){
    const a=this.a;if(!a.length)return null;
    const out=a[0],tail=a.pop();
    if(a.length){let p=0;while(true){
      const left=p*2+1;if(left>=a.length)break;
      const right=left+1,small=right<a.length&&a[right].v<a[left].v?right:left;
      if(a[small].v>=tail.v)break;a[p]=a[small];p=small;
    }a[p]=tail;}
    return out;
  }
  get length(){return this.a.length;}
}

// Project upward-facing textured triangles that actually occupy this vertical
// slice. Boundary colors alone cannot reproduce artwork on broad upper faces.
// Per-pixel height testing selects the uppermost visible surface within the slab.
// Remaining enclosed areas are still colored by inward-normal dilation.
function sampleVisibleFaces(model, resolution, y, layerHeight) {
  const n=resolution*resolution;
  const hits=new Uint8Array(n);
  const colors=new Uint8Array(n*3);
  const maxY=new Float32Array(n).fill(-Infinity);
  const low=y-layerHeight/2-1e-6, high=y+layerHeight/2+1e-6;
  const width=model.bounds.width;
  for (const tri of model.tris) {
    if(tri.maxY<low || tri.minY>high) continue;
    const {a,b,c}=tri;
    const faceY=(b.z-a.z)*(c.x-a.x)-(b.x-a.x)*(c.z-a.z);
    if(faceY<=1e-10) continue;
    const ax=(a.x/width+.5)*resolution, ay=(a.z/width+.5)*resolution;
    const bx=(b.x/width+.5)*resolution, by=(b.z/width+.5)*resolution;
    const cx=(c.x/width+.5)*resolution, cy=(c.z/width+.5)*resolution;
    const divisor=(by-cy)*(ax-cx)+(cx-bx)*(ay-cy);
    if(Math.abs(divisor)<1e-8) continue;
    const minX=Math.max(0,Math.ceil(Math.min(ax,bx,cx)-.5));
    const maxX=Math.min(resolution-1,Math.floor(Math.max(ax,bx,cx)-.5));
    const minZ=Math.max(0,Math.ceil(Math.min(ay,by,cy)-.5));
    const maxZ=Math.min(resolution-1,Math.floor(Math.max(ay,by,cy)-.5));
    if(maxX<minX || maxZ<minZ)continue;
    for(let py=minZ;py<=maxZ;py++){
      const z=py+.5;
      for(let px=minX;px<=maxX;px++){
        const x=px+.5;
        const w0=((by-cy)*(x-cx)+(cx-bx)*(z-cy))/divisor;
        const w1=((cy-ay)*(x-cx)+(ax-cx)*(z-cy))/divisor;
        const w2=1-w0-w1;
        if(w0<-.00001||w1<-.00001||w2<-.00001)continue;
        const surfaceY=a.y*w0+b.y*w1+c.y*w2;
        if(surfaceY<low || surfaceY>high)continue;
        const pixel=py*resolution+px;
        if(surfaceY<=maxY[pixel])continue;
        const vertex={
          r:a.r*w0+b.r*w1+c.r*w2,
          g:a.g*w0+b.g*w1+c.g*w2,
          b:a.b*w0+b.b*w1+c.b*w2,
          u:a.u*w0+b.u*w1+c.u*w2,
          v:a.v*w0+b.v*w1+c.v*w2
        };
        const channel=tri.mat?.map?.channel||0;
        if(channel){
          const uk='u'+channel,vk='v'+channel;
          vertex[uk]=(a[uk]??a.u)*w0+(b[uk]??b.u)*w1+(c[uk]??c.u)*w2;
          vertex[vk]=(a[vk]??a.v)*w0+(b[vk]??b.v)*w1+(c[vk]??c.v)*w2;
        }
        const rgb=sampleMaterial(tri.mat,vertex);
        if(!rgb)continue;
        maxY[pixel]=surfaceY;
        hits[pixel]=1;
        colors[pixel*3]=rgb[0];
        colors[pixel*3+1]=rgb[1];
        colors[pixel*3+2]=rgb[2];
      }
    }
  }
  return {hits,colors};
}

export function generateSlice(model, resolution, y, influence=0.75, layerHeight=model.bounds.height/24) {
  const segs=[];
  for(const tri of model.tris){
    const s=intersect(tri,y);if(s)segs.push(s);
  }
  const canvas=document.createElement('canvas');
  canvas.width=canvas.height=resolution;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const {edges,mask}=rasterContours(segs,resolution,model.bounds.width);
  const surface=sampleVisibleFaces(model,resolution,y,layerHeight);
  const n=resolution*resolution;
  const dist=new Float32Array(n).fill(Infinity);
  const r=new Uint8Array(n),g=new Uint8Array(n),b=new Uint8Array(n);
  const dirsX=new Float32Array(n),dirsY=new Float32Array(n);
  const heap=new MinHeap();
  // Sample the exact textured triangle boundary, not a generic silhouette color.
  // Seeds carry their original face's inward-projected normal.
  for(const s of edges){
    const dx=s.q.x-s.p.x,dy=s.q.y-s.p.y;
    const steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))*2));
    for(let step=0;step<=steps;step++){
      const t=step/steps;
      const x=Math.round(s.p.x+dx*t-.5),y=Math.round(s.p.y+dy*t-.5);
      if(x<0||x>=resolution||y<0||y>=resolution)continue;
      const i=y*resolution+x;
      const color=sampleSurface(s.mat,s.a,s.b,t);
      if(!color)continue;
      r[i]=color[0];g[i]=color[1];b[i]=color[2];
      dirsX[i]=s.nx;dirsY[i]=s.nz;
      mask[i]=1;dist[i]=0;
    }
  }
  for(let i=0;i<n;i++)if(dist[i]===0)heap.push(i,0);
  const neighbors=[[-1,0,1],[1,0,1],[0,-1,1],[0,1,1],
                   [-1,-1,Math.SQRT2],[1,-1,Math.SQRT2],[-1,1,Math.SQRT2],[1,1,Math.SQRT2]];
  while(heap.length){
    const popped=heap.pop(),i=popped.i,old=popped.v;
    if(old>dist[i]+1e-5)continue;
    const x=i%resolution,y=(i/resolution)|0;
    for(const [ox,oy,length] of neighbors){
      const xx=x+ox,yy=y+oy;
      if(xx<0||yy<0||xx>=resolution||yy>=resolution)continue;
      const j=yy*resolution+xx;if(!mask[j])continue;
      const normalDot=(dirsX[i]*ox+dirsY[i]*oy)/length;
      const directionalPenalty=(1-normalDot)*0.85*influence;
      const newCost=old+length*(1+directionalPenalty);
      if(newCost>=dist[j]-1e-5)continue;
      dist[j]=newCost;
      r[j]=r[i];g[j]=g[i];b[j]=b[i];
      dirsX[j]=dirsX[i];dirsY[j]=dirsY[i];
      heap.push(j,newCost);
    }
  }
  const out=ctx.createImageData(resolution,resolution);
  for(let i=0;i<n;i++)if(mask[i] && dist[i]<Infinity){
    out.data[i*4]=r[i];out.data[i*4+1]=g[i];out.data[i*4+2]=b[i];out.data[i*4+3]=255;
  }
  // Keep authentic texture texels wherever a visible sloped/top face crosses
  // this slab. Use inward boundary filling only for the remaining volume.
  for(let i=0;i<n;i++)if(surface.hits[i]){
    out.data[i*4]=surface.colors[i*3];
    out.data[i*4+1]=surface.colors[i*3+1];
    out.data[i*4+2]=surface.colors[i*3+2];
    out.data[i*4+3]=255;
  }
  ctx.putImageData(out,0,0);
  return canvas;
}

export function makeAtlas(slices,resolution,pad=2) {
  const columns=Math.ceil(Math.sqrt(slices.length));
  const rows=Math.ceil(slices.length/columns);
  const cell=resolution+pad*2;
  const canvas=document.createElement('canvas');
  canvas.width=cell*columns;canvas.height=cell*rows;
  const ctx=canvas.getContext('2d');
  ctx.imageSmoothingEnabled=false;
  const tiles=[];
  slices.forEach((slice,i)=>{
    const x=(i%columns)*cell+pad,y=Math.floor(i/columns)*cell+pad;
    ctx.drawImage(slice,x,y);
    tiles.push({index:i,x,y,width:resolution,height:resolution});
  });
  return {canvas,columns,rows,tiles,padding:pad};
}
