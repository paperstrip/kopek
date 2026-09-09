import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Global state
let scene, camera, renderer, controls;
let canvasElement, containerElement;
let animFrameId;
let isInitialized = false;

// Game entities
let clanGroups = new Map(); // clanId -> THREE.Group
let interactiveObjects = []; // for raycasting
let vehicles = []; // moving cars/trucks
let animatedElements = []; // cranes, particles, etc.
let particleSystems = [];
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2(-1000, -1000);
let hoveredObject = null;
let selectedObject = null;
let isNightMode = false;
let dirLight, hemiLight, ambientLight;

// Camera animation targets
let cameraTargetPos = null;
let controlsTargetPos = null;

// Texture caches
const textureCache = new Map();

/* =========================================================================
   🎨 PROCEDURAL TEXTURE GENERATORS (Photorealistic canvas textures)
   ========================================================================= */

function getFacadeTexture(style = 'modern', litPercent = 0.5, tint = '#3b82f6') {
  const cacheKey = `facade_${style}_${litPercent}_${tint}`;
  if (textureCache.has(cacheKey)) return textureCache.get(cacheKey);

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  // Base building wall
  ctx.fillStyle = style === 'residential' ? '#27272a' : style === 'tower' ? '#0f172a' : '#1e293b';
  ctx.fillRect(0, 0, 256, 512);

  // Vertical structural mullions
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 4;
  const cols = style === 'tower' ? 8 : 6;
  const colWidth = 256 / cols;
  for (let x = 0; x <= 256; x += colWidth) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 512);
    ctx.stroke();
  }

  // Horizontal floor dividers
  const rows = style === 'residential' ? 12 : 20;
  const rowHeight = 512 / rows;
  ctx.lineWidth = 3;
  for (let y = 0; y <= 512; y += rowHeight) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
  }

  // Windows
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wx = c * colWidth + 4;
      const wy = r * rowHeight + 4;
      const ww = colWidth - 8;
      const wh = rowHeight - 7;

      const isLit = Math.random() < litPercent;
      if (isLit) {
        // Warm interior glow or modern cyan office glow
        const glowColor = Math.random() > 0.4 ? '#fef08a' : '#a5f3fc';
        ctx.fillStyle = glowColor;
        ctx.fillRect(wx, wy, ww, wh);

        // Window blinds / reflection gradient
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.fillRect(wx, wy + wh * 0.5, ww, wh * 0.5);
      } else {
        // Dark reflective glass
        const grad = ctx.createLinearGradient(wx, wy, wx + ww, wy + wh);
        grad.addColorStop(0, '#090d16');
        grad.addColorStop(1, '#1e293b');
        ctx.fillStyle = grad;
        ctx.fillRect(wx, wy, ww, wh);
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  textureCache.set(cacheKey, texture);
  return texture;
}

function getRoadTexture() {
  if (textureCache.has('road')) return textureCache.get('road');
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Dark asphalt
  ctx.fillStyle = '#1e1e24';
  ctx.fillRect(0, 0, 128, 256);

  // Road edges / curbs
  ctx.fillStyle = '#71717a';
  ctx.fillRect(0, 0, 8, 256);
  ctx.fillRect(120, 0, 8, 256);

  // Dashed center yellow line
  ctx.strokeStyle = '#facc15';
  ctx.lineWidth = 4;
  ctx.setLineDash([24, 16]);
  ctx.beginPath();
  ctx.moveTo(64, 0);
  ctx.lineTo(64, 256);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 4);
  textureCache.set('road', texture);
  return texture;
}

function getGroundTexture() {
  if (textureCache.has('ground')) return textureCache.get('ground');
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  // Base grass / landscaped terrain
  ctx.fillStyle = '#15803d';
  ctx.fillRect(0, 0, 512, 512);

  // Texture noise
  for (let i = 0; i < 6000; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const shade = Math.random() > 0.5 ? '#166534' : '#22c55e';
    ctx.fillStyle = shade;
    ctx.fillRect(x, y, 2, 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(8, 8);
  textureCache.set('ground', texture);
  return texture;
}

function getWaterTexture() {
  if (textureCache.has('water')) return textureCache.get('water');
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0284c7';
  ctx.fillRect(0, 0, 256, 256);

  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 2;
  for (let y = 10; y < 256; y += 20) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(64, y - 6, 128, y + 6, 192, y - 6);
    ctx.lineTo(256, y);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(6, 6);
  textureCache.set('water', texture);
  return texture;
}

function getPavementTexture() {
  if (textureCache.has('pavement')) return textureCache.get('pavement');
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#3f3f46';
  ctx.fillRect(0, 0, 128, 128);

  ctx.strokeStyle = '#27272a';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 128; i += 16) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 128); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(128, i); ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  textureCache.set('pavement', texture);
  return texture;
}

function getHazardTexture() {
  if (textureCache.has('hazard')) return textureCache.get('hazard');
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#eab308';
  ctx.fillRect(0, 0, 128, 128);

  ctx.fillStyle = '#18181b';
  for (let i = -128; i < 256; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 32, 0);
    ctx.lineTo(i + 32 + 128, 128);
    ctx.lineTo(i + 128, 128);
    ctx.closePath();
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  textureCache.set('hazard', texture);
  return texture;
}

function createTextBadgeSprite(title, subtitle, color = '#38bdf8', isMain = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  // Rounded bubble
  ctx.fillStyle = isMain ? 'rgba(15, 23, 42, 0.92)' : 'rgba(24, 24, 27, 0.88)';
  ctx.strokeStyle = color;
  ctx.lineWidth = isMain ? 6 : 4;

  const r = 24;
  ctx.beginPath();
  ctx.moveTo(r, 6);
  ctx.lineTo(384 - r, 6);
  ctx.quadraticCurveTo(384 - 6, 6, 384 - 6, r);
  ctx.lineTo(384 - 6, 128 - r);
  ctx.quadraticCurveTo(384 - 6, 128 - 6, 384 - r, 128 - 6);
  ctx.lineTo(r, 128 - 6);
  ctx.quadraticCurveTo(6, 128 - 6, 6, 128 - r);
  ctx.lineTo(6, r);
  ctx.quadraticCurveTo(6, 6, r, 6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Badge icon/tag
  if (isMain) {
    ctx.fillStyle = color;
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('★ VOTRE CITÉ (CLAN MAÎTRE)', 24, 36);
  } else {
    ctx.fillStyle = color;
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText('⚔ CLAN CLIENT', 24, 34);
  }

  // Clan Name
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 32px sans-serif';
  const displayTitle = title.length > 16 ? title.substring(0, 15) + '…' : title;
  ctx.fillText(displayTitle, 24, 76);

  // Subtitle (hours, CA)
  ctx.fillStyle = '#94a3b8';
  ctx.font = '22px monospace';
  ctx.fillText(subtitle, 24, 110);

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(16, 5.3, 1);
  return sprite;
}

/* =========================================================================
   🚀 INITIALIZATION
   ========================================================================= */

export function initThreeGame() {
  if (isInitialized) return;

  canvasElement = document.getElementById('three-canvas');
  if (!canvasElement) return;

  containerElement = canvasElement.parentElement;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a); // Atmospheric dusk
  scene.fog = new THREE.FogExp2(0x0f172a, 0.007);

  // Camera (Management game isometric perspective angle)
  const w = containerElement.clientWidth || 800;
  const h = containerElement.clientHeight || 600;
  camera = new THREE.PerspectiveCamera(42, w / h, 0.5, 800);
  camera.position.set(70, 75, 95);

  // Renderer with realistic shadows
  renderer = new THREE.WebGLRenderer({
    canvas: canvasElement,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  // OrbitControls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxPolarAngle = Math.PI / 2.05; // Do not dip below ground
  controls.minDistance = 20;
  controls.maxDistance = 240;
  controls.target.set(0, 2, 0);

  // Lighting setup
  setupLighting();

  // Environment (World ocean, mountain ring, base water)
  setupWorldEnvironment();

  // Event listeners
  window.addEventListener('resize', onWindowResize);
  canvasElement.addEventListener('mousemove', onMouseMove);
  canvasElement.addEventListener('click', onMouseClick);

  // Inject 3D HUD controls (camera shortcuts, clan focus, etc.)
  injectGameUI();

  isInitialized = true;

  // Render loop
  animate(0);
}

function setupLighting() {
  ambientLight = new THREE.AmbientLight(0xdbeafe, 0.5);
  scene.add(ambientLight);

  hemiLight = new THREE.HemisphereLight(0x93c5fd, 0x1e293b, 0.6);
  hemiLight.position.set(0, 100, 0);
  scene.add(hemiLight);

  // Main golden sun
  dirLight = new THREE.DirectionalLight(0xffedd5, 1.8);
  dirLight.position.set(110, 140, 90);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 10;
  dirLight.shadow.camera.far = 400;
  const d = 110;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;
  dirLight.shadow.bias = -0.0005;
  scene.add(dirLight);

  // Secondary soft blue rim light
  const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.6);
  rimLight.position.set(-100, 50, -80);
  scene.add(rimLight);
}

function setupWorldEnvironment() {
  // Water ocean floor
  const waterGeo = new THREE.PlaneGeometry(600, 600);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x0369a1,
    roughness: 0.1,
    metalness: 0.8,
    map: getWaterTexture(),
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = -0.4;
  water.receiveShadow = true;
  scene.add(water);

  // Subtle animated water plane reference
  animatedElements.push({
    update: (time) => {
      waterMat.map.offset.x = (time * 0.02) % 1;
      waterMat.map.offset.y = (time * 0.015) % 1;
    }
  });

  // Distant horizon mountain silhouettes / city glow
  const backdropGeo = new THREE.CylinderGeometry(280, 280, 40, 32, 1, true);
  const backdropMat = new THREE.MeshBasicMaterial({
    color: 0x090d16,
    side: THREE.BackSide,
  });
  const backdrop = new THREE.Mesh(backdropGeo, backdropMat);
  backdrop.position.y = 10;
  scene.add(backdrop);
}

/* =========================================================================
   🏗️ 3D ASSET BUILDERS (Realistic Architecture)
   ========================================================================= */

function createTree(x, z, scale = 1) {
  const treeGroup = new THREE.Group();
  treeGroup.position.set(x, 0, z);

  // Trunk
  const trunkGeo = new THREE.CylinderGeometry(0.25 * scale, 0.35 * scale, 1.8 * scale, 6);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3d2e, roughness: 0.9 });
  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.position.y = 0.9 * scale;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  treeGroup.add(trunk);

  // Foliage (double cone / spheres for volume)
  const foliageMat = new THREE.MeshStandardMaterial({
    color: Math.random() > 0.3 ? 0x16a34a : 0x15803d,
    roughness: 0.7,
    flatShading: true,
  });

  const cone1 = new THREE.Mesh(new THREE.ConeGeometry(1.6 * scale, 2.5 * scale, 7), foliageMat);
  cone1.position.y = 2.2 * scale;
  cone1.castShadow = true;
  treeGroup.add(cone1);

  const cone2 = new THREE.Mesh(new THREE.ConeGeometry(1.2 * scale, 2.0 * scale, 6), foliageMat);
  cone2.position.y = 3.4 * scale;
  cone2.castShadow = true;
  treeGroup.add(cone2);

  return treeGroup;
}

function createStreetLamp(x, z) {
  const lampGroup = new THREE.Group();
  lampGroup.position.set(x, 0, z);

  const poleGeo = new THREE.CylinderGeometry(0.1, 0.14, 4.5, 6);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.8, roughness: 0.3 });
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = 2.25;
  pole.castShadow = true;
  lampGroup.add(pole);

  // Light bulb mesh
  const bulbGeo = new THREE.SphereGeometry(0.3, 8, 8);
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
  const bulb = new THREE.Mesh(bulbGeo, bulbMat);
  bulb.position.set(0, 4.4, 0);
  lampGroup.add(bulb);

  return lampGroup;
}

function createCrane(x, z, height = 18, color = 0xf59e0b) {
  const craneGroup = new THREE.Group();
  craneGroup.position.set(x, 0, z);

  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.4 });

  // Mast
  const mastGeo = new THREE.BoxGeometry(1.2, height, 1.2);
  const mast = new THREE.Mesh(mastGeo, mat);
  mast.position.y = height / 2;
  mast.castShadow = true;
  craneGroup.add(mast);

  // Hazard striped cabin
  const cabGeo = new THREE.BoxGeometry(2.2, 2.5, 2.8);
  const cabMat = new THREE.MeshStandardMaterial({ map: getHazardTexture() });
  const cab = new THREE.Mesh(cabGeo, cabMat);
  cab.position.set(0, height + 1.2, 0);
  craneGroup.add(cab);

  // Rotating Jib arm
  const armGroup = new THREE.Group();
  armGroup.position.set(0, height + 2.5, 0);

  const armGeo = new THREE.BoxGeometry(1, 0.8, 20);
  const arm = new THREE.Mesh(armGeo, mat);
  arm.position.set(0, 0, 5);
  arm.castShadow = true;
  armGroup.add(arm);

  // Counterweight
  const cwGeo = new THREE.BoxGeometry(2, 1.8, 3.5);
  const cwMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.8 });
  const cw = new THREE.Mesh(cwGeo, cwMat);
  cw.position.set(0, 0, -5);
  armGroup.add(cw);

  // Cable & hook
  const cableGeo = new THREE.CylinderGeometry(0.04, 0.04, 8);
  const cableMat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0 });
  const cable = new THREE.Mesh(cableGeo, cableMat);
  cable.position.set(0, -4, 10);
  armGroup.add(cable);

  const hook = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), mat);
  hook.position.set(0, -8, 10);
  armGroup.add(hook);

  // Beacon light at top
  const beaconGeo = new THREE.SphereGeometry(0.3, 6, 6);
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
  const beacon = new THREE.Mesh(beaconGeo, beaconMat);
  beacon.position.set(0, height + 4, 0);
  craneGroup.add(beacon);

  craneGroup.add(armGroup);

  // Animate jib rotation & beacon blink
  animatedElements.push({
    update: (time) => {
      armGroup.rotation.y = Math.sin(time * 0.5) * 0.7 + Math.cos(time * 0.2) * 0.4;
      beaconMat.color.setHex(Math.sin(time * 8) > 0 ? 0xff0000 : 0x440000);
    }
  });

  return craneGroup;
}

function createBuilding({
  type = 'tower', // 'villa', 'midrise', 'tower', 'spire', 'under_construction'
  width = 6,
  depth = 6,
  height = 14,
  tint = '#3b82f6',
  data = {},
}) {
  const group = new THREE.Group();
  group.userData = { isBuilding: true, data };

  if (type === 'under_construction') {
    // Scaffoldings + concrete core
    const coreGeo = new THREE.BoxGeometry(width * 0.75, height * 0.8, depth * 0.75);
    const coreMat = new THREE.MeshStandardMaterial({ color: 0x71717a, roughness: 0.9 });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.y = (height * 0.8) / 2;
    core.castShadow = true;
    core.receiveShadow = true;
    group.add(core);

    // Scaffolding cage
    const scafGeo = new THREE.BoxGeometry(width, height, depth);
    const scafMat = new THREE.MeshStandardMaterial({
      map: getHazardTexture(),
      wireframe: true,
      transparent: true,
      opacity: 0.85,
    });
    const scaf = new THREE.Mesh(scafGeo, scafMat);
    scaf.position.y = height / 2;
    group.add(scaf);

    // Add crane
    const crane = createCrane(width * 0.5, depth * 0.5, height + 4, 0xf59e0b);
    group.add(crane);

    interactiveObjects.push(core);
    core.userData = { parentGroup: group, ...data };
    return group;
  }

  // Realistic Architectural Tower
  const facadeTex = getFacadeTexture(
    type === 'villa' ? 'residential' : 'tower',
    data.isLit ? 0.7 : 0.35,
    tint
  );

  const materials = [
    new THREE.MeshStandardMaterial({ map: facadeTex, roughness: 0.3, metalness: 0.4 }),
    new THREE.MeshStandardMaterial({ map: facadeTex, roughness: 0.3, metalness: 0.4 }),
    new THREE.MeshStandardMaterial({ map: getPavementTexture(), roughness: 0.8 }), // Roof
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 }),          // Bottom
    new THREE.MeshStandardMaterial({ map: facadeTex, roughness: 0.3, metalness: 0.4 }),
    new THREE.MeshStandardMaterial({ map: facadeTex, roughness: 0.3, metalness: 0.4 }),
  ];

  // Main body
  const bodyGeo = new THREE.BoxGeometry(width, height, depth);
  const body = new THREE.Mesh(bodyGeo, materials);
  body.position.y = height / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Roof machinery / antenna / crown
  if (type === 'spire' || type === 'tower') {
    const roofBoxGeo = new THREE.BoxGeometry(width * 0.6, 2.5, depth * 0.6);
    const roofBoxMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5 });
    const roofBox = new THREE.Mesh(roofBoxGeo, roofBoxMat);
    roofBox.position.y = height + 1.25;
    roofBox.castShadow = true;
    group.add(roofBox);

    // Spire antenna
    const antennaGeo = new THREE.CylinderGeometry(0.1, 0.35, 7, 6);
    const antennaMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.9 });
    const antenna = new THREE.Mesh(antennaGeo, antennaMat);
    antenna.position.y = height + 6;
    antenna.castShadow = true;
    group.add(antenna);

    // Glowing spire tip
    const tipGeo = new THREE.SphereGeometry(0.35, 6, 6);
    const tipMat = new THREE.MeshBasicMaterial({ color: tint });
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.y = height + 9.5;
    group.add(tip);
  }

  // Entrance awning on ground floor
  const awningGeo = new THREE.BoxGeometry(width * 0.4, 0.4, 2);
  const awningMat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.4, metalness: 0.5 });
  const awning = new THREE.Mesh(awningGeo, awningMat);
  awning.position.set(0, 1.8, depth / 2 + 0.9);
  awning.castShadow = true;
  group.add(awning);

  interactiveObjects.push(body);
  body.userData = { parentGroup: group, ...data };

  return group;
}

function createVehicle(colorHex = 0xef4444, isTruck = false) {
  const v = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: 0.2,
    metalness: 0.6,
  });

  if (isTruck) {
    // Cabin
    const cabGeo = new THREE.BoxGeometry(1.4, 1.4, 1.8);
    const cab = new THREE.Mesh(cabGeo, bodyMat);
    cab.position.set(0, 0.9, 1.2);
    cab.castShadow = true;
    v.add(cab);

    // Container
    const contGeo = new THREE.BoxGeometry(1.6, 1.8, 3.4);
    const contMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.7 });
    const cont = new THREE.Mesh(contGeo, contMat);
    cont.position.set(0, 1.2, -1.2);
    cont.castShadow = true;
    v.add(cont);
  } else {
    // Sleek passenger car
    const lowerGeo = new THREE.BoxGeometry(1.4, 0.6, 3.0);
    const lower = new THREE.Mesh(lowerGeo, bodyMat);
    lower.position.y = 0.5;
    lower.castShadow = true;
    v.add(lower);

    const roofGeo = new THREE.BoxGeometry(1.1, 0.55, 1.6);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.1 });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.set(0, 0.95, -0.2);
    roof.castShadow = true;
    v.add(roof);
  }

  // Headlights
  const lightGeo = new THREE.SphereGeometry(0.12, 6, 6);
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
  const l1 = new THREE.Mesh(lightGeo, lightMat);
  l1.position.set(0.5, 0.5, 1.55);
  const l2 = l1.clone();
  l2.position.x = -0.5;
  v.add(l1);
  v.add(l2);

  return v;
}

function createBridge(p1, p2, width = 4) {
  const group = new THREE.Group();
  const dir = new THREE.Vector3().subVectors(p2, p1);
  const len = dir.length();
  const center = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);

  const bridgeGeo = new THREE.BoxGeometry(width, 0.8, len);
  const bridgeMat = new THREE.MeshStandardMaterial({
    map: getRoadTexture(),
    roughness: 0.7,
  });
  const bridge = new THREE.Mesh(bridgeGeo, bridgeMat);
  bridge.position.copy(center);
  bridge.position.y = 1.0;
  bridge.lookAt(p2.x, 1.0, p2.z);
  bridge.castShadow = true;
  bridge.receiveShadow = true;
  group.add(bridge);

  // Pillars
  const pillarGeo = new THREE.CylinderGeometry(0.6, 0.8, 6, 8);
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.8 });
  const pil1 = new THREE.Mesh(pillarGeo, pillarMat);
  pil1.position.set(center.x, -1, center.z);
  pil1.castShadow = true;
  group.add(pil1);

  // Guardrails
  const railGeo = new THREE.BoxGeometry(0.2, 0.6, len);
  const railMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, metalness: 0.7 });
  const r1 = new THREE.Mesh(railGeo, railMat);
  r1.position.set(width / 2, 1.4, 0);
  const r2 = new THREE.Mesh(railGeo, railMat);
  r2.position.set(-width / 2, 1.4, 0);
  bridge.add(r1);
  bridge.add(r2);

  return group;
}

/* =========================================================================
   🌐 CLANS & TERRITORIES LAYOUT (Clear Dissociation)
   ========================================================================= */

export function updateCity(clansData, fullAgg) {
  if (!scene) return;

  // Clear previous city entities
  clanGroups.forEach((grp) => scene.remove(grp));
  clanGroups.clear();
  interactiveObjects = [];
  vehicles = [];

  if (!clansData || clansData.length === 0) return;

  // Find user's main clan vs secondary clans
  const mainClan = clansData.find((c) => c.isMain) || clansData[0];
  const otherClans = clansData.filter((c) => c !== mainClan);

  /* -------------------------------------------------------------------------
     1. VOTRE CITÉ PRINCIPALE (Clan Maître / Nessy)
     Placée au centre sur une grande île fortifiée & moderne
     ------------------------------------------------------------------------- */
  const mainGroup = new THREE.Group();
  mainGroup.name = 'clan_main';

  // Base island platform
  const mainIslandGeo = new THREE.CylinderGeometry(44, 46, 3, 32);
  const mainIslandMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.6,
  });
  const mainIsland = new THREE.Mesh(mainIslandGeo, mainIslandMat);
  mainIsland.position.set(0, 0.5, 0);
  mainIsland.receiveShadow = true;
  mainGroup.add(mainIsland);

  // Top paved surface with lush green parks
  const parkGeo = new THREE.CircleGeometry(43.5, 32);
  const parkMat = new THREE.MeshStandardMaterial({
    map: getGroundTexture(),
    roughness: 0.8,
  });
  const park = new THREE.Mesh(parkGeo, parkMat);
  park.rotation.x = -Math.PI / 2;
  park.position.y = 2.05;
  park.receiveShadow = true;
  mainGroup.add(park);

  // Central Grand Plaza
  const plazaGeo = new THREE.BoxGeometry(22, 0.1, 22);
  const plazaMat = new THREE.MeshStandardMaterial({ map: getPavementTexture(), roughness: 0.4 });
  const plaza = new THREE.Mesh(plazaGeo, plazaMat);
  plaza.position.set(0, 2.1, 0);
  plaza.receiveShadow = true;
  mainGroup.add(plaza);

  // Central Obelisk / Achievement Monument (glows brighter as hours increase)
  const monumentH = 12 + Math.min(20, (mainClan.hours || 0) * 0.4);
  const monumentGeo = new THREE.CylinderGeometry(0.8, 1.8, monumentH, 4);
  const monumentMat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    metalness: 0.8,
    roughness: 0.2,
    emissive: 0x0284c7,
    emissiveIntensity: 0.4,
  });
  const monument = new THREE.Mesh(monumentGeo, monumentMat);
  monument.position.set(0, 2 + monumentH / 2, 0);
  monument.rotation.y = Math.PI / 4;
  monument.castShadow = true;
  mainGroup.add(monument);

  // Peripheral circular road
  const roadRingGeo = new THREE.RingGeometry(30, 36, 32);
  const roadRingMat = new THREE.MeshStandardMaterial({ map: getRoadTexture(), roughness: 0.8 });
  const roadRing = new THREE.Mesh(roadRingGeo, roadRingMat);
  roadRing.rotation.x = -Math.PI / 2;
  roadRing.position.y = 2.08;
  roadRing.receiveShadow = true;
  mainGroup.add(roadRing);

  // Animated vehicles circling the main capital
  for (let i = 0; i < 4; i++) {
    const v = createVehicle(i % 2 === 0 ? 0xef4444 : 0x38bdf8, i === 1);
    mainGroup.add(v);
    const speed = 0.4 + i * 0.15;
    const offset = (i * Math.PI) / 2;
    vehicles.push({
      mesh: v,
      update: (time) => {
        const angle = time * speed + offset;
        v.position.set(Math.cos(angle) * 33, 2.4, Math.sin(angle) * 33);
        v.rotation.y = -angle + Math.PI / 2;
      }
    });
  }

  // -------------------------------------------------------------------------
  // DISTRICTS OF MAIN METROPOLIS (Socle, Garantie, Surplus)
  // -------------------------------------------------------------------------
  const socleHours = mainClan.socleH || 25;
  const garantiHours = mainClan.garantiH || 43.75;
  const refunded = mainClan.refundedH || 0;
  const surplusH = Math.max(0, (mainClan.hours || 0) - garantiHours);

  // 1. District Socle (Ouest : -X)
  const socleGroup = new THREE.Group();
  socleGroup.position.set(-16, 2, 0);
  const socleDone = refunded >= socleHours;
  const socleBuildings = [
    { type: 'villa', h: 7, x: -6, z: -6, lit: refunded > 5, label: 'Villa Socle A' },
    { type: 'midrise', h: 12, x: 0, z: -7, lit: refunded > 12, label: 'Bureaux Socle' },
    { type: 'villa', h: 8, x: -6, z: 6, lit: refunded > 18, label: 'Villa Socle B' },
    { type: socleDone ? 'tower' : 'under_construction', h: 16, x: 2, z: 6, lit: socleDone, label: 'Tour Principale Socle' },
  ];

  socleBuildings.forEach((b) => {
    const bMesh = createBuilding({
      type: b.type,
      height: b.h,
      width: 5,
      depth: 5,
      tint: '#6366f1',
      data: {
        clan: mainClan.name,
        isMain: true,
        district: 'District Socle (25h)',
        name: b.label,
        status: b.lit ? 'Opérationnel' : 'En chantier',
        hours: `${refunded.toFixed(1)} / ${socleHours} h`,
      }
    });
    bMesh.position.set(b.x, 0, b.z);
    socleGroup.add(bMesh);
  });
  mainGroup.add(socleGroup);

  // 2. District Garantie (Est : +X)
  const garantiGroup = new THREE.Group();
  garantiGroup.position.set(16, 2, 0);
  const garantiDone = refunded >= garantiHours;
  const garantiProgress = Math.max(0, refunded - socleHours);
  const garantiNeeded = garantiHours - socleHours;

  const garantiBuildings = [
    { type: 'midrise', h: 14, x: 5, z: -5, lit: garantiProgress > 4, label: 'Centre d\'Affaires Garanti' },
    { type: 'midrise', h: 15, x: -2, z: -6, lit: garantiProgress > 9, label: 'Siège Opérationnel' },
    { type: garantiDone ? 'spire' : 'under_construction', h: 22, x: 3, z: 5, lit: garantiDone, label: 'Flèche Garantie' },
  ];

  garantiBuildings.forEach((b) => {
    const bMesh = createBuilding({
      type: b.type,
      height: b.h,
      width: 6,
      depth: 6,
      tint: '#d946ef',
      data: {
        clan: mainClan.name,
        isMain: true,
        district: 'District Régie Garantie (18.75h)',
        name: b.label,
        status: b.lit ? 'Opérationnel' : 'En chantier',
        hours: `${refunded.toFixed(1)} / ${garantiHours} h`,
      }
    });
    bMesh.position.set(b.x, 0, b.z);
    garantiGroup.add(bMesh);
  });
  mainGroup.add(garantiGroup);

  // 3. District Bonus Surplus (Nord : -Z)
  const bonusGroup = new THREE.Group();
  bonusGroup.position.set(0, 2, -18);
  const hasBonus = surplusH > 0;

  const bonusBuildings = [
    { type: hasBonus ? 'spire' : 'under_construction', h: 26 + Math.min(18, surplusH * 1.5), x: 0, z: -2, lit: hasBonus, label: 'Gratte-Ciel Hyper-Bonus' },
    { type: surplusH > 5 ? 'tower' : 'midrise', h: 18, x: -7, z: 1, lit: surplusH > 5, label: 'Pavillon Royal' },
    { type: surplusH > 10 ? 'tower' : 'midrise', h: 20, x: 7, z: 1, lit: surplusH > 10, label: 'Tour Dividende' },
  ];

  bonusBuildings.forEach((b) => {
    const bMesh = createBuilding({
      type: b.type,
      height: b.h,
      width: 6,
      depth: 6,
      tint: '#10b981',
      data: {
        clan: mainClan.name,
        isMain: true,
        district: 'District Surplus Facturable',
        name: b.label,
        status: b.lit ? 'Bénéfice Net Actif' : 'En attente de surplus',
        hours: `Surplus: +${surplusH.toFixed(1)} h (+${mainClan.bonusEur || 0} €)`,
      }
    });
    bMesh.position.set(b.x, 0, b.z);
    bonusGroup.add(bMesh);
  });
  mainGroup.add(bonusGroup);

  // Trees and vegetation across main island
  for (let t = 0; t < 18; t++) {
    const angle = (t / 18) * Math.PI * 2;
    const rad = 22 + (t % 3) * 4;
    const tx = Math.cos(angle) * rad;
    const tz = Math.sin(angle) * rad;
    mainGroup.add(createTree(tx, tz, 0.8 + Math.random() * 0.4));
  }

  // Floating Clan Badge above capital
  const mainBadge = createTextBadgeSprite(
    mainClan.name || 'METROPOLE NESSY',
    `${(mainClan.hours || 0).toFixed(1)} h encodées · ${(mainClan.ca || 0).toLocaleString('fr-BE')} €`,
    '#38bdf8',
    true
  );
  mainBadge.position.set(0, monumentH + 10, 0);
  mainGroup.add(mainBadge);

  scene.add(mainGroup);
  clanGroups.set(mainClan.id || 'main', mainGroup);

  /* -------------------------------------------------------------------------
     2. LES AUTRES CLANS (Enclaves Clients Indépendantes)
     Chaque client a son île distincte, reliée par un pont avec son propre blason
     ------------------------------------------------------------------------- */
  const numOther = otherClans.length;
  const orbitRadius = 78;
  const angleStep = numOther > 0 ? (Math.PI * 2) / numOther : 0;

  // Preset palette for rival/client clans
  const clanPalette = [
    { color: '#f97316', hex: 0xf97316, name: 'Clan Ambre' },
    { color: '#8b5cf6', hex: 0x8b5cf6, name: 'Clan Violet' },
    { color: '#ec4899', hex: 0xec4899, name: 'Clan Rose' },
    { color: '#14b8a6', hex: 0x14b8a6, name: 'Clan Cyan' },
    { color: '#eab308', hex: 0xeab308, name: 'Clan Doré' },
  ];

  otherClans.forEach((clan, idx) => {
    const clanGrp = new THREE.Group();
    clanGrp.name = `clan_${clan.id}`;

    const theme = clanPalette[idx % clanPalette.length];
    const angle = idx * angleStep + Math.PI / 4; // offset from cardinal directions
    const cx = Math.cos(angle) * orbitRadius;
    const cz = Math.sin(angle) * orbitRadius;

    // Island size correlates with client revenue/hours
    const clientH = clan.hours || 0;
    const islandRad = Math.max(16, Math.min(26, 16 + clientH * 0.5));

    // Satellite Island Mesh
    const islandGeo = new THREE.CylinderGeometry(islandRad, islandRad + 2, 3, 24);
    const islandMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.7,
    });
    const island = new THREE.Mesh(islandGeo, islandMat);
    island.position.set(cx, 0.5, cz);
    island.receiveShadow = true;
    clanGrp.add(island);

    // Island Top Lawn
    const topGeo = new THREE.CircleGeometry(islandRad - 0.5, 24);
    const topMat = new THREE.MeshStandardMaterial({
      map: getGroundTexture(),
      roughness: 0.8,
    });
    const top = new THREE.Mesh(topGeo, topMat);
    top.rotation.x = -Math.PI / 2;
    top.position.set(cx, 2.05, cz);
    top.receiveShadow = true;
    clanGrp.add(top);

    // Connecting suspension bridge to central capital
    const bridgeStart = new THREE.Vector3(cx * 0.7, 0, cz * 0.7);
    const bridgeEnd = new THREE.Vector3(cx * 0.35, 0, cz * 0.35);
    const bridge = createBridge(bridgeStart, bridgeEnd, 3.5);
    clanGrp.add(bridge);

    // Animated truck driving on bridge towards capital
    const truck = createVehicle(theme.hex, true);
    clanGrp.add(truck);
    vehicles.push({
      mesh: truck,
      update: (time) => {
        const t = (Math.sin(time * 0.6 + idx) + 1) / 2;
        truck.position.lerpVectors(bridgeStart, bridgeEnd, t);
        truck.position.y = 2.2;
        truck.lookAt(bridgeEnd.x, 2.2, bridgeEnd.z);
      }
    });

    // Clan Beacon / Territory Flag
    const beaconH = 14;
    const beaconGeo = new THREE.CylinderGeometry(0.4, 0.8, beaconH, 6);
    const beaconMat = new THREE.MeshStandardMaterial({
      color: theme.hex,
      metalness: 0.8,
      emissive: theme.hex,
      emissiveIntensity: 0.5,
    });
    const beacon = new THREE.Mesh(beaconGeo, beaconMat);
    beacon.position.set(cx, 2 + beaconH / 2, cz);
    beacon.castShadow = true;
    clanGrp.add(beacon);

    // Clan Buildings (Number and height based on activity)
    if (clientH <= 0.1) {
      // Inactive / Dormant Clan: small outpost / site camp
      const tentGeo = new THREE.ConeGeometry(3, 4, 5);
      const tentMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.8 });
      const tent = new THREE.Mesh(tentGeo, tentMat);
      tent.position.set(cx + 4, 4, cz + 2);
      tent.castShadow = true;
      clanGrp.add(tent);

      const signGeo = new THREE.BoxGeometry(4, 2, 0.4);
      const signMat = new THREE.MeshStandardMaterial({ color: 0x64748b });
      const sign = new THREE.Mesh(signGeo, signMat);
      sign.position.set(cx - 3, 3, cz - 2);
      clanGrp.add(sign);
    } else {
      // Active client buildings
      const bCount = Math.min(6, Math.max(1, Math.floor(clientH / 4) + 1));
      for (let b = 0; b < bCount; b++) {
        const bAngle = (b / bCount) * Math.PI * 2;
        const bDist = 6 + (b % 2) * 4;
        const bx = cx + Math.cos(bAngle) * bDist;
        const bz = cz + Math.sin(bAngle) * bDist;
        const bHeight = 8 + Math.min(18, clientH * 1.2 + b * 2);

        const bMesh = createBuilding({
          type: b === 0 ? 'tower' : 'midrise',
          height: bHeight,
          width: 5,
          depth: 5,
          tint: theme.color,
          data: {
            clan: clan.name,
            isMain: false,
            district: `Territoire ${clan.name}`,
            name: `Complexe ${clan.name} #${b + 1}`,
            status: 'Partenaire actif',
            hours: `${clientH.toFixed(1)} h (${(clan.ca || 0).toLocaleString('fr-BE')} €)`,
          }
        });
        bMesh.position.set(bx, 2, bz);
        clanGrp.add(bMesh);
      }
    }

    // Trees on clan island
    for (let t = 0; t < 6; t++) {
      const a = (t / 6) * Math.PI * 2;
      const tx = cx + Math.cos(a) * (islandRad - 3);
      const tz = cz + Math.sin(a) * (islandRad - 3);
      clanGrp.add(createTree(tx, tz, 0.7));
    }

    // Floating 3D Badge for this clan
    const clanBadge = createTextBadgeSprite(
      clan.name,
      `${clientH.toFixed(1)} h · ${(clan.ca || 0).toLocaleString('fr-BE')} €`,
      theme.color,
      false
    );
    clanBadge.position.set(cx, beaconH + 6, cz);
    clanGrp.add(clanBadge);

    scene.add(clanGrp);
    clanGroups.set(clan.id, clanGrp);
  });

  // Update Game HUD
  updateGameHUD(clansData, fullAgg);
}

/* =========================================================================
   🎮 GAMEPLAY HUD & INTERACTIVE OVERLAY
   ========================================================================= */

function injectGameUI() {
  if (!containerElement) return;

  // Check if UI already exists
  if (document.getElementById('kopek-3d-toolbar')) return;

  const uiContainer = document.createElement('div');
  uiContainer.id = 'kopek-3d-toolbar';
  uiContainer.className = 'absolute top-16 left-4 right-4 flex items-center justify-between gap-3 pointer-events-none z-20 flex-wrap';

  uiContainer.innerHTML = `
    <!-- Mission / Action Goal Banner -->
    <div class="pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-2xl bg-zinc-950/85 border border-indigo-500/40 backdrop-blur-xl shadow-2xl">
      <div class="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 flex items-center justify-center text-white font-bold text-sm shadow-md">
        🎯
      </div>
      <div>
        <div class="text-[10px] uppercase font-bold tracking-wider text-indigo-400">Objectif Stratégique</div>
        <div id="game-objective-text" class="text-xs font-semibold text-white">Bâtir le Socle Contractuel</div>
      </div>
    </div>

    <!-- Camera / Viewport Controls -->
    <div class="pointer-events-auto flex items-center gap-1.5 p-1.5 rounded-2xl bg-zinc-950/85 border border-zinc-800 backdrop-blur-xl shadow-2xl">
      <button id="cam-focus-main" class="px-3 py-1.5 rounded-xl bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/50 text-indigo-200 text-xs font-medium transition flex items-center gap-1.5">
        <span>🏰</span> Mon Clan
      </button>
      <button id="cam-focus-all" class="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-medium transition flex items-center gap-1.5">
        <span>🌐</span> Vue Globale
      </button>
      <button id="btn-toggle-daynight" class="p-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-medium transition" title="Bascule Jour / Nuit">
        <span>🌙</span>
      </button>
    </div>

    <!-- 3D Inspection Card (Appears on click/hover) -->
    <div id="game-inspector-card" class="hidden absolute left-4 top-32 w-80 rounded-2xl p-4 bg-zinc-950/95 border border-white/15 backdrop-blur-2xl shadow-2xl text-zinc-200 pointer-events-auto transition-all duration-300">
      <div class="flex items-center justify-between pb-2 mb-2 border-b border-white/10">
        <div class="flex items-center gap-2">
          <span id="inspect-icon" class="text-xl">🏢</span>
          <div>
            <div id="inspect-clan" class="text-[10px] uppercase tracking-wider text-indigo-400 font-bold">Clan</div>
            <div id="inspect-name" class="text-sm font-bold text-white leading-tight">Nom du Bâtiment</div>
          </div>
        </div>
        <button id="inspect-close" class="text-zinc-500 hover:text-white p-1">✕</button>
      </div>
      <div class="space-y-2 text-xs">
        <div class="flex justify-between">
          <span class="text-zinc-400">Secteur :</span>
          <span id="inspect-district" class="font-medium text-zinc-200">—</span>
        </div>
        <div class="flex justify-between">
          <span class="text-zinc-400">Statut :</span>
          <span id="inspect-status" class="font-medium text-emerald-400">—</span>
        </div>
        <div class="flex justify-between">
          <span class="text-zinc-400">Volume Horaire :</span>
          <span id="inspect-hours" class="font-mono font-bold text-amber-300">—</span>
        </div>
      </div>
      <div class="mt-3 pt-2.5 border-t border-white/10 flex items-center justify-between text-[11px] text-zinc-400">
        <span class="flex items-center gap-1">💡 <i>Encodez vos heures pour l'agrandir</i></span>
      </div>
    </div>
  `;

  containerElement.appendChild(uiContainer);

  // Bind UI buttons
  document.getElementById('cam-focus-main').onclick = () => {
    smoothMoveCamera(new THREE.Vector3(45, 50, 65), new THREE.Vector3(0, 2, 0));
  };
  document.getElementById('cam-focus-all').onclick = () => {
    smoothMoveCamera(new THREE.Vector3(100, 110, 130), new THREE.Vector3(0, 0, 0));
  };
  document.getElementById('btn-toggle-daynight').onclick = toggleDayNight;
  document.getElementById('inspect-close').onclick = () => {
    document.getElementById('game-inspector-card').classList.add('hidden');
  };
}

function updateGameHUD(clansData, fullAgg) {
  const objEl = document.getElementById('game-objective-text');
  if (!objEl || !fullAgg) return;

  const refunded = fullAgg.refundedH || 0;
  const socleH = 25;
  const fullH = 43.75;
  const bonusEur = fullAgg.bonusEur || 0;

  if (!fullAgg.hasAnyNessy) {
    objEl.textContent = 'En attente : encodez une première heure pour éveiller la métropole !';
  } else if (refunded < socleH) {
    const remain = (socleH - refunded).toFixed(1);
    objEl.textContent = `Étape 1 : Reste ${remain} h pour consolider le Socle (2 000 €).`;
  } else if (refunded < fullH) {
    const remain = (fullH - refunded).toFixed(1);
    objEl.textContent = `Étape 2 : Reste ${remain} h pour rembourser le Min Garanti (3 500 €).`;
  } else {
    objEl.textContent = `🏆 Métropole florissante ! Surplus actif : +${bonusEur.toLocaleString('fr-BE')} € en caisse !`;
  }
}

function showInspectionCard(data) {
  const card = document.getElementById('game-inspector-card');
  if (!card || !data) return;

  document.getElementById('inspect-clan').textContent = data.isMain ? '★ VOTRE CLAN MAÎTRE' : `⚔ ${data.clan}`;
  document.getElementById('inspect-clan').className = data.isMain
    ? 'text-[10px] uppercase tracking-wider text-indigo-400 font-bold'
    : 'text-[10px] uppercase tracking-wider text-amber-400 font-bold';
  document.getElementById('inspect-name').textContent = data.name || 'Bâtiment';
  document.getElementById('inspect-district').textContent = data.district || 'Zone Urbaine';
  document.getElementById('inspect-status').textContent = data.status || 'Actif';
  document.getElementById('inspect-hours').textContent = data.hours || '—';

  card.classList.remove('hidden');
}

function toggleDayNight() {
  isNightMode = !isNightMode;
  const btn = document.getElementById('btn-toggle-daynight');
  if (btn) btn.textContent = isNightMode ? '☀️' : '🌙';

  if (isNightMode) {
    // Night mood
    scene.background = new THREE.Color(0x05070f);
    scene.fog.color.setHex(0x05070f);
    dirLight.intensity = 0.3;
    dirLight.color.setHex(0x60a5fa);
    ambientLight.intensity = 0.15;
    hemiLight.intensity = 0.2;
  } else {
    // Golden Day mood
    scene.background = new THREE.Color(0x0f172a);
    scene.fog.color.setHex(0x0f172a);
    dirLight.intensity = 1.8;
    dirLight.color.setHex(0xffedd5);
    ambientLight.intensity = 0.5;
    hemiLight.intensity = 0.6;
  }
}

function smoothMoveCamera(newPos, newTarget) {
  cameraTargetPos = newPos.clone();
  controlsTargetPos = newTarget.clone();
}

/* =========================================================================
   🖱️ MOUSE INTERACTION & RAYCASTING
   ========================================================================= */

function onMouseMove(event) {
  const rect = canvasElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(interactiveObjects, false);

  if (intersects.length > 0) {
    const hit = intersects[0].object;
    if (hoveredObject !== hit) {
      if (hoveredObject && hoveredObject.material && hoveredObject.material.emissive) {
        hoveredObject.material.emissive.setHex(0x000000);
      }
      hoveredObject = hit;
      if (hoveredObject.material && hoveredObject.material.emissive) {
        hoveredObject.material.emissive.setHex(0x38bdf8);
        hoveredObject.material.emissiveIntensity = 0.3;
      }
      canvasElement.style.cursor = 'pointer';
    }
  } else {
    if (hoveredObject && hoveredObject.material && hoveredObject.material.emissive) {
      hoveredObject.material.emissive.setHex(0x000000);
    }
    hoveredObject = null;
    canvasElement.style.cursor = 'default';
  }
}

function onMouseClick(event) {
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(interactiveObjects, false);

  if (intersects.length > 0) {
    const hit = intersects[0].object;
    if (hit.userData) {
      showInspectionCard(hit.userData);
      // Smooth focus on the clicked building
      const worldPos = new THREE.Vector3();
      hit.getWorldPosition(worldPos);
      smoothMoveCamera(
        new THREE.Vector3(worldPos.x + 25, worldPos.y + 25, worldPos.z + 30),
        worldPos
      );
    }
  }
}

function onWindowResize() {
  if (!containerElement || !camera || !renderer) return;
  const w = containerElement.clientWidth;
  const h = containerElement.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

/* =========================================================================
   🔄 ANIMATION LOOP
   ========================================================================= */

function animate(timeMs) {
  animFrameId = requestAnimationFrame(animate);
  const time = timeMs * 0.001;

  // Smooth camera transitions
  if (cameraTargetPos && controlsTargetPos) {
    camera.position.lerp(cameraTargetPos, 0.05);
    controls.target.lerp(controlsTargetPos, 0.05);
    if (camera.position.distanceTo(cameraTargetPos) < 0.2) {
      cameraTargetPos = null;
      controlsTargetPos = null;
    }
  }

  // Update controls
  if (controls) controls.update();

  // Update animated vehicles
  vehicles.forEach((v) => v.update(time));

  // Update animated elements (cranes, water, beacons)
  animatedElements.forEach((el) => el.update(time));

  // Render
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

/* =========================================================================
   ✨ FEEDBACK & SOUND EFFECTS
   ========================================================================= */

export function triggerLogEffect(clientId) {
  // 1. Play chime sound
  playChime(523.25, 0.4);
  setTimeout(() => playChime(659.25, 0.35), 120);
  setTimeout(() => playChime(783.99, 0.5), 240);

  // 2. Camera smooth transition to target clan
  let targetGroup = null;
  if (clientId && clanGroups.has(clientId)) {
    targetGroup = clanGroups.get(clientId);
  } else if (clanGroups.has('clan_main') || clanGroups.has('main')) {
    targetGroup = clanGroups.get('clan_main') || clanGroups.get('main');
  }

  const targetPos = targetGroup ? targetGroup.position.clone() : new THREE.Vector3(0, 0, 0);
  smoothMoveCamera(
    new THREE.Vector3(targetPos.x + 35, targetPos.y + 40, targetPos.z + 45),
    targetPos
  );

  // 3. Spawn golden particles over the target
  const pCount = 30;
  const pGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const pMat = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
  const pGroup = new THREE.Group();
  pGroup.position.copy(targetPos);
  pGroup.position.y += 10;
  scene.add(pGroup);

  const particles = [];
  for (let i = 0; i < pCount; i++) {
    const p = new THREE.Mesh(pGeo, pMat);
    p.position.set(
      (Math.random() - 0.5) * 10,
      Math.random() * 4,
      (Math.random() - 0.5) * 10
    );
    pGroup.add(p);
    particles.push({
      mesh: p,
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 0.4,
        0.3 + Math.random() * 0.4,
        (Math.random() - 0.5) * 0.4
      ),
      rot: Math.random() * 0.2,
    });
  }

  let elapsed = 0;
  const animItem = {
    update: () => {
      elapsed += 0.016;
      particles.forEach((pt) => {
        pt.mesh.position.add(pt.vel);
        pt.mesh.rotation.x += pt.rot;
        pt.mesh.rotation.y += pt.rot;
        pt.mesh.scale.multiplyScalar(0.97);
      });
      if (elapsed > 1.8) {
        scene.remove(pGroup);
        const idx = animatedElements.indexOf(animItem);
        if (idx !== -1) animatedElements.splice(idx, 1);
      }
    }
  };
  animatedElements.push(animItem);
}

function playChime(freq = 587.33, duration = 0.3) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {
    // Audio context may require user gesture on some browsers
  }
}
