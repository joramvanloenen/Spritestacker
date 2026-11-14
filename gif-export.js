// A fixed palette across all frames avoids per-frame palette flashing.
// gifenc is fetched only when GIF export is requested, so the main editor
// still loads if the optional encoder CDN is temporarily unavailable.
const GIFENC_URL = 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/+esm';

export async function encodeTurntableGIF({
  capture,
  size = 384,
  frameCount = 48,
  fps = 20,
  onProgress = () => {},
  yieldControl = () => new Promise(resolve => setTimeout(resolve, 0))
}) {
  if(typeof capture !== 'function') throw new Error('GIF capture callback is missing.');
  if(!Number.isInteger(size) || size < 32 || size > 1024) throw new Error('Invalid GIF dimensions.');
  if(!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 120) throw new Error('Invalid GIF frame count.');
  if(!Number.isFinite(fps) || fps < 1 || fps > 50) throw new Error('Invalid GIF playback speed.');

  onProgress('Loading GIF encoder…', 0);
  const { GIFEncoder, quantize, applyPalette } = await import(GIFENC_URL);
  const paletteSize = Math.min(size, 96);
  const paletteSamples = Math.min(12, Math.max(6, Math.ceil(frameCount / 6)));
  const sampleBytes = new Uint8Array(paletteSamples * paletteSize * paletteSize * 4);
  onProgress('Sampling colors…', 0.04);
  for(let i=0;i<paletteSamples;i++){
    const pixelBytes = capture(i / paletteSamples, paletteSize);
    if(pixelBytes.length !== paletteSize * paletteSize * 4)
      throw new Error('Invalid preview capture dimensions.');
    sampleBytes.set(pixelBytes, i*pixelBytes.length);
    if(i%2===1){
      onProgress('Sampling colors…', 0.04 + (i+1)/paletteSamples*0.10);
      await yieldControl();
    }
  }

  // RGB 5-6-5 offers better quality than a uniform RGB 3-3-2 palette.
  // Color quantization is performed once, then reused for every angle.
  onProgress('Creating global palette…', 0.16);
  let palette = quantize(sampleBytes, 256, {format:'rgb565'});
  if(!palette?.length)throw new Error('Could not build a GIF color palette.');
  if(palette.length===1)palette.push([...palette[0]]);

  const delay = Math.max(20, Math.round((1000/fps)/10)*10);
  const gif=GIFEncoder({initialCapacity: 1024*1024});
  for(let i=0;i<frameCount;i++){
    // Angles 0..(N-1)/N: exclude 360° duplicate endpoint for a seamless loop.
    const rgba = capture(i/frameCount,size);
    if(rgba.length !== size*size*4)throw new Error('Invalid turntable frame dimensions.');
    const indexed=applyPalette(rgba,palette,'rgb565');
    gif.writeFrame(indexed,size,size,i===0
      ? {palette,repeat:0,delay,dispose:2}
      : {delay,dispose:2});
    if(i%2===1 || i===frameCount-1){
      onProgress('Encoding GIF '+(i+1)+' / '+frameCount+' frames…',0.18+0.82*(i+1)/frameCount);
      await yieldControl();
    }
  }
  gif.finish();
  return new Blob([gif.bytes()],{type:'image/gif'});
}
