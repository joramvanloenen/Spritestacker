# Spritestacker

Browser-based **3D model to sprite stack** converter. Import GLB, GLTF, OBJ (+ MTL), STL, or FBX. For external textures, select all related assets together.

**Live site when GitHub Pages is enabled:** https://joramvanloenen.github.io/Spritestacker/

## Features

- Y-axis slicing: horizontal cuts rendered as top-down XZ images, ordered bottom to top.
- Polygon-boundary sampling using UV textures and material color.
- Inward-normal directed fill: a multi-source Dijkstra pixel flood with per-surface directional propagation cost.
- Independent closed contour fill: converts internal cavities and other enclosed regions into continuous colored silhouette.
- Extruded layer preview: generates vertical side-wall geometry for each exposed texel edge. With thickness set to 100% or more, adjacent layers overlap to prevent visible cracks.
- Animated 45° azimuth orthographic view, orbit/zoom, PNG atlas export, and JSON metadata.
- Adjustable layers, sprite resolution (16–256 px, slider, presets and custom exact pixel size), fill direction influence, layer slab thickness, rotation speed. Live atlas dimension estimate reflects both resolution and layer count.
- **Looping GIF turntable:** export 24–72 frames of a full 360° rotation at 256/384/512 px and selectable playback speed. Frame 360° is excluded, making the animation join seamlessly to frame 0, while the GIF repeat flag loops forever.
- **Shared preview/export environment:** choose a solid background color and show or hide the ground grid. Both settings affect the preview and the exported GIF.
- Entirely local browser processing with no server-side model uploads. A sample rover is included.

## How to use

1. Open the app and drop a 3D model onto the upload box.
2. Set layer count, resolution and inward-normal influence; click **Generate sprite stack**.
3. Adjust **Extrude each layer** and slab thickness without regenerating the atlas.
4. Inspect one layer, rotate the preview, export PNG atlas and matching JSON.
5. Set the background and grid visibility in the Export panel. Choose GIF size, frame count and frame rate, then click **Export looping GIF**.

The atlas has a two-pixel margin around tiles. Each tile uses the same square footprint so stacking aligns. JSON includes tile coordinates, slice heights, world-space dimensions, and output settings.

## Implementation

For each evenly spaced horizontal plane, the app intersects mesh triangles with Y, reconstructs loops, raster-fills closed contours individually (so hollow enclosed shapes are visually solid), samples polygon UV/material **edge texels**, then extends each color **into** the filled region. Propagation along the originating polygon's projected inward normal is cheaper than propagation against it, preserving distinct material directions in the interior instead of applying generic nearest-pixel dilation. **Upward-facing textured polygon fragments within each layer's vertical range are additionally sampled per pixel using barycentric UV interpolation and a height buffer**, retaining painted details on roofs and sloped faces. The albedo sampler respects the texture's UV channel, UV transform/flip, and material/vertex color multipliers in linear light before encoding sRGB. The source-model panel reports how many diffuse image textures were found. Open meshes use a parity-scanline fallback where closed loops are not available.

The orthographic preview places nearest-neighbor horizontal textured quads at slice heights. Extrusion creates quads along opaque pixel edges to cover gaps, with separately adjustable thickness.

## Limitations

Needs a model with vertical extent and triangles. Non-manifold/open models may produce imperfect silhouettes; physically based material effects, skeletal animation and texture normal maps are not baked. High triangle counts and 96 × 256 slices can take substantial CPU time.

## Deployment

This is a static app (Three.js via CDN and gifenc 1.0.3 via jsDelivr, loaded on demand); no build step. The repository includes `.github/workflows/deploy.yml`, which publishes on push. GitHub Pages must be enabled **once** in **Settings → Pages → Build and deployment → Source: GitHub Actions**. The default `GITHUB_TOKEN` cannot enable Pages when the site has not been provisioned. After enabling, rerun the workflow if the initial run failed.
