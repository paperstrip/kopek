// =============================================================================
// KOPEK CITY · Ville 2.5D low-poly générée en Three.js
// Pilotée par la progression des 3 paliers du contrat (Socle / Garantie / Bonus).
// La composition (palette, formes, jitter) change chaque mois via un seed.
// =============================================================================
import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';

// ---- PRNG déterministe (mulberry32) — même seed = même ville ----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function lerp(a, b, t) { return a + (b - a) * t; }

// ---- Palettes pastel (une par "thème du mois") ----
const THEMES = [
  { name: 'Aurore',   sky: ['#fde2ff', '#c9e7ff'], sun: '#ffe08a', ground: '#bff0c9', accents: ['#ff9ecb', '#7dd3fc', '#a78bfa', '#fca5a5'] },
  { name: 'Menthe',   sky: ['#e0fff4', '#bae6fd'], sun: '#fef08a', ground: '#a7f3d0', accents: ['#34d399', '#38bdf8', '#fbbf24', '#f472b6'] },
  { name: 'Agrume',   sky: ['#fff7cd', '#ffd6a5'], sun: '#fde68a', ground: '#d9f99d', accents: ['#fb923c', '#facc15', '#4ade80', '#38bdf8'] },
  { name: 'Lagon',    sky: ['#dff9ff', '#a5d8ff'], sun: '#fff3b0', ground: '#8fe3c7', accents: ['#22d3ee', '#818cf8', '#fca5a5', '#fde047'] },
  { name: 'Lavande',  sky: ['#f1e8ff', '#d8c7ff'], sun: '#ffe6a7', ground: '#c9e8c0', accents: ['#a78bfa', '#f0abfc', '#fbbf24', '#60a5fa'] },
  { name: 'Corail',   sky: ['#ffe8e0', '#ffd0e0'], sun: '#ffd166', ground: '#b8ebc9', accents: ['#fb7185', '#fdba74', '#a3e635', '#67e8f9'] },
];

const DISTRICTS = [
  { key: 'socle',    label: 'Socle',    cx: -6.4, colorRole: 0, shapes: ['villa', 'shop'] },
  { key: 'garantie', label: 'Garantie', cx: 0,     colorRole: 1, shapes: ['shop', 'midrise'] },
  { key: 'bonus',    label: 'Bonus',    cx: 6.4,   colorRole: 2, shapes: ['tower', 'spire'] },
];

let renderer, scene, camera, controls, clock;
let canvasEl, roEl;
let sunMesh, sunLight;
let cityGroup, carsGroup, confettiGroup;
let carAnims = [];
let confettiPool = [];
let lastSeedKey = null;
let growTargets = new Map(); // mesh -> {from, to, t}
let raf = null;

function makeSkyTexture(top, bottom) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function roundedPlateGeometry(w, h, r, segments = 6) {
  const shape = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.35, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2, curveSegments: segments });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -0.02, 0);
  return geo;
}

function buildingGeometry(type) {
  const group = new THREE.Group();
  const specs = {
    villa:   { w: 0.9, h: 0.75, roof: 'hip',   roofH: 0.4 },
    shop:    { w: 1.0, h: 1.1,  roof: 'flat',  roofH: 0.12 },
    midrise: { w: 0.95, h: 2.0, roof: 'flat',  roofH: 0.12 },
    tower:   { w: 0.85, h: 3.1, roof: 'cone',  roofH: 0.55 },
    spire:   { w: 0.72, h: 3.9, roof: 'spire', roofH: 0.9 },
  }[type];
  const body = new THREE.Mesh(new THREE.BoxGeometry(specs.w, specs.h, specs.w));
  body.position.y = specs.h / 2;
  body.castShadow = true; body.receiveShadow = true;
  body.name = 'body';
  group.add(body);

  let roof;
  if (specs.roof === 'hip') {
    roof = new THREE.Mesh(new THREE.ConeGeometry(specs.w * 0.78, specs.roofH, 4));
    roof.rotation.y = Math.PI / 4;
  } else if (specs.roof === 'cone') {
    roof = new THREE.Mesh(new THREE.ConeGeometry(specs.w * 0.62, specs.roofH, 8));
  } else if (specs.roof === 'spire') {
    roof = new THREE.Mesh(new THREE.ConeGeometry(specs.w * 0.42, specs.roofH, 6));
  } else {
    roof = new THREE.Mesh(new THREE.BoxGeometry(specs.w * 1.04, specs.roofH, specs.w * 1.04));
  }
  roof.position.y = specs.h + specs.roofH / 2;
  roof.castShadow = true;
  roof.name = 'roof';
  group.add(roof);

  // petites fenêtres (points emissifs) pour le côté "nuit qui scintille"
  const winGeo = new THREE.PlaneGeometry(0.09, 0.09);
  const rows = Math.max(1, Math.floor(specs.h / 0.35));
  for (let f = 0; f < 4; f++) {
    const angle = (Math.PI / 2) * f;
    for (let r = 1; r < rows; r++) {
      if (Math.random() > 0.55) continue;
      const win = new THREE.Mesh(winGeo, group.userData.winMat);
      win.position.set(Math.sin(angle) * (specs.w / 2 + 0.01), r * 0.32, Math.cos(angle) * (specs.w / 2 + 0.01));
      win.rotation.y = angle;
      win.name = 'window';
      group.add(win);
    }
  }
  group.userData.totalH = specs.h + specs.roofH;
  return group;
}

const TRUNK_MAT = new THREE.MeshStandardMaterial({ color: '#8a5a34', roughness: 0.9 });
function makeTree(rng, foliageHex) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.28, 5), TRUNK_MAT);
  trunk.position.y = 0.14;
  trunk.castShadow = true;
  const foliage = new THREE.Mesh(
    new THREE.ConeGeometry(0.26, 0.5, 6),
    new THREE.MeshStandardMaterial({ color: foliageHex || '#4ade80', roughness: 0.8 })
  );
  foliage.position.y = 0.5;
  foliage.castShadow = true;
  g.add(trunk, foliage);
  g.userData.foliage = foliage;
  g.scale.setScalar(lerp(0.8, 1.15, rng()));
  return g;
}

function makeCar(colorHex) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.13, 0.18), new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.5 }));
  body.position.y = 0.1;
  body.castShadow = true;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.15), new THREE.MeshStandardMaterial({ color: '#dbeafe', roughness: 0.3 }));
  cab.position.set(-0.02, 0.19, 0);
  g.add(body, cab);
  return g;
}

export function initCity(canvas) {
  canvasEl = canvas;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0, 9.5, 13.5);
  camera.lookAt(0, 0.6, 0);

  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.6, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 9;
  controls.maxDistance = 20;
  controls.minPolarAngle = Math.PI * 0.18;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;

  const hemi = new THREE.HemisphereLight('#bfe3ff', '#3f7a4e', 1.0);
  scene.add(hemi);
  sunLight = new THREE.DirectionalLight('#fff3d6', 1.35);
  sunLight.position.set(7, 11, 5);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  const cam = sunLight.shadow.camera;
  cam.left = -11; cam.right = 11; cam.top = 8; cam.bottom = -8; cam.near = 1; cam.far = 30;
  scene.add(sunLight);
  scene.add(sunLight.target);

  sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 16, 16),
    new THREE.MeshBasicMaterial({ color: '#ffe08a' })
  );
  scene.add(sunMesh);

  cityGroup = new THREE.Group(); scene.add(cityGroup);
  carsGroup = new THREE.Group(); scene.add(carsGroup);
  confettiGroup = new THREE.Group(); scene.add(confettiGroup);

  clock = new THREE.Clock();
  onResize();
  window.addEventListener('resize', onResize);
  raf = requestAnimationFrame(tick);
}

function onResize() {
  if (!canvasEl) return;
  const w = canvasEl.clientWidth || 600, h = canvasEl.clientHeight || 400;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function tick() {
  raf = requestAnimationFrame(tick);
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();

  controls.update();

  sunMesh.position.set(Math.cos(t * 0.05) * 0.2, 8.6 + Math.sin(t * 0.4) * 0.15, -3.5);

  // croissance progressive des bâtiments en construction
  growTargets.forEach((g, mesh) => {
    g.t = Math.min(1, g.t + dt * 1.6);
    const s = lerp(g.from, g.to, easeOutBack(g.t));
    mesh.scale.y = Math.max(0.001, s);
    mesh.position.y = mesh.userData.baseY * s;
    if (g.t >= 1) growTargets.delete(mesh);
  });

  // scintillement fenêtres
  cityGroup.traverse((o) => {
    if (o.name === 'window' && o.material && o.material.userData.blink) {
      const m = o.material;
      m.emissiveIntensity = 0.6 + Math.sin(t * m.userData.blink + m.userData.phase) * 0.4;
    }
  });

  // voitures
  carAnims.forEach((c) => {
    c.progress = (c.progress + dt / c.duration) % 1;
    const p = c.curve.getPointAt(c.progress);
    const p2 = c.curve.getPointAt((c.progress + 0.01) % 1);
    c.mesh.position.copy(p);
    c.mesh.lookAt(p2);
  });

  // confetti
  for (let i = confettiPool.length - 1; i >= 0; i--) {
    const c = confettiPool[i];
    c.vy -= dt * 2.4;
    c.mesh.position.y += c.vy * dt;
    c.mesh.rotation.x += dt * c.spin;
    c.mesh.rotation.z += dt * c.spin * 0.7;
    c.life -= dt;
    if (c.life <= 0 || c.mesh.position.y < -0.5) {
      confettiGroup.remove(c.mesh);
      confettiPool.splice(i, 1);
    }
  }

  renderer.render(scene, camera);
}

function easeOutBack(x) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function clearGroup(g) {
  while (g.children.length) {
    const c = g.children.pop();
    c.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
  }
}

/**
 * Reconstruit / met à jour la ville.
 * @param {object} agg - agrégat du mois (mêmes champs que aggregateMonth())
 * @param {{socleH:number, garantieH:number}} caps
 * @param {number} seedKey - identifiant unique du mois (ex. year*12+month)
 */
export function renderCityScene(agg, caps, seedKey) {
  if (!scene) return;
  const soclePct = Math.min(100, ((agg.refundedH || 0) / caps.socleH) * 100);
  const garantiePct = (agg.refundedH || 0) >= caps.socleH
    ? Math.min(100, (((agg.refundedH || 0) - caps.socleH) / (caps.garantieH - caps.socleH)) * 100)
    : 0;
  const bonusH = agg.tiers?.t3?.h || 0;
  const bonusPct = Math.min(150, (bonusH / 10) * 100);
  const progress = { socle: soclePct, garantie: garantiePct, bonus: bonusPct };

  const rng = mulberry32((seedKey || 0) * 7919 + 13);
  const theme = THEMES[Math.abs(seedKey || 0) % THEMES.length];

  // Le PRNG est déterministe (même seed = même mois → mêmes formes/positions/thème),
  // donc on peut reconstruire à chaque appel : seul `progress` fait varier le nombre
  // de bâtiments "débloqués". La scène reste légère (< 60 objets), le coût est négligeable.
  buildCity(rng, theme, progress);
  lastSeedKey = seedKey;

  scene.background = makeSkyTexture(theme.sky[0], theme.sky[1]);
  scene.fog = new THREE.Fog(theme.sky[1], 16, 30);
}

function buildCity(rng, theme, progress) {
  clearGroup(cityGroup);
  clearGroup(carsGroup);
  growTargets = new Map();
  carAnims = [];

  // sol général
  const baseGround = new THREE.Mesh(
    new THREE.CircleGeometry(9.6, 40),
    new THREE.MeshStandardMaterial({ color: theme.ground, roughness: 1 })
  );
  baseGround.rotation.x = -Math.PI / 2;
  baseGround.receiveShadow = true;
  cityGroup.add(baseGround);

  // route centrale reliant les 3 districts
  const roadMat = new THREE.MeshStandardMaterial({ color: '#3f3f46', roughness: 0.9 });
  const road = new THREE.Mesh(new THREE.BoxGeometry(14.4, 0.05, 1.15), roadMat);
  road.position.y = 0.03;
  road.receiveShadow = true;
  cityGroup.add(road);
  const lineMat = new THREE.MeshBasicMaterial({ color: '#fde047' });
  for (let x = -6.6; x <= 6.6; x += 0.9) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.001, 0.06), lineMat);
    dash.position.set(x, 0.061, 0);
    cityGroup.add(dash);
  }

  DISTRICTS.forEach((d, di) => {
    const plate = new THREE.Mesh(
      roundedPlateGeometry(4.6, 3.8, 0.5),
      new THREE.MeshStandardMaterial({ color: theme.accents[d.colorRole], roughness: 0.85, metalness: 0.02 })
    );
    plate.position.set(d.cx, 0, 0);
    plate.receiveShadow = true;
    cityGroup.add(plate);

    // grille de parcelles avec jitter (organique)
    const cols = 3, rows = 3;
    const slots = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === 1 && c === 1 && di === 1) continue; // laisse un espace place centrale district garantie
        slots.push({
          x: d.cx + (c - (cols - 1) / 2) * 1.35 + (rng() - 0.5) * 0.28,
          z: (r - (rows - 1) / 2) * 1.05 + (rng() - 0.5) * 0.22,
        });
      }
    }
    const pct = progress[d.key];
    const built = Math.floor((pct / 100) * slots.length);
    const activeIdx = pct > 0 && built < slots.length ? built : -1;

    slots.forEach((slot, idx) => {
      const isBuilt = idx < built;
      const isActive = idx === activeIdx;
      if (!isBuilt && !isActive) return;
      const type = pick(rng, d.shapes);
      const winMat = new THREE.MeshStandardMaterial({
        color: '#fef9c3', emissive: '#facc15', emissiveIntensity: 0.7, roughness: 0.4,
      });
      winMat.userData.blink = lerp(1.2, 2.6, rng());
      winMat.userData.phase = rng() * Math.PI * 2;
      const tempGroupHack = { userData: { winMat } };
      const bld = buildingGeometryWithMat(type, winMat, theme.accents[(d.colorRole + 1) % theme.accents.length]);
      bld.position.set(slot.x, 0, slot.z);
      bld.rotation.y = (rng() - 0.5) * 0.3;
      const scale = lerp(0.86, 1.05, rng());
      bld.scale.set(scale, 0, scale);
      bld.userData.baseY = 0;
      cityGroup.add(bld);
      growTargets.set(bld, { from: 0, to: scale, t: isBuilt ? 1 : 0 });
      if (isBuilt) bld.scale.y = scale;

      if (isActive) {
        const crane = makeCrane();
        crane.position.set(slot.x, 0, slot.z);
        crane.userData.spin = true;
        cityGroup.add(crane);
      }
    });

    // arbres décoratifs
    const treeCount = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < treeCount; i++) {
      const tree = makeTree(rng, theme.accents[(d.colorRole + 2) % theme.accents.length]);
      const angle = rng() * Math.PI * 2;
      const rad = 1.9 + rng() * 0.4;
      tree.position.set(d.cx + Math.cos(angle) * rad, 0, Math.sin(angle) * rad);
      cityGroup.add(tree);
    }
  });

  // voitures sur la route centrale
  const carColors = theme.accents;
  for (let i = 0; i < 3; i++) {
    const car = makeCar(carColors[i % carColors.length]);
    car.castShadow = true;
    carsGroup.add(car);
    const zOff = i % 2 === 0 ? 0.25 : -0.25;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-7.2, 0.05, zOff),
      new THREE.Vector3(0, 0.05, zOff),
      new THREE.Vector3(7.2, 0.05, zOff),
      new THREE.Vector3(0, 0.05, zOff),
    ], true, 'catmullrom', 0.2);
    carAnims.push({ mesh: car, curve, progress: rng(), duration: lerp(9, 15, rng()) });
  }
}

function buildingGeometryWithMat(type, winMat, roofColorHex) {
  const group = new THREE.Group();
  const specs = {
    villa:   { w: 0.9, h: 0.75, roof: 'hip',   roofH: 0.4,  body: '#fecaca' },
    shop:    { w: 1.0, h: 1.1,  roof: 'flat',  roofH: 0.12, body: '#bae6fd' },
    midrise: { w: 0.95, h: 2.0, roof: 'flat',  roofH: 0.12, body: '#ddd6fe' },
    tower:   { w: 0.85, h: 3.1, roof: 'cone',  roofH: 0.55, body: '#a7f3d0' },
    spire:   { w: 0.72, h: 3.9, roof: 'spire', roofH: 0.9,  body: '#fef08a' },
  }[type];
  const bodyMat = new THREE.MeshStandardMaterial({ color: specs.body, roughness: 0.7 });
  const roofMat = new THREE.MeshStandardMaterial({ color: roofColorHex, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(specs.w, specs.h, specs.w), bodyMat);
  body.position.y = specs.h / 2;
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);

  let roof;
  if (specs.roof === 'hip') { roof = new THREE.Mesh(new THREE.ConeGeometry(specs.w * 0.78, specs.roofH, 4), roofMat); roof.rotation.y = Math.PI / 4; }
  else if (specs.roof === 'cone') { roof = new THREE.Mesh(new THREE.ConeGeometry(specs.w * 0.62, specs.roofH, 8), roofMat); }
  else if (specs.roof === 'spire') { roof = new THREE.Mesh(new THREE.ConeGeometry(specs.w * 0.42, specs.roofH, 6), roofMat); }
  else { roof = new THREE.Mesh(new THREE.BoxGeometry(specs.w * 1.04, specs.roofH, specs.w * 1.04), roofMat); }
  roof.position.y = specs.h + specs.roofH / 2;
  roof.castShadow = true;
  group.add(roof);

  const winGeo = new THREE.PlaneGeometry(0.1, 0.1);
  const rows = Math.max(1, Math.floor(specs.h / 0.35));
  for (let f = 0; f < 4; f++) {
    const angle = (Math.PI / 2) * f;
    for (let r = 1; r < rows; r++) {
      if (Math.random() > 0.5) continue;
      const win = new THREE.Mesh(winGeo, winMat);
      win.name = 'window';
      win.position.set(Math.sin(angle) * (specs.w / 2 + 0.01), r * 0.32, Math.cos(angle) * (specs.w / 2 + 0.01));
      win.rotation.y = angle + Math.PI;
      group.add(win);
    }
  }
  return group;
}

function makeCrane() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#facc15', roughness: 0.5 });
  const mast = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.6, 0.04), mat);
  mast.position.y = 0.8;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.04), mat);
  arm.position.set(0.3, 1.55, 0);
  g.add(mast, arm);
  return g;
}

/** Déclenche une pluie de confettis (ex. franchissement d'un palier) */
export function celebrate(colorHexList = ['#34d399', '#facc15', '#f472b6', '#818cf8']) {
  if (!scene) return;
  for (let i = 0; i < 46; i++) {
    const geo = Math.random() > 0.5 ? new THREE.PlaneGeometry(0.09, 0.09) : new THREE.BoxGeometry(0.07, 0.07, 0.07);
    const mat = new THREE.MeshStandardMaterial({ color: colorHexList[i % colorHexList.length], side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((Math.random() - 0.5) * 2, 4 + Math.random() * 1.5, (Math.random() - 0.5) * 2);
    mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    confettiGroup.add(mesh);
    confettiPool.push({ mesh, vy: -0.3 - Math.random() * 0.6, spin: 2 + Math.random() * 4, life: 3 + Math.random() });
  }
}

export function resizeCity() { onResize(); }
