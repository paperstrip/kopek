import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let scene;
let camera;
let renderer;
let controls;
let canvasElement;
let containerElement;
let worldRoot;
let mapRoot;
let overlayRoot;
let raycaster;
let mouse;
let hoveredObject = null;
let selectedObject = null;
let pointerDownInfo = null;
let isInitialized = false;
let assetsReady = false;
let pendingWorldData = null;
let heightCache = null;

const textureLoader = new THREE.TextureLoader();
const textures = {};
const interactiveObjects = [];
const dynamicActors = [];
const focusTargets = new Map();
const ambientSprites = [];

function loaderEl() { return document.getElementById('empire-loader'); }
function loaderTextEl() { return document.getElementById('empire-loader-text'); }

function setLoader(visible, text = '') {
  const el = loaderEl();
  if (!el) return;
  el.classList.toggle('hidden', !visible);
  if (text && loaderTextEl()) loaderTextEl().textContent = text;
}

async function loadTexture(url, repeatX = 1, repeatY = 1, srgb = true) {
  const tex = await textureLoader.loadAsync(url);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function fallbackDataTexture(tileSize, hue, lightness) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${hue}, 20%, ${lightness}%)`;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2800; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const a = 0.08 + Math.random() * 0.12;
    ctx.fillStyle = `hsla(${hue + (Math.random() * 30 - 15)}, 24%, ${42 + Math.random() * 20}%, ${a})`;
    ctx.fillRect(x, y, 0.8 + Math.random() * 1.4, 0.8 + Math.random() * 1.4);
  }
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

function fallbackNormalTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const noise = Math.random() * 0.25;
      img.data[i] = 128 + Math.sin(x * 0.25) * 12 + noise * 40;
      img.data[i + 1] = 128 + Math.cos(y * 0.22) * 12 + noise * 40;
      img.data[i + 2] = 220;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

async function ensureAssets() {
  if (assetsReady) return;
  setLoader(true, 'Préparation des reliefs, des textures de pierre et des cieux impériaux…');

  const safeFallback = async (url, rx, ry, hue, light) => {
    try {
      return await loadTexture(url, rx, ry);
    } catch {
      return fallbackDataTexture(rx, hue, light);
    }
  };

  const safeNormalFallback = async (url, rx, ry) => {
    try {
      const tex = await textureLoader.loadAsync(url);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(rx, ry);
      return tex;
    } catch {
      return fallbackNormalTexture();
    }
  };

  [
    textures.grass,
    textures.stoneColor,
    textures.stoneNormal,
    textures.stoneRough,
    textures.woodColor,
    textures.waterNormal,
    textures.sand,
    textures.plaza,
  ] = await Promise.all([
    safeFallback('./assets/textures/sol_herbe.jpg', 8, 8, 95, 56),
    safeFallback('./assets/textures/mur_couleur.jpg', 3, 3, 35, 74),
    safeNormalFallback('./assets/textures/mur_relief.jpg', 3, 3),
    safeFallback('./assets/textures/mur_rugosite.jpg', 3, 3, 30, 58),
    safeFallback('./assets/textures/bois_couleur.jpg', 3, 3, 28, 46),
    safeNormalFallback('./assets/textures/eau_normales.jpg', 10, 10),
    safeFallback('./assets/textures/sol_herbe.jpg', 6, 6, 40, 70),
    safeFallback('./assets/textures/mur_couleur.jpg', 2, 2, 48, 72),
  ]);

  assetsReady = true;
  if (pendingWorldData) {
    rebuildWorld(pendingWorldData);
    pendingWorldData = null;
  }
  setLoader(false);
}

function clearWorld() {
  [worldRoot, mapRoot, overlayRoot].forEach((root) => {
    if (!root) return;
    while (root.children.length) root.remove(root.children[0]);
  });
  interactiveObjects.length = 0;
  dynamicActors.length = 0;
  focusTargets.clear();
  ambientSprites.length = 0;
  heightCache = null;
}

function stoneMaterial(tint = 0x9f937c) {
  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    map: textures.stoneColor,
    normalMap: textures.stoneNormal,
    roughnessMap: textures.stoneRough,
    roughness: 0.97,
    metalness: 0.0,
  });
  if (mat.map) { mat.map.repeat.set(4, 4); mat.map.needsUpdate = true; }
  if (mat.normalMap) { mat.normalMap.repeat.set(4, 4); mat.normalMap.needsUpdate = true; }
  if (mat.roughnessMap) { mat.roughnessMap.repeat.set(4, 4); mat.roughnessMap.needsUpdate = true; }
  return mat;
}

function roofMaterial(tint = 0x5a2f24) {
  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    map: textures.woodColor,
    roughness: 0.95,
    metalness: 0.0,
  });
  if (mat.map) { mat.map.repeat.set(5, 5); mat.map.needsUpdate = true; }
  return mat;
}

function grassMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x5c7244,
    map: textures.grass,
    roughness: 1,
    metalness: 0,
  });
  if (mat.map) { mat.map.repeat.set(12, 12); mat.map.needsUpdate = true; }
  return mat;
}

function waterMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: 0x15293a,
    metalness: 0.0,
    roughness: 0.06,
    transmission: 0.08,
    thickness: 1.8,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    normalMap: textures.waterNormal,
    normalScale: new THREE.Vector2(0.55, 0.55),
  });
}

function sandMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xa89676,
    map: textures.sand,
    roughness: 1,
    metalness: 0,
  });
  if (mat.map) {
    mat.map.repeat.set(10, 10);
    mat.map.needsUpdate = true;
  }
  return mat;
}

function plazaMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xaca08c,
    map: textures.plaza,
    roughness: 0.98,
    metalness: 0.0,
  });
  if (mat.map) {
    mat.map.repeat.set(5, 5);
    mat.map.needsUpdate = true;
  }
  return mat;
}

function setMaterialHighlight(object, active) {
  if (!object || !object.material) return;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  materials.forEach((mat) => {
    if (!('emissive' in mat)) return;
    mat.emissive = new THREE.Color(active ? 0xf59e0b : 0x000000);
    mat.emissiveIntensity = active ? 0.18 : 0;
  });
}

function attachInspectable(mesh, data, focusKey = null) {
  mesh.userData = { ...data, inspectable: true, focusKey };
  interactiveObjects.push(mesh);
}

function isCompactViewport() {
  return window.innerWidth < 640;
}

function cameraFocusOffset() {
  return isCompactViewport()
    ? new THREE.Vector3(48, 58, 70)
    : new THREE.Vector3(78, 88, 108);
}

function focusCamera(focus, immediate = false) {
  if (!camera || !controls || !focus) return;
  const target = focus.clone ? focus.clone() : new THREE.Vector3(focus.x, focus.y, focus.z);
  const position = target.clone().add(cameraFocusOffset());
  if (immediate) {
    controls.target.copy(target);
    camera.position.copy(position);
  } else {
    controls.target.lerp(target, 0.92);
    camera.position.lerp(position, 0.92);
  }
  controls.update();
}

function createSkyDome() {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 768;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 768);
  grad.addColorStop(0, '#0a0818');
  grad.addColorStop(0.15, '#1a1638');
  grad.addColorStop(0.32, '#2e224a');
  grad.addColorStop(0.48, '#6b3a5a');
  grad.addColorStop(0.62, '#b4543a');
  grad.addColorStop(0.78, '#e68a44');
  grad.addColorStop(1, '#f2c07a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 16, 768);
  const tex = new THREE.CanvasTexture(canvas);
  const geo = new THREE.SphereGeometry(900, 48, 24);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false });
  const sky = new THREE.Mesh(geo, mat);
  scene.add(sky);

  const stars = new THREE.BufferGeometry();
  const count = 520;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 620 + Math.random() * 120;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI * 0.4;
    positions[i * 3] = Math.cos(theta) * Math.sin(phi) * r;
    positions[i * 3 + 1] = Math.cos(phi) * r * 0.9;
    positions[i * 3 + 2] = Math.sin(theta) * Math.sin(phi) * r;
  }
  stars.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffdfa5, size: 1.4, sizeAttenuation: true, transparent: true, opacity: 0.75 });
  scene.add(new THREE.Points(stars, starMat));
}

function createAtmosphereLayers() {
  const colors = [
    { color: '#3b82f6', opacity: 0.08, y: 12, scale: 180 },
    { color: '#a855f7', opacity: 0.07, y: 9, scale: 240 },
    { color: '#f59e0b', opacity: 0.05, y: 6, scale: 320 },
  ];
  colors.forEach((c) => {
    const geo = new THREE.CircleGeometry(c.scale, 48);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(c.color), transparent: true, opacity: c.opacity, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = c.y;
    scene.add(m);
  });

  const dist = 560;
  for (let i = 0; i < 26; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.06)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(128, 64, 120, 42, 0, 0, Math.PI * 2);
    ctx.fill();
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.45 });
    const sprite = new THREE.Sprite(mat);
    const a = (i / 26) * Math.PI * 2;
    sprite.position.set(Math.cos(a) * dist, 26 + Math.random() * 22, Math.sin(a) * dist);
    sprite.scale.set(220 + Math.random() * 120, 80 + Math.random() * 50, 1);
    sprite.userData.drift = 0.02 + Math.random() * 0.03;
    sprite.userData.phase = Math.random() * Math.PI * 2;
    scene.add(sprite);
    ambientSprites.push(sprite);
  }
}

function setupLighting() {
  scene.add(new THREE.AmbientLight(0x8a86a8, 0.28));

  const hemi = new THREE.HemisphereLight(0x8da0bd, 0x2a241a, 0.48);
  hemi.position.set(0, 180, 0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffbe80, 1.8);
  sun.position.set(-210, 80, -60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 540;
  sun.shadow.camera.left = -260;
  sun.shadow.camera.right = 260;
  sun.shadow.camera.top = 260;
  sun.shadow.camera.bottom = -260;
  sun.shadow.bias = -0.0003;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x5566aa, 0.45);
  fill.position.set(140, 90, 160);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xff8e5e, 0.65);
  rim.position.set(150, 40, -180);
  scene.add(rim);

  const groundBounce = new THREE.DirectionalLight(0x554028, 0.22);
  groundBounce.position.set(0, -80, 0);
  scene.add(groundBounce);
}

function buildHeightmap(size) {
  if (heightCache && heightCache.size === size) return heightCache.data;
  const data = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      const ny = y / size;
      const d = Math.hypot(nx - 0.5, ny - 0.5);
      const edge = Math.max(0, d - 0.34);
      const base = -Math.sin(Math.min(1.0, edge * 5.4)) * 9;
      const n1 = Math.sin(nx * 11.3) * Math.cos(ny * 12.1) * 0.8;
      const n2 = Math.sin((nx + 0.31) * 6.4 + ny * 7.6) * 0.65;
      const n3 = Math.cos((nx + 0.13) * 4.8) * Math.sin((ny + 0.05) * 3.9) * 0.45;
      row.push(base + n1 + n2 + n3);
    }
    data.push(row);
  }
  heightCache = { size, data };
  return data;
}

function sampleHeight(data, size, x, z, worldScale) {
  const s = size - 1;
  const u = Math.max(0, Math.min(1, (x / worldScale + 0.5)));
  const v = Math.max(0, Math.min(1, (z / worldScale + 0.5)));
  const ix = u * s;
  const iz = v * s;
  const x0 = Math.floor(ix);
  const z0 = Math.floor(iz);
  const x1 = Math.min(s, x0 + 1);
  const z1 = Math.min(s, z0 + 1);
  const fx = ix - x0;
  const fz = iz - z0;
  const a = data[z0][x0];
  const b = data[z0][x1];
  const c = data[z1][x0];
  const d = data[z1][x1];
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fz;
}

function createMountainRing() {
  const group = new THREE.Group();
  const mat = stoneMaterial(0xc7bfad);
  for (let i = 0; i < 22; i++) {
    const angle = (i / 22) * Math.PI * 2 + Math.PI / 14;
    const radius = 300 + ((i % 4) * 18);
    const height = 50 + ((i % 5) * 18);
    const ring = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(18 + (i % 5) * 5, 28 + (i % 5) * 6, height * 0.7, 14),
      mat.clone(),
    );
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(14 + (i % 5) * 3, height * 0.6, 10),
      stoneMaterial(0xb5ad9a),
    );
    cone.position.y = height * 0.65;
    base.position.y = height * 0.35;
    base.castShadow = true;
    base.receiveShadow = true;
    cone.castShadow = true;
    ring.add(base);
    ring.add(cone);
    ring.position.set(Math.cos(angle) * radius, -8, Math.sin(angle) * radius);
    ring.rotation.y = angle;
    group.add(ring);
  }
  worldRoot.add(group);
}

function createOcean() {
  const oceanGeo = new THREE.CircleGeometry(520, 96);
  const oceanMat = waterMaterial();
  const ocean = new THREE.Mesh(oceanGeo, oceanMat);
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = -3.2;
  ocean.receiveShadow = true;
  worldRoot.add(ocean);

  dynamicActors.push({
    update(time) {
      oceanMat.normalMap.offset.x = (time * 0.012) % 1;
      oceanMat.normalMap.offset.y = (time * 0.009) % 1;
    },
  });
}

function createLandmass(heightmap, heightmapSize, worldScale) {
  const segments = 220;
  const geo = new THREE.PlaneGeometry(worldScale, worldScale, segments, segments);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getY(i);
    const h = sampleHeight(heightmap, heightmapSize, x, z, worldScale);
    pos.setZ(i, h);
  }
  geo.computeVertexNormals();
  geo.rotateX(-Math.PI / 2);
  const mat = grassMaterial();
  const land = new THREE.Mesh(geo, mat);
  land.position.y = 0;
  land.receiveShadow = true;
  mapRoot.add(land);
  return { land, worldScale };
}

function createRiver(heightmap, heightmapSize, worldScale, terrainAltitude) {
  const points = [];
  const count = 80;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const nx = -0.42 + t * 0.72;
    const nz = -0.22 + t * 0.76 + Math.sin(t * 9) * 0.03;
    const x = nx * worldScale;
    const z = nz * worldScale;
    const alt = terrainAltitude(x, z) + 0.05;
    points.push(new THREE.Vector3(x, alt, z));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  const tube = new THREE.TubeGeometry(curve, 160, 2.2, 8, false);
  const riverMat = waterMaterial();
  const mesh = new THREE.Mesh(tube, riverMat);
  mesh.receiveShadow = true;
  mapRoot.add(mesh);
  dynamicActors.push({
    update(time) {
      riverMat.normalMap.offset.x = (time * 0.015) % 1;
    },
  });
}

function createRoadSegment(points, width) {
  const curve = new THREE.CatmullRomCurve3(points);
  const geo = new THREE.TubeGeometry(curve, points.length * 18, width, 8, false);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8d7a56,
    roughness: 0.98,
    metalness: 0,
    map: textures.plaza,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function createDistrictRoads(landAltitude, provinceSlots) {
  provinceSlots.forEach((slot) => {
    const center = new THREE.Vector3(slot.x, 0, slot.z);
    const up = new THREE.Vector3(-slot.radius / 2.5, 0, -slot.radius / 2.8);
    const dir = center.clone().normalize();
    const gate = dir.clone().multiplyScalar(slot.radius * 0.95);
    const alt = (x, z) => landAltitude(x, z) + 0.08;
    const pts = [];
    pts.push(new THREE.Vector3(center.x - slot.radius / 2, alt(center.x - slot.radius / 2, center.z), center.z));
    pts.push(new THREE.Vector3(center.x, alt(center.x, center.z), center.z));
    pts.push(new THREE.Vector3(center.x + slot.radius / 3, alt(center.x + slot.radius / 3, center.z - slot.radius / 3), center.z - slot.radius / 3));
    pts.push(new THREE.Vector3(gate.x * 0.82, alt(gate.x * 0.82, gate.z * 0.82), gate.z * 0.82));
    pts.push(new THREE.Vector3(0, alt(0, -6), -6));
    const road = createRoadSegment(pts, 1.6);
    mapRoot.add(road);
    slot.anchor = up;
  });

  const mainLoop = [];
  const ringCount = 54;
  const radius = 74;
  for (let i = 0; i <= ringCount; i++) {
    const a = (i / ringCount) * Math.PI * 2;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius * 0.86;
    mainLoop.push(new THREE.Vector3(x, landAltitude(x, z) + 0.08, z));
  }
  mapRoot.add(createRoadSegment(mainLoop, 2.2));
}

function createTree(scale = 1) {
  const group = new THREE.Group();
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x463322, roughness: 0.98 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x35582e, roughness: 0.94 });
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * scale, 0.18 * scale, 1.6 * scale, 7), trunkMat);
  trunk.position.y = 0.8 * scale;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  group.add(trunk);
  for (let i = 0; i < 3; i++) {
    const s = 1 - i * 0.22;
    const leaves = new THREE.Mesh(new THREE.SphereGeometry(0.72 * scale * s, 7, 7), leafMat);
    leaves.position.set((Math.random() - 0.5) * 0.25 * scale, (1.5 + i * 0.4) * scale, (Math.random() - 0.5) * 0.25 * scale);
    leaves.castShadow = true;
    group.add(leaves);
  }
  return group;
}

function scatterForest(landAltitude, worldScale) {
  const forest = new THREE.Group();
  for (let i = 0; i < 240; i++) {
    const x = (Math.random() - 0.5) * worldScale * 0.88;
    const z = (Math.random() - 0.5) * worldScale * 0.88;
    const h = sampleHeight(heightCache.data, heightCache.size, x, z, worldScale);
    if (h < 0.6) continue;
    if (Math.hypot(x, z) < 28) continue;
    const dist = Math.hypot(x, z);
    if (dist > worldScale * 0.4) continue;
    const scale = 0.45 + Math.random() * 0.7;
    const tree = createTree(scale);
    tree.position.set(x, landAltitude(x, z), z);
    tree.rotation.y = Math.random() * Math.PI * 2;
    forest.add(tree);
  }
  mapRoot.add(forest);
}

function createPlaza(center, size, landAltitude) {
  const thick = 0.18;
  const geo = new THREE.BoxGeometry(size, thick, size);
  const mesh = new THREE.Mesh(geo, plazaMaterial());
  mesh.position.set(center.x, landAltitude(center.x, center.z) + thick / 2 + 0.02, center.z);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mapRoot.add(mesh);

  const borderStone = stoneMaterial(0xe6d9bf);
  const border = 0.22;
  const outer = size / 2 + border;
  const inner = size / 2;
  const parts = [
    [outer, border, outer, inner, border, 0, inner, 0],
  ];
  parts.forEach(() => {
    const s1 = size + border * 2;
    const frameOuter = new THREE.Mesh(new THREE.BoxGeometry(s1, 0.22, border), borderStone);
    frameOuter.position.set(center.x, landAltitude(center.x, center.z) + 0.12, center.z - inner - border / 2);
    frameOuter.castShadow = true;
    mapRoot.add(frameOuter);
    const frameInner = frameOuter.clone();
    frameInner.position.z = center.z + inner + border / 2;
    mapRoot.add(frameInner);
    const side1 = new THREE.Mesh(new THREE.BoxGeometry(border, 0.22, s1), borderStone);
    side1.position.set(center.x - inner - border / 2, landAltitude(center.x, center.z) + 0.12, center.z);
    side1.castShadow = true;
    mapRoot.add(side1);
    const side2 = side1.clone();
    side2.position.x = center.x + inner + border / 2;
    mapRoot.add(side2);
  });
  return mesh;
}

function createColumnBuilding(width, depth, height, tint = 0x9e9282, roofTint = 0x5a2f24) {
  const group = new THREE.Group();
  const stone = stoneMaterial(tint);
  const roof = roofMaterial(roofTint);

  const base = new THREE.Mesh(new THREE.BoxGeometry(width + 1.4, 1.6, depth + 1.4), stoneMaterial(0x8a7e6e));
  base.position.y = 0.8;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const step = new THREE.Mesh(new THREE.BoxGeometry(width + 0.6, 0.6, depth + 0.6), stoneMaterial(0x9a8e7d));
  step.position.y = 1.9;
  step.castShadow = true;
  base.receiveShadow = true;
  group.add(step);

  const columns = 6;
  const spacingX = width / (columns - 1);
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < columns; i++) {
      const x = -width / 2 + i * spacingX;
      const z = side * depth * 0.3;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.32, height - 1, 12), stoneMaterial(0xb0a492));
      col.position.set(x, 2.2 + (height - 1) / 2, z);
      col.castShadow = true;
      col.receiveShadow = true;
      group.add(col);
    }
  }

  const body = new THREE.Mesh(new THREE.BoxGeometry(width * 0.84, height - 1.5, depth * 0.66), stoneMaterial(0xa49988));
  body.position.y = 2.3 + (height - 1.5) / 2;
  body.castShadow = true;
  group.add(body);

  const entablature = new THREE.Mesh(new THREE.BoxGeometry(width + 1, 0.9, depth + 0.8), stoneMaterial(0x8e8272));
  entablature.position.y = 2.2 + (height - 1) + 0.45;
  entablature.castShadow = true;
  group.add(entablature);

  const pediment = new THREE.Mesh(new THREE.ConeGeometry(width * 0.62, 3.2, 4), roof);
  pediment.position.y = 2.2 + (height - 1) + 2.6;
  pediment.rotation.y = Math.PI / 4;
  pediment.castShadow = true;
  group.add(pediment);

  return group;
}

function createTenement(w = 6, d = 7, h = 10) {
  const group = new THREE.Group();
  const stone = stoneMaterial(0x968a7a);
  const roof = roofMaterial(0x5a2f24);
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stone);
  body.position.y = h / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  for (let z = -1; z <= 1; z += 2) {
    for (let i = 0; i < Math.floor(h / 2.2); i++) {
      const y = 1 + i * 2.2;
      for (let x = -1; x <= 1; x++) {
        const wx = x * (w / 3.2);
        const win = new THREE.Mesh(
          new THREE.BoxGeometry(0.6, 0.8, 0.1),
          new THREE.MeshStandardMaterial({ color: 0x3a2e1d, emissive: 0xffa64d, emissiveIntensity: 0.38, roughness: 0.25, metalness: 0.05 }),
        );
        win.position.set(wx, y, (z * d) / 2 + (z * 0.06));
        group.add(win);
      }
    }
  }

  const roofMesh = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.84, 2.6, 4), roof);
  roofMesh.rotation.y = Math.PI / 4;
  roofMesh.position.y = h + 1.3;
  roofMesh.castShadow = true;
  group.add(roofMesh);

  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.8, 0.6), stoneMaterial(0x7e7366));
  chimney.position.set(w / 4, h + 2, -d / 4);
  chimney.castShadow = true;
  group.add(chimney);
  return group;
}

function createWarehouse(w = 11, d = 8, h = 6) {
  const group = new THREE.Group();
  const walls = stoneMaterial(0x8a7e6e);
  const roof = roofMaterial(0x5a2f24);
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), walls);
  body.position.y = h / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const arches = Math.max(3, Math.round(w / 2.6));
  for (let i = 0; i < arches; i++) {
    const x = -w / 2 + (w / (arches - 1)) * i;
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 2.4, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.95 }),
    );
    door.position.set(x, 1.2, d / 2 + 0.12);
    group.add(door);
  }
  const roofMesh = new THREE.Mesh(new THREE.BoxGeometry(w + 0.5, 1.1, d + 0.5), roof);
  roofMesh.position.y = h + 0.55;
  roofMesh.castShadow = true;
  group.add(roofMesh);
  return group;
}

function createDock(size = 1) {
  const group = new THREE.Group();
  const dock = new THREE.Mesh(
    new THREE.BoxGeometry(9 * size, 0.9, 20 * size),
    new THREE.MeshStandardMaterial({ color: 0x7a5a3d, roughness: 0.96, map: textures.woodColor }),
  );
  dock.position.y = 0.45;
  dock.castShadow = true;
  dock.receiveShadow = true;
  group.add(dock);

  for (let i = -1; i <= 1; i++) {
    const p = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 3.8, 10),
      new THREE.MeshStandardMaterial({ color: 0x5a4226, roughness: 0.95 }),
    );
    p.position.set(i * 2.4 * size, 1.9, 9.2 * size);
    p.castShadow = true;
    group.add(p);
  }

  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xffb347, emissiveIntensity: 1.1 }),
  );
  lamp.position.set(-4 * size, 2.7, -9 * size);
  group.add(lamp);
  return group;
}

function createShip(color = 0xaa5a35, scale = 1) {
  const group = new THREE.Group();
  const hullMat = roofMaterial(color);
  const hull = new THREE.Mesh(new THREE.BoxGeometry(2.6 * scale, 1.3 * scale, 9 * scale), hullMat);
  hull.position.y = 0.65 * scale;
  hull.castShadow = true;
  hull.receiveShadow = true;
  group.add(hull);
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13 * scale, 0.13 * scale, 7.2 * scale, 8),
    new THREE.MeshStandardMaterial({ color: 0x533a23, roughness: 1 }),
  );
  mast.position.y = 4.2 * scale;
  mast.castShadow = true;
  group.add(mast);
  const sail = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2 * scale, 4.2 * scale),
    new THREE.MeshStandardMaterial({ color: 0xf7f0dd, side: THREE.DoubleSide, roughness: 0.92 }),
  );
  sail.position.set(0, 4.6 * scale, -0.1);
  group.add(sail);
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9 * scale, 0.5 * scale),
    new THREE.MeshStandardMaterial({ color: 0xef4444, side: THREE.DoubleSide, roughness: 0.8 }),
  );
  flag.position.set(0.45 * scale, 7.4 * scale, 0);
  group.add(flag);
  dynamicActors.push({
    update(time) {
      flag.rotation.y = Math.sin(time * 1.5 + scale * 10) * 0.4;
    },
  });
  return group;
}

function createBanner(color = '#8b5cf6', height = 10) {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.1, height, 8),
    new THREE.MeshStandardMaterial({ color: 0x4f3a24, roughness: 0.95 }),
  );
  pole.position.y = height / 2;
  pole.castShadow = true;
  group.add(pole);
  const cloth = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 2.4),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(color), side: THREE.DoubleSide, roughness: 0.8 }),
  );
  cloth.position.set(1.7, height - 1.2, 0);
  group.add(cloth);
  dynamicActors.push({
    update(time) {
      cloth.rotation.y = Math.sin(time * 1.4 + height) * 0.22;
      cloth.position.z = Math.sin(time * 1.7 + height) * 0.6;
    },
  });
  return group;
}

function createLabelSprite(title, subtitle, color, size = { w: 14, h: 4.5 }) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 320;
  const ctx = canvas.getContext('2d');
  const padding = 28;
  const w = canvas.width - padding * 2;
  const h = canvas.height - padding * 2;
  const r = 56;
  ctx.save();
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, 'rgba(7,11,18,0.92)');
  gradient.addColorStop(1, 'rgba(15,23,42,0.88)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(padding + r, padding);
  ctx.arcTo(padding + w, padding, padding + w, padding + h, r);
  ctx.arcTo(padding + w, padding + h, padding, padding + h, r);
  ctx.arcTo(padding, padding + h, padding, padding, r);
  ctx.arcTo(padding, padding, padding + w, padding, r);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.stroke();
  ctx.restore();

  const accent = 10;
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = color;
  ctx.fillRect(padding + 16, padding + 22, 4, 74);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.font = '700 30px Inter, ui-sans-serif, system-ui';
  ctx.fillText(title.toUpperCase(), padding + 46, padding + 76);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 72px Inter, ui-sans-serif, system-ui';
  ctx.fillText(subtitle, padding + 46, padding + 190);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(size.w, size.h, 1);
  return sprite;
}

function scatterRuin(x, z, alt) {
  const ruin = new THREE.Group();
  const stone = stoneMaterial(0xb9ae92);
  for (let i = 0; i < 3; i++) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 3.4 + Math.random() * 2.4, 10), stone);
    col.position.set(x + (i - 1) * 1.2, (col.geometry.parameters.height) / 2, z + (Math.random() - 0.5) * 2);
    col.rotation.z = (Math.random() - 0.5) * 0.4;
    col.castShadow = true;
    ruin.add(col);
  }
  ruin.position.y = alt;
  mapRoot.add(ruin);
}

function createProvince(slot, data, landAltitude) {
  const province = new THREE.Group();
  const center = new THREE.Vector3(slot.x, 0, slot.z);
  const radius = slot.radius;
  const alt = (x, z) => landAltitude(x, z);

  const walls = new THREE.Group();
  const wallMat = stoneMaterial(0xd6c7a7);
  const crenelMat = stoneMaterial(0xc1b28f);
  const segments = 28;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2 + 0.1;
    const x = center.x + Math.cos(a) * radius * 0.92;
    const z = center.z + Math.sin(a) * radius * 0.92;
    const segLen = (2 * Math.PI * radius) / segments * 0.9;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(segLen, 4.4, 1.25), wallMat);
    wall.position.set(x, alt(x, z) + 2.2, z);
    wall.lookAt(center.x, alt(x, z) + 2.2, center.z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    walls.add(wall);

    if (i % 2 === 0) {
      const cren = new THREE.Mesh(new THREE.BoxGeometry(segLen * 0.75, 0.6, 1.3), crenelMat);
      cren.position.set(x, alt(x, z) + 4.7, z);
      cren.lookAt(center.x, alt(x, z) + 4.7, center.z);
      cren.castShadow = true;
      walls.add(cren);
    }
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const tx = center.x + Math.cos(a) * radius * 0.92;
    const tz = center.z + Math.sin(a) * radius * 0.92;
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.2, 8.2, 12), wallMat);
    tower.position.set(tx, alt(tx, tz) + 4.1, tz);
    tower.castShadow = true;
    tower.receiveShadow = true;
    walls.add(tower);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 1.1, 12), crenelMat);
    crown.position.set(tx, alt(tx, tz) + 8.8, tz);
    crown.castShadow = true;
    walls.add(crown);
  }
  province.add(walls);

  const plaza = new THREE.Vector3(center.x, 0, center.z);
  createPlaza(plaza, 18, landAltitude);

  if (slot.isMain) {
    const capitol = createColumnBuilding(18, 24, 18, 0xf2e7cd, 0x9a573a);
    capitol.position.set(center.x, alt(center.x, center.z) + 0.2, center.z);
    capitol.castShadow = true;
    province.add(capitol);

    const forum = createColumnBuilding(12, 10, 9, 0xece0c8, 0x8e5835);
    forum.position.set(center.x - 14, alt(center.x - 14, center.z + 10) + 0.15, center.z + 10);
    forum.rotation.y = 0.8;
    forum.castShadow = true;
    province.add(forum);

    const towerA = createColumnBuilding(6, 6, 26, 0xefdfc0, 0x7b482d);
    towerA.scale.setScalar(0.85);
    towerA.position.set(center.x + 13, alt(center.x + 13, center.z - 10) + 0.2, center.z - 10);
    towerA.castShadow = true;
    province.add(towerA);

    const wonderHall = createColumnBuilding(16, 20, 22, 0xf4e8d2, 0x8c5336);
    wonderHall.position.set(center.x - 8, alt(center.x - 8, center.z - 16) + 0.1, center.z - 16);
    wonderHall.rotation.y = -0.4;
    wonderHall.castShadow = true;
    wonderHall.visible = data.empireView.state.wonders > 0;
    province.add(wonderHall);
  } else {
    const districtCenter = new THREE.Vector3(center.x, 0, center.z);
    const mainTemple = createColumnBuilding(9, 12, 12, 0xe9dcc2, 0x8a5536);
    mainTemple.position.set(districtCenter.x, alt(districtCenter.x, districtCenter.z) + 0.15, districtCenter.z);
    mainTemple.castShadow = true;
    province.add(mainTemple);
  }

  const blockCount = slot.isMain ? 16 : 9;
  for (let i = 0; i < blockCount; i++) {
    const t = i / blockCount;
    const a = t * Math.PI * 2.7;
    const r = radius * 0.22 + (i % 4) * (radius * 0.13);
    const bx = center.x + Math.cos(a) * r;
    const bz = center.z + Math.sin(a) * r;
    const build = slot.isMain || i % 3 === 0
      ? createTenement(5.2 + Math.random() * 2.2, 5.2 + Math.random() * 2.2, 8 + Math.random() * 9)
      : createWarehouse(9 + Math.random() * 3, 6 + Math.random() * 2, 5 + Math.random() * 2.5);
    build.position.set(bx, alt(bx, bz), bz);
    build.rotation.y = a + Math.random() * 0.6;
    build.castShadow = true;
    province.add(build);
  }

  if (slot.hasHarbor) {
    const outward = center.clone().setY(0).normalize().multiplyScalar(radius * 0.95);
    const dock = createDock(slot.isMain ? 1.15 : 0.9);
    const dockPos = new THREE.Vector3(center.x + outward.x, 0, center.z + outward.z);
    dock.position.set(dockPos.x, alt(dockPos.x, dockPos.z) - 0.8, dockPos.z);
    dock.lookAt(center.x, dock.position.y, center.z);
    dock.castShadow = true;
    province.add(dock);
  }

  for (let i = 0; i < (slot.isMain ? 34 : 18); i++) {
    const a = Math.random() * Math.PI * 2;
    const r = radius * (0.06 + Math.random() * 0.72);
    const tx = center.x + Math.cos(a) * r;
    const tz = center.z + Math.sin(a) * r;
    const s = 0.5 + Math.random() * 0.7;
    const tree = createTree(s);
    tree.position.set(tx, alt(tx, tz), tz);
    tree.rotation.y = Math.random() * Math.PI * 2;
    province.add(tree);
  }

  const banner = createBanner(slot.color, slot.isMain ? 13 : 9);
  const angle = Math.atan2(center.z, center.x);
  const tx = center.x + Math.cos(angle + 0.9) * radius * 0.7;
  const tz = center.z + Math.sin(angle + 0.9) * radius * 0.7;
  banner.position.set(tx, alt(tx, tz) + 1.2, tz);
  province.add(banner);

  const labelGroup = new THREE.Group();
  labelGroup.position.set(center.x, alt(center.x, center.z) + (slot.isMain ? 20 : 14), center.z);
  const label = createLabelSprite(
    slot.controlled ? (slot.isMain ? 'CAPITALE · NOMOS D’OR' : 'PROVINCE ALLIÉE') : 'TERRITOIRE EXPLORÉ',
    slot.name,
    slot.color,
    slot.isMain ? { w: 18, h: 5.4 } : { w: 14, h: 4.4 },
  );
  labelGroup.add(label);
  province.add(labelGroup);

  const focusPoint = new THREE.Vector3(center.x, alt(center.x, center.z) + 6, center.z);
  focusTargets.set(slot.key, focusPoint);
  if (slot.isMain) focusTargets.set('main', focusPoint.clone());

  const focusMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(slot.color),
    transparent: true,
    opacity: 0.28,
    emissive: new THREE.Color(slot.color),
    emissiveIntensity: 0.35,
  });
  const focusRing = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.46, 0.22, 18, 72), focusMat);
  focusRing.rotation.x = -Math.PI / 2;
  focusRing.position.set(center.x, alt(center.x, center.z) + 0.2, center.z);
  province.add(focusRing);
  attachInspectable(focusRing, {
    clan: slot.controlled ? slot.name : 'Territoire neutre',
    name: slot.controlled ? slot.title : 'Province à coloniser',
    district: slot.controlled ? 'Administration provinciale' : 'Frontière stratégique',
    status: slot.controlled ? `Production · ${slot.resource}` : 'En attente d’ordres',
    hours: slot.controlled
      ? `${slot.hours.toFixed(1)} h · ${slot.eur.toLocaleString('fr-BE')} € · ${slot.resource}`
      : 'Aucun ordre administratif en place',
  }, slot.key);
  dynamicActors.push({
    update(time) {
      focusRing.rotation.z = time * 0.4 + slot.seed;
      focusMat.opacity = 0.22 + (Math.sin(time * 1.8 + slot.seed) * 0.5 + 0.5) * 0.12;
    },
  });

  return province;
}

function createFogOfWar(heightmap, heightmapSize, worldScale, provinces) {
  const segments = 140;
  const geo = new THREE.PlaneGeometry(worldScale, worldScale, segments, segments);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getY(i);
    const h = sampleHeight(heightmap, heightmapSize, x, z, worldScale);
    pos.setZ(i, Math.max(h + 0.05, 0.4));
  }
  geo.computeVertexNormals();
  geo.rotateX(-Math.PI / 2);
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(10,14,28,0.92)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  provinces.forEach((p) => {
    const u = (p.x / worldScale + 0.5) * canvas.width;
    const v = (p.z / worldScale + 0.5) * canvas.height;
    const radius = (p.radius * 1.9 / worldScale) * canvas.width;
    const g = ctx.createRadialGradient(u, v, radius * 0.08, u, v, radius);
    g.addColorStop(0, 'rgba(10,14,28,0)');
    g.addColorStop(0.55, 'rgba(10,14,28,0.18)');
    g.addColorStop(1, 'rgba(10,14,28,0.94)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(u, v, radius, 0, Math.PI * 2);
    ctx.fill();
  });
  const alphaTex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({ color: 0x0a0e1e, transparent: true, opacity: 0.95, alphaMap: alphaTex, depthWrite: false });
  const fog = new THREE.Mesh(geo, mat);
  overlayRoot.add(fog);
  dynamicActors.push({
    update(time) {
      const s = 1 + Math.sin(time * 0.8) * 0.006;
      fog.scale.set(s, 1, s);
    },
  });
}

function placeShipsAround(data) {
  const home = new THREE.Vector3(0, -1.6, -36);
  const count = Math.max(2, Math.min(9, data.empireView.state.fleets * 2 + 1));
  for (let i = 0; i < count; i++) {
    const ship = createShip(i % 2 === 0 ? 0x8e4f30 : 0x6f4a2e, 0.9 + (i % 3) * 0.08);
    worldRoot.add(ship);
    const radius = 46 + (i % 4) * 22;
    const speed = 0.08 + i * 0.014;
    dynamicActors.push({
      update(time) {
        const a = time * speed + (i * 0.7);
        ship.position.set(
          Math.cos(a) * radius + home.x * 0.2,
          -1.5 + Math.sin((time * 2.2) + i) * 0.18,
          Math.sin(a) * (radius * 0.82) + home.z * 0.2,
        );
        ship.rotation.y = -a + Math.PI / 2 + 0.2;
      },
    });
  }
}

function placeMilitaryBanners(data) {
  const legions = Math.max(1, data.empireView.state.legions);
  const ring = 26;
  for (let i = 0; i < legions; i++) {
    const a = (i / Math.max(1, legions)) * Math.PI * 2;
    const banner = createBanner(i % 2 === 0 ? '#ef4444' : '#f59e0b', 8.2 + (i % 3));
    banner.position.set(Math.cos(a) * ring, 0, Math.sin(a) * ring);
    worldRoot.add(banner);
  }
}

function buildWorld(data) {
  clearWorld();
  createOcean();
  createMountainRing();

  mapRoot = new THREE.Group();
  overlayRoot = new THREE.Group();
  worldRoot.add(mapRoot);
  worldRoot.add(overlayRoot);

  const heightmapSize = 96;
  const worldScale = 200;
  const heightmap = buildHeightmap(heightmapSize);
  const landAltitude = (x, z) => sampleHeight(heightmap, heightmapSize, x, z, worldScale);

  createLandmass(heightmap, heightmapSize, worldScale);
  createRiver(heightmap, heightmapSize, worldScale, landAltitude);
  scatterForest(landAltitude, worldScale);

  const slots = [];
  const ringA = 0;
  const ringB = 1;
  const mainSlot = {
    x: 0,
    z: 6,
    radius: 30,
    isMain: true,
    controlled: true,
    seed: 0,
  };
  slots.push(mainSlot);

  const provinceCount = Math.max(2, data.empireView.state.scouted);
  const controlledCount = Math.max(1, data.empireView.state.provinces);
  const rivalClans = data.clansData.filter((c) => !c.is_main);
  const mainClan = data.clansData.find((c) => c.is_main) || data.clansData[0] || { key: 'main', name: 'Imperium', color: '#fde68a', hours: 0, eur: 0, is_main: true };

  for (let i = 1; i < provinceCount; i++) {
    const t = (i - 1) / Math.max(1, provinceCount - 1);
    const angle = t * Math.PI * 2 + Math.PI / 6;
    const ring = i % 3 === 0 ? 86 : 62;
    const clan = rivalClans[(i - 1) % Math.max(1, rivalClans.length)] || {
      key: `neutral_${i}`,
      name: `Nomos ${['Koré', 'Helion', 'Astara', 'Lyra', 'Oron', 'Veyra', 'Thalis', 'Selene'][i % 8]}`,
      color: ['#f59e0b', '#14b8a6', '#ec4899', '#0ea5e9', '#6366f1', '#10b981'][i % 6],
      hours: 0,
      eur: 0,
    };
    slots.push({
      x: Math.cos(angle) * ring,
      z: Math.sin(angle) * ring + (i % 2 === 0 ? 4 : -4),
      radius: i < 3 ? 22 : 18,
      isMain: false,
      controlled: i < controlledCount,
      hasHarbor: i < data.empireView.state.ports + 1,
      seed: i * 0.9,
      clan,
    });
  }

  createDistrictRoads(landAltitude, slots);

  const provinces = slots.map((slot, index) => {
    const clan = slot.isMain
      ? mainClan
      : slot.clan;
    const province = {
      ...clan,
      key: clan.key || `slot_${index}`,
      title: slot.isMain ? 'Cité de commandement' : (slot.controlled ? 'Province alliée' : 'Province explorée'),
      resource: index % 3 === 0 ? 'Champs et vergers' : index % 3 === 1 ? 'Carrières et ateliers' : 'Arsenaux et ports',
      controlled: slot.controlled,
      isMain: slot.isMain,
      hasHarbor: slot.isMain ? true : !!slot.hasHarbor,
      x: slot.x,
      z: slot.z,
      radius: slot.radius,
      seed: slot.seed || index,
    };
    if (!slot.controlled) {
      scatterRuin(slot.x + 3, slot.z - 2, landAltitude(slot.x + 3, slot.z - 2));
    }
    const provinceMesh = createProvince({ ...slot, ...province }, data, landAltitude);
    mapRoot.add(provinceMesh);
    return province;
  });

  createFogOfWar(heightmap, heightmapSize, worldScale, provinces);
  placeShipsAround(data);
  placeMilitaryBanners(data);

  worldRoot.rotation.x = THREE.MathUtils.degToRad(-0.4);
  worldRoot.rotation.z = THREE.MathUtils.degToRad(-1.5);
}

function rebuildWorld(data) {
  if (!assetsReady || !worldRoot) {
    pendingWorldData = data;
    return;
  }
  setLoader(true, 'Assemblage des provinces, des routes, des arsenaux et des districts…');
  buildWorld(data);
  focusCamera(focusTargets.get('main') || new THREE.Vector3(0, 4, 0), true);
  setTimeout(() => setLoader(false), 180);
}

function updateInspector(data) {
  const panel = document.getElementById('empire-inspector');
  if (!panel || !data) return;
  document.getElementById('empire-inspector-clan').textContent = data.clan || 'Secteur sélectionné';
  document.getElementById('empire-inspector-name').textContent = data.name || 'Point stratégique';
  document.getElementById('empire-inspector-district').textContent = data.district || 'District impérial';
  document.getElementById('empire-inspector-status').textContent = data.status || 'Actif';
  document.getElementById('empire-inspector-hours').textContent = data.hours || '—';
  panel.classList.remove('hidden');
  document.dispatchEvent(new CustomEvent('kopek:province-selected', { detail: data }));
}

function updatePointer(event) {
  if (!canvasElement || !camera || !raycaster) return false;
  const rect = canvasElement.getBoundingClientRect();
  const x = event.clientX ?? (event.touches?.[0]?.clientX);
  const y = event.clientY ?? (event.touches?.[0]?.clientY);
  if (typeof x !== 'number' || typeof y !== 'number') return false;
  mouse.x = ((x - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((y - rect.top) / rect.height) * 2 + 1;
  return true;
}

function currentPointerHit() {
  if (!camera || !raycaster) return null;
  raycaster.setFromCamera(mouse, camera);
  return raycaster.intersectObjects(interactiveObjects, false)[0] || null;
}

function selectInspectableObject(object) {
  if (!object?.userData?.inspectable) return;
  setMaterialHighlight(selectedObject, false);
  selectedObject = object;
  setMaterialHighlight(selectedObject, true);
  updateInspector(object.userData);
  const focusKey = object.userData.focusKey;
  const focus = focusTargets.get(focusKey) || object.getWorldPosition(new THREE.Vector3());
  focusCamera(focus, false);
}

function onPointerMove(event) {
  if (!updatePointer(event)) return;
  const nextHovered = currentPointerHit()?.object || null;
  if (hoveredObject !== nextHovered) {
    setMaterialHighlight(hoveredObject, false);
    hoveredObject = nextHovered;
    setMaterialHighlight(hoveredObject, true);
  }
  canvasElement.style.cursor = hoveredObject ? 'pointer' : 'default';
}

function onPointerDown(event) {
  if (!updatePointer(event)) return;
  const x = event.clientX ?? (event.touches?.[0]?.clientX) ?? 0;
  const y = event.clientY ?? (event.touches?.[0]?.clientY) ?? 0;
  pointerDownInfo = { x, y, time: performance.now() };
}

function onPointerUp(event) {
  if (!pointerDownInfo || !updatePointer(event)) return;
  const x = event.clientX ?? (event.changedTouches?.[0]?.clientX) ?? pointerDownInfo.x;
  const y = event.clientY ?? (event.changedTouches?.[0]?.clientY) ?? pointerDownInfo.y;
  const moved = Math.hypot(x - pointerDownInfo.x, y - pointerDownInfo.y);
  const elapsed = performance.now() - pointerDownInfo.time;
  pointerDownInfo = null;
  if (moved > 12 || elapsed > 300) return;
  const hit = currentPointerHit();
  if (hit?.object?.userData?.inspectable) selectInspectableObject(hit.object);
}

function onPointerLeave() {
  pointerDownInfo = null;
  setMaterialHighlight(hoveredObject, false);
  hoveredObject = null;
  if (canvasElement) canvasElement.style.cursor = 'default';
}

function applyResponsiveViewport(resetCamera = false) {
  if (!camera || !renderer || !controls) return;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isCompactViewport() ? 1.3 : 1.7));
  controls.enablePan = false;
  controls.minDistance = isCompactViewport() ? 78 : 100;
  controls.maxDistance = isCompactViewport() ? 200 : 290;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(isCompactViewport() ? 74 : 68);
  controls.minPolarAngle = THREE.MathUtils.degToRad(isCompactViewport() ? 40 : 46);
  if (resetCamera) {
    focusCamera(focusTargets.get('main') || new THREE.Vector3(0, 4, 0), true);
  }
}

function onResize() {
  if (!camera || !renderer || !containerElement) return;
  const width = containerElement.clientWidth || 800;
  const height = containerElement.clientHeight || 600;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  applyResponsiveViewport(false);
}

function animate(timeMs) {
  requestAnimationFrame(animate);
  const time = timeMs * 0.001;
  dynamicActors.forEach((actor) => actor.update && actor.update(time));
  ambientSprites.forEach((sprite) => {
    sprite.position.y += Math.sin((time + sprite.userData.phase) * sprite.userData.drift * 10) * 0.01;
  });
  if (worldRoot) {
    worldRoot.rotation.y = Math.sin(time * 0.02) * 0.02;
  }
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}

export function initThreeGame() {
  if (isInitialized) return;
  canvasElement = document.getElementById('three-canvas');
  if (!canvasElement) return;
  containerElement = canvasElement.parentElement;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1629);
  scene.fog = new THREE.FogExp2(0x1f2947, 0.0022);

  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
  camera.position.set(130, 96, 150);

  renderer = new THREE.WebGLRenderer({
    canvas: canvasElement,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.set(0, 6, 0);
  controls.enablePan = false;
  canvasElement.style.touchAction = 'none';

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2(-1, -1);
  worldRoot = new THREE.Group();
  scene.add(worldRoot);

  createSkyDome();
  createAtmosphereLayers();
  setupLighting();

  window.addEventListener('resize', onResize);
  canvasElement.addEventListener('pointermove', onPointerMove);
  canvasElement.addEventListener('pointerdown', onPointerDown);
  canvasElement.addEventListener('pointerup', onPointerUp);
  canvasElement.addEventListener('pointerleave', onPointerLeave);
  canvasElement.addEventListener('pointercancel', onPointerLeave);
  onResize();
  applyResponsiveViewport(true);
  isInitialized = true;
  animate(0);
  ensureAssets().catch((err) => {
    console.error('[kopek] textures impériales indisponibles, utilisation des alternatives', err);
    assetsReady = true;
    if (pendingWorldData) rebuildWorld(pendingWorldData);
    setLoader(false);
  });
}

export function updateCity(clansData, fullAgg, empireView) {
  const data = { clansData: clansData || [], fullAgg, empireView };
  if (!isInitialized) {
    pendingWorldData = data;
    return;
  }
  if (!assetsReady) {
    pendingWorldData = data;
    setLoader(true, 'Mise en place des matières premières, routes et bâtiments…');
    return;
  }
  rebuildWorld(data);
}

export function triggerLogEffect(clientId) {
  if (!scene) return;
  const focus = focusTargets.get(clientId) || focusTargets.get('main') || new THREE.Vector3(0, 4, 0);
  focusCamera(focus, false);

  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
  for (let i = 0; i < 26; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), material);
    p.position.set(
      (Math.random() - 0.5) * 6,
      Math.random() * 7,
      (Math.random() - 0.5) * 6,
    );
    group.add(p);
  }
  group.position.copy(focus);
  scene.add(group);

  let age = 0;
  const actor = {
    update() {
      age += 0.016;
      group.children.forEach((child, idx) => {
        child.position.y += 0.14 + (idx % 3) * 0.012;
        child.position.x += Math.sin(age * 4.2 + idx) * 0.015;
        child.position.z += Math.cos(age * 4.2 + idx) * 0.015;
        child.scale.multiplyScalar(0.984);
      });
      if (age > 1.55) {
        scene.remove(group);
        const i = dynamicActors.indexOf(actor);
        if (i !== -1) dynamicActors.splice(i, 1);
      }
    },
  };
  dynamicActors.push(actor);
}
