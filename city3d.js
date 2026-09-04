// =============================================================================
// KOPEK CITY · Ville 2.5D low-poly générée en Three.js
// Pilotée par la progression des 3 paliers du contrat (Socle / Garantie / Bonus).
// La composition (palette, formes, jitter) change chaque mois via un seed.
// =============================================================================
import * as THREE from './vendor/three/three.module.js?v=2026-09-03-12';
import { OrbitControls } from './vendor/three/OrbitControls.js?v=2026-09-03-12';

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

// ---- Palettes nocturnes, alignées sur l'UI sombre du cockpit ----
// Le ciel/sol changent chaque mois, mais la couleur d'un quartier ne change
// JAMAIS : elle reprend celle de son palier dans la jauge (indigo = Socle,
// fuchsia = Garantie, émeraude = Bonus) pour qu'on relie les deux d'un coup d'œil.
const THEMES = [
  { name: 'Nuit indigo',   sky: ['#25325e', '#111936'], ground: '#33406b', trees: '#43a17c' },
  { name: 'Nuit violette', sky: ['#2c2456', '#161232'], ground: '#3a2f68', trees: '#4aa088' },
  { name: 'Nuit océan',    sky: ['#1c3a5c', '#0e1d33'], ground: '#254a6e', trees: '#3da393' },
  { name: 'Nuit prune',    sky: ['#3a2653', '#1a1030'], ground: '#43305f', trees: '#4f9d78' },
  { name: 'Nuit ardoise',  sky: ['#243156', '#10182e'], ground: '#32405f', trees: '#419b85' },
  { name: 'Nuit sapin',    sky: ['#1a3b56', '#0c1c2e'], ground: '#22496b', trees: '#43a68d' },
];

// Couleurs de palier, identiques à celles de la jauge et des badges.
const TIER_COLORS = {
  socle:    { plate: '#4f46e5', roof: '#818cf8' },  // indigo
  garantie: { plate: '#a21caf', roof: '#e879f9' },  // fuchsia
  bonus:    { plate: '#047857', roof: '#34d399' },  // émeraude
};

// Corps de bâtiments : ardoises sombres, pour que ce soit la couleur du palier
// (toit) et les fenêtres allumées qui ressortent.
const BODY_COLORS = ['#5b6b86', '#67789a', '#526283', '#71829f'];

// Un quartier par palier de la jauge, dans l'ordre où on les remplit.
const DISTRICTS = [
  { key: 'socle',    label: 'Socle',    shapes: ['villa', 'shop'] },
  { key: 'garantie', label: 'Garantie', shapes: ['shop', 'midrise'] },
  { key: 'bonus',    label: 'Bonus',    shapes: ['tower', 'spire'] },
];

let renderer, scene, camera, controls, clock;
let canvasEl, roEl;
let sunLight;
let cityGroup, carsGroup, confettiGroup;
let carAnims = [];
let confettiPool = [];
let lastSeedKey = null;
let growTargets = new Map(); // mesh -> {from, to, t}
let raf = null;
let lastBuildArgs = null;    // permet de rebâtir à l'identique si l'écran change de forme

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
  controls.target.set(0, 1.1, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 8;
  controls.maxDistance = 40;
  controls.minPolarAngle = Math.PI * 0.18;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;

  const hemi = new THREE.HemisphereLight('#8ea4dd', '#243049', 1.05);
  scene.add(hemi);
  sunLight = new THREE.DirectionalLight('#dbe6ff', 1.35);
  sunLight.position.set(7, 11, 5);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  const cam = sunLight.shadow.camera;
  cam.left = -11; cam.right = 11; cam.top = 8; cam.bottom = -8; cam.near = 1; cam.far = 30;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // Pas de disque solaire : à cette distance il passait derrière les étiquettes
  // du HUD et bavait dans le ciel. La lumière directionnelle suffit.

  cityGroup = new THREE.Group(); scene.add(cityGroup);
  carsGroup = new THREE.Group(); scene.add(carsGroup);
  confettiGroup = new THREE.Group(); scene.add(confettiGroup);

  canvas.addEventListener('webglcontextlost', (e) => {
    // preventDefault() est indispensable : sans lui le contexte n'est jamais restauré.
    e.preventDefault();
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    console.warn('[kopek] contexte WebGL perdu');
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    console.warn('[kopek] contexte WebGL restauré · reconstruction');
    currentLayout = null;
    onResize();
    if (lastBuildArgs) {
      buildCity(lastBuildArgs.rngFactory(), lastBuildArgs.theme, lastBuildArgs.progress, currentLayout);
      frameCity();
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }, false);

  clock = new THREE.Clock();
  onResize();
  window.addEventListener('resize', onResize);
  raf = requestAnimationFrame(tick);
}

/** 'compact' dès que le canvas est presque carré ou plus haut que large (téléphone). */
function layoutForAspect(aspect) {
  return aspect < 1.45 ? 'compact' : 'linear';
}

let currentLayout = null;
let camDist = 16;

/** Le brouillard doit suivre la distance de caméra, sinon il avale la ville entière. */
function applyFog() {
  if (scene && scene.fog) {
    scene.fog.near = camDist * 0.85;
    scene.fog.far = camDist * 2.6;
  }
}

/**
 * Recule la caméra juste ce qu'il faut pour que TOUTE la ville tienne dans le
 * cadre, quel que soit l'angle (la caméra tourne en continu). Sans ça, un écran
 * étroit réduit le champ horizontal et on a le nez collé sur un seul quartier.
 */
function frameCity() {
  const radius = cityRadius(currentLayout || 'linear');
  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = Math.max(radius / Math.tan(hFov / 2), (radius * 0.6) / Math.tan(vFov / 2)) * 0.98;
  camDist = dist;
  controls.minDistance = dist * 0.75;
  controls.maxDistance = dist * 1.8;

  // Angle de plongée : sur un écran étroit on regarde la ville de plus haut,
  // sinon la disposition en diagonale laisse la moitié du cadre en ciel vide.
  const polar = currentLayout === 'compact' ? 0.78 : 1.02;
  const dirNow = camera.position.clone().sub(controls.target);
  const azimuth = Math.atan2(dirNow.x, dirNow.z);
  camera.position.set(
    controls.target.x + dist * Math.sin(polar) * Math.sin(azimuth),
    controls.target.y + dist * Math.cos(polar),
    controls.target.z + dist * Math.sin(polar) * Math.cos(azimuth)
  );
  controls.update();
  applyFog();
  // L'ombre portée doit couvrir la ville entière, sinon les quartiers du bord
  // perdent leur ombre quand la disposition change.
  const sc = sunLight.shadow.camera;
  sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
  sc.far = dist * 2.5;
  sc.updateProjectionMatrix();
  sunLight.position.set(radius * 0.7, radius * 1.2, radius * 0.5);
}

function onResize() {
  if (!canvasEl) return;
  const w = canvasEl.clientWidth || 600, h = canvasEl.clientHeight || 400;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  // Changement de forme d'écran → on rebâtit avec la disposition adaptée.
  const wanted = layoutForAspect(camera.aspect);
  if (wanted !== currentLayout) {
    currentLayout = wanted;
    if (lastBuildArgs) buildCity(lastBuildArgs.rngFactory(), lastBuildArgs.theme, lastBuildArgs.progress, currentLayout);
  }
  frameCity();
}

function tick() {
  raf = requestAnimationFrame(tick);
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();

  controls.update();


  // croissance progressive des bâtiments en construction
  growTargets.forEach((g, mesh) => {
    g.t = Math.min(1, g.t + dt * 1.6);
    const s = lerp(g.from, g.to, easeOutBack(g.t));
    mesh.scale.y = Math.max(0.001, s);
    mesh.position.y = mesh.userData.baseY;
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

  const seed = (seedKey || 0) * 7919 + 13;
  const theme = THEMES[Math.abs(seedKey || 0) % THEMES.length];
  if (!currentLayout) currentLayout = layoutForAspect(camera.aspect);

  // On mémorise de quoi rebâtir à l'identique si l'écran change de forme.
  lastBuildArgs = { rngFactory: () => mulberry32(seed), theme, progress };

  // Le PRNG est déterministe (même seed = même mois → mêmes formes/positions/thème),
  // donc on peut reconstruire à chaque appel : seul `progress` fait varier le nombre
  // de bâtiments "débloqués". La scène reste légère (< 60 objets), le coût est négligeable.
  buildCity(mulberry32(seed), theme, progress, currentLayout);
  lastSeedKey = seedKey;

  scene.background = makeSkyTexture(theme.sky[0], theme.sky[1]);
  scene.fog = new THREE.Fog(theme.sky[1], 1, 100);
  frameCity();
}

/**
 * Positions des quartiers selon la forme du canvas.
 *  - 'linear'  : les 3 quartiers alignés (écran large)
 *  - 'compact' : disposition en diagonale (écran étroit/téléphone) — une bande
 *    horizontale de 15 unités ne peut pas remplir un viewport quasi carré.
 */
function districtCenters(layout) {
  if (layout === 'compact') {
    return [
      { x: -3.5, z: 2.9 },
      { x: 0.2, z: -0.2 },
      { x: 3.9, z: -3.2 },
    ];
  }
  return [
    { x: -6.4, z: 0 },
    { x: 0, z: 0 },
    { x: 6.4, z: 0 },
  ];
}

/** Rayon englobant la ville, pour cadrer la caméra sans rien couper. */
function cityRadius(layout) {
  const centers = districtCenters(layout);
  let r = 0;
  centers.forEach((c) => { r = Math.max(r, Math.hypot(c.x, c.z)); });
  return r + 3.2; // + demi-diagonale de plaque
}

/** Segment de route entre deux points, avec ses pointillés. */
function addRoadSegment(a, b) {
  const roadMat = new THREE.MeshStandardMaterial({ color: '#3f3f46', roughness: 0.9 });
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  const angle = Math.atan2(dx, dz);

  const road = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.05, len + 1.2), roadMat);
  road.position.set((a.x + b.x) / 2, 0.03, (a.z + b.z) / 2);
  road.rotation.y = angle;
  road.receiveShadow = true;
  cityGroup.add(road);

  const lineMat = new THREE.MeshBasicMaterial({ color: '#fde047' });
  const dashes = Math.max(2, Math.round(len / 0.9));
  for (let i = 0; i < dashes; i++) {
    const t = (i + 0.5) / dashes;
    const dash = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.001, 0.45), lineMat);
    dash.position.set(a.x + dx * t, 0.061, a.z + dz * t);
    dash.rotation.y = angle;
    cityGroup.add(dash);
  }
}

// Hauteur réelle du dessus de la plaque : calculée depuis la géométrie, car le
// biseau de l'ExtrudeGeometry ajoute de la hauteur en plus de `depth` — une
// valeur devinée enterrait bâtiments et parcelles dans la plaque.
let PLATE_TOP = 0.33;
function measurePlateTop(geo) {
  geo.computeBoundingBox();
  PLATE_TOP = geo.boundingBox.max.y;
}

function buildCity(rng, theme, progress, layout) {
  clearGroup(cityGroup);
  clearGroup(carsGroup);
  growTargets = new Map();
  carAnims = [];

  const centers = districtCenters(layout);
  const groundR = cityRadius(layout) + 1.2;

  // sol général
  const baseGround = new THREE.Mesh(
    new THREE.CircleGeometry(groundR, 44),
    new THREE.MeshStandardMaterial({ color: theme.ground, roughness: 1 })
  );
  baseGround.rotation.x = -Math.PI / 2;
  baseGround.receiveShadow = true;
  cityGroup.add(baseGround);

  // routes reliant les quartiers consécutifs
  for (let i = 0; i < centers.length - 1; i++) addRoadSegment(centers[i], centers[i + 1]);

  DISTRICTS.forEach((d, di) => {
    const C = centers[di];
    const plateGeo = roundedPlateGeometry(4.7, 4.5, 0.55);
    measurePlateTop(plateGeo);
    const plate = new THREE.Mesh(
      plateGeo,
      new THREE.MeshStandardMaterial({ color: TIER_COLORS[d.key].plate, roughness: 0.85, metalness: 0.02 })
    );
    plate.position.set(C.x, 0, C.z);
    plate.receiveShadow = true;
    cityGroup.add(plate);

    // grille de parcelles avec jitter (organique)
    const cols = 3, rows = 3;
    const slots = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === 1 && c === 1 && di === 1) continue; // place centrale du quartier Garantie
        slots.push({
          x: C.x + (c - (cols - 1) / 2) * 1.32 + (rng() - 0.5) * 0.16,
          z: C.z + (r - (rows - 1) / 2) * 1.32 + (rng() - 0.5) * 0.14,
        });
      }
    }
    // Mélange déterministe : la ville se remplit de façon dispersée et non
    // rangée par rangée (sinon tout s'entasse dans un coin de la plaque).
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }

    const pct = progress[d.key];
    const built = Math.floor((pct / 100) * slots.length);
    const activeIdx = pct > 0 && built < slots.length ? built : -1;

    slots.forEach((slot, idx) => {
      const isBuilt = idx < built;
      const isActive = idx === activeIdx;
      if (!isBuilt && !isActive) {
        // Parcelle encore libre : on la matérialise pour que le quartier ne soit
        // pas une simple dalle vide — on voit ce qu'il reste à construire.
        const pad = new THREE.Mesh(
          new THREE.BoxGeometry(0.86, 0.05, 0.74),
          new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 1 })
        );
        pad.position.set(slot.x, PLATE_TOP + 0.025, slot.z);
        pad.receiveShadow = true;
        cityGroup.add(pad);
        return;
      }
      const type = pick(rng, d.shapes);
      const winMat = new THREE.MeshStandardMaterial({
        color: '#fde68a', emissive: '#fbbf24', emissiveIntensity: 1.25, roughness: 0.4,
      });
      winMat.userData.blink = lerp(1.2, 2.6, rng());
      winMat.userData.phase = rng() * Math.PI * 2;
      const bld = buildingGeometryWithMat(type, winMat, TIER_COLORS[d.key].roof, pick(rng, BODY_COLORS));
      bld.position.set(slot.x, PLATE_TOP, slot.z);
      bld.rotation.y = (rng() - 0.5) * 0.3;
      const scale = lerp(0.95, 1.1, rng());
      bld.scale.set(scale, 0, scale);
      bld.userData.baseY = PLATE_TOP;
      cityGroup.add(bld);
      growTargets.set(bld, { from: 0, to: scale, t: isBuilt ? 1 : 0 });
      if (isBuilt) bld.scale.y = scale;

      if (isActive) {
        const crane = makeCrane();
        crane.position.set(slot.x, PLATE_TOP, slot.z);
        cityGroup.add(crane);
      }
    });

    // arbres décoratifs autour de la plaque
    const treeCount = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < treeCount; i++) {
      const tree = makeTree(rng, theme.trees);
      const angle = rng() * Math.PI * 2;
      const rad = 3.1 + rng() * 0.6;
      tree.position.set(C.x + Math.cos(angle) * rad, 0, C.z + Math.sin(angle) * rad);
      cityGroup.add(tree);
    }
  });

  // trafic : les voitures suivent la route d'un bout à l'autre puis reviennent
  const path = centers.map((c) => new THREE.Vector3(c.x, 0.05, c.z));
  const backAndForth = path.concat(path.slice(0, -1).reverse());
  for (let i = 0; i < 3; i++) {
    const car = makeCar(['#f8fafc', '#fca5a5', '#93c5fd'][i % 3]);
    car.castShadow = true;
    carsGroup.add(car);
    const curve = new THREE.CatmullRomCurve3(backAndForth, true, 'catmullrom', 0.2);
    carAnims.push({ mesh: car, curve, progress: rng(), duration: lerp(11, 18, rng()) });
  }
}

function buildingGeometryWithMat(type, winMat, roofColorHex, bodyColorHex) {
  const group = new THREE.Group();
  const specs = {
    villa:   { w: 0.9, h: 0.75, roof: 'hip',   roofH: 0.4,  body: '#fecaca' },
    shop:    { w: 1.0, h: 1.1,  roof: 'flat',  roofH: 0.12, body: '#bae6fd' },
    midrise: { w: 0.95, h: 2.0, roof: 'flat',  roofH: 0.12, body: '#ddd6fe' },
    tower:   { w: 0.85, h: 3.1, roof: 'cone',  roofH: 0.55, body: '#a7f3d0' },
    spire:   { w: 0.72, h: 3.9, roof: 'spire', roofH: 0.9,  body: '#fef08a' },
  }[type];
  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColorHex || specs.body, roughness: 0.75 });
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
