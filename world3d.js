// =============================================================================
// 🏝️  LES MARCHES DE NESSY · rendu 3D de l'archipel
// -----------------------------------------------------------------------------
// Direction artistique : cartoon doux. Tout est arrondi — les tuiles ont des
// coins adoucis et un biseau généreux, les arbres et les rochers sont des
// volumes lisses, jamais des cônes facettés. La lumière est chaude et rasante,
// avec une brume claire qui éloigne l'horizon.
//
// Ce module ne connaît PAS les règles du jeu : on lui passe une carte de tuiles,
// il la dessine et signale la tuile touchée. Toute la logique vit dans game.js.
// =============================================================================
import * as THREE from './vendor/three/three.module.js?v=2026-09-03-13';
import { OrbitControls } from './vendor/three/OrbitControls.js?v=2026-09-03-13';
import { axialToWorld, TERRAINS, CLANS, neighbors, tileKey } from './game.js?v=2026-09-03-13';

const HEX = 1.0;                 // rayon d'un hexagone
const GAP = 0.13;                // interstice : c'est lui qui fait « îles séparées »
const TILE_H = 0.42;

// Palette : des verts un peu délavés et des sables chauds, comme une maquette
// peinte à la main. Les couleurs pures « écran » cassaient l'effet cartoon.
const PALETTE = {
  ciel_haut: '#8fd3e8', ciel_bas: '#ffe6c4',
  mer: '#2e7d99', mer_profonde: '#1b4f66',
  brume: '#9fc4d4',
  flanc: '#8a6a4a',           // la roche sous la tuile
  flanc_sable: '#c2a06f',
  joueur: '#f2c14e',
  neutre: '#9aa7b0',
};

let renderer, scene, camera, controls, clock, raf = null;
let canvasEl, worldGroup, decorGroup, markerGroup, seaMesh;
let sun, hemi;
let picker = new THREE.Raycaster();
let pointer = new THREE.Vector2();
let pickTargets = [];
let onSelectCb = null;
let selectedRing = null;
let lastPayload = null;
let hoverTime = 0;

// ---------- géométries partagées (créées une seule fois) ------------
let GEO = {}, MAT = {};

/** Hexagone « pointy-top » aux coins arrondis, extrudé avec un large biseau. */
function roundedHexShape(radius, round = 0.18) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 30);
    pts.push(new THREE.Vector2(radius * Math.cos(a), radius * Math.sin(a)));
  }
  const shape = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const cur = pts[i], next = pts[(i + 1) % 6], prev = pts[(i + 5) % 6];
    const toPrev = prev.clone().sub(cur).normalize().multiplyScalar(radius * round);
    const toNext = next.clone().sub(cur).normalize().multiplyScalar(radius * round);
    const a = cur.clone().add(toPrev);
    const b = cur.clone().add(toNext);
    if (i === 0) shape.moveTo(a.x, a.y); else shape.lineTo(a.x, a.y);
    shape.quadraticCurveTo(cur.x, cur.y, b.x, b.y);
  }
  shape.closePath();
  return shape;
}

// -----------------------------------------------------------------------------
// Bruit déterministe · sert à sculpter les volumes ET à peindre les textures.
// Sans lui, tout retombe sur des primitives : une sphère reste une sphère.
// -----------------------------------------------------------------------------
function hash3(x, y, z) {
  let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w);
}
function fbm(x, y, z, octaves = 3) {
  let a = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) { sum += a * vnoise(x * f, y * f, z * f); norm += a; a *= 0.5; f *= 2.1; }
  return sum / norm;
}

/** Déforme un maillage par le bruit : c'est ce qui transforme une sphère en
 *  volume organique. On recalcule les normales pour garder un ombrage lisse. */
function sculpt(geo, { amp = 0.18, freq = 1.6, seed = 0, squash = 1, radialBias = 0 } = {}) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm(v.x * freq + seed, v.y * freq + seed * 1.7, v.z * freq + seed * 2.3, 3) - 0.5;
    const len = v.length() || 1;
    const bias = 1 + radialBias * (v.y / len);
    v.multiplyScalar(1 + n * amp * 2 * bias);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Profil tourné : troncs et tentes naissent d'une courbe, pas d'un cylindre. */
function lathe(profile, segments = 20) {
  return new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), segments);
}

// -----------------------------------------------------------------------------
// Textures procédurales · aucun fichier externe (le CDN est inaccessible et un
// binaire dans le dépôt serait à télécharger à chaque visite).
// -----------------------------------------------------------------------------
function canvasTex(size, draw, { repeat = 1, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  return t;
}

/** Grain organique : des taches douces de deux teintes, jamais un aplat. */
function grainTexture(base, light, dark, { size = 192, blobs = 200, repeat = 1 } = {}) {
  return canvasTex(size, (g, S) => {
    g.fillStyle = base; g.fillRect(0, 0, S, S);
    for (let i = 0; i < blobs; i++) {
      const r = S * (0.02 + Math.random() * 0.09);
      const x = Math.random() * S, y = Math.random() * S;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, Math.random() < 0.5 ? light : dark);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = 0.3 + Math.random() * 0.38;
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // Moucheture fine : sans elle la surface redevient un aplat dès 3 mètres.
    for (let i = 0; i < S * 1.6; i++) {
      g.globalAlpha = 0.1 + Math.random() * 0.25;
      g.fillStyle = Math.random() < 0.5 ? light : dark;
      g.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    g.globalAlpha = 1;
  }, { repeat });
}

/** Relief en niveaux de gris : c'est lui qui donne l'accroche de la lumière. */
function bumpTexture({ size = 192, blobs = 240, repeat = 1, contrast = 0.5 } = {}) {
  return canvasTex(size, (g, S) => {
    g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < blobs; i++) {
      const r = S * (0.015 + Math.random() * 0.07);
      const x = Math.random() * S, y = Math.random() * S;
      const up = Math.random() < 0.5;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, up ? '#ffffff' : '#000000');
      grad.addColorStop(1, 'rgba(128,128,128,0)');
      g.globalAlpha = contrast * (0.5 + Math.random() * 0.9);
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    for (let i = 0; i < S * 2; i++) {
      g.globalAlpha = 0.25 + Math.random() * 0.4;
      g.fillStyle = Math.random() < 0.5 ? '#ffffff' : '#000000';
      g.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    g.globalAlpha = 1;
  }, { repeat, srgb: false });
}

/** Bandes de roche stratifiée pour les flancs d'île. */
function strataTexture(top, bottom) {
  return canvasTex(256, (g, S) => {
    const grad = g.createLinearGradient(0, 0, 0, S);
    grad.addColorStop(0, top); grad.addColorStop(1, bottom);
    g.fillStyle = grad; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 26; i++) {
      const y = Math.random() * S;
      g.globalAlpha = 0.06 + Math.random() * 0.12;
      g.fillStyle = Math.random() < 0.5 ? '#ffffff' : '#000000';
      g.fillRect(0, y, S, 1 + Math.random() * 5);
    }
    g.globalAlpha = 1;
  });
}

/** Tuiles de toit : des rangées décalées, pas une couleur unie. */
function roofTexture(base, dark) {
  return canvasTex(128, (g, S) => {
    g.fillStyle = base; g.fillRect(0, 0, S, S);
    const rows = 9, h = S / rows;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * (S / 16);
      for (let c = -1; c < 9; c++) {
        g.fillStyle = dark;
        g.globalAlpha = 0.25 + Math.random() * 0.35;
        g.beginPath();
        g.roundRect(off + c * (S / 8) + 1, r * h + 1, S / 8 - 2, h - 2, 3);
        g.fill();
      }
    }
    g.globalAlpha = 1;
  }, { repeat: 2 });
}

function buildSharedGeometries() {
  const shape = roundedHexShape(HEX - GAP, 0.2);
  GEO.tile = new THREE.ExtrudeGeometry(shape, {
    depth: TILE_H, bevelEnabled: true, bevelThickness: 0.09,
    bevelSize: 0.09, bevelSegments: 3, curveSegments: 10,
  });
  GEO.tile.rotateX(-Math.PI / 2);
  GEO.tile.computeBoundingBox();
  GEO.tileTop = -GEO.tile.boundingBox.min.y;

  GEO.plinth = new THREE.ExtrudeGeometry(roundedHexShape(HEX - GAP - 0.05, 0.22), {
    depth: 1.5, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.16,
    bevelSegments: 3, curveSegments: 10,
  });
  GEO.plinth.rotateX(-Math.PI / 2);

  // Le sol de la tuile : une nappe subdivisée puis bosselée. C'est elle qui
  // enlève l'aspect « plaque de plastique » d'un dessus parfaitement plat.
  GEO.ground = new THREE.CircleGeometry((HEX - GAP) * 0.855 - 0.015, 26, 0, Math.PI * 2);
  GEO.ground = subdivideCircle(GEO.ground);
  bumpGround(GEO.ground, 0.115);
  GEO.ground.rotateX(-Math.PI / 2);

  // --- végétation : trois houppiers sculptés, jamais la même silhouette ---
  GEO.canopy = [0, 1, 2].map((i) => sculpt(
    new THREE.IcosahedronGeometry(1, 3), { amp: 0.26, freq: 1.5, seed: 11 + i * 7, squash: 0.86, radialBias: 0.25 }));
  GEO.bush = sculpt(new THREE.IcosahedronGeometry(1, 2), { amp: 0.3, freq: 2.2, seed: 41, squash: 0.6 });
  // Tronc : un profil tourné qui s'évase au pied, comme un vrai arbre.
  GEO.trunk = lathe([[0.13, 0], [0.085, 0.12], [0.062, 0.45], [0.05, 0.8], [0.045, 1]], 14);

  // --- rochers : icosaèdres fortement sculptés, arêtes adoucies ---
  GEO.rock = [0, 1, 2].map((i) => sculpt(
    new THREE.IcosahedronGeometry(1, 3), { amp: 0.34, freq: 1.9, seed: 71 + i * 13, squash: 0.78 }));

  // --- bâti : corps aux arêtes cassées + toit à deux pans (pas un cône) ---
  const hs = new THREE.Shape();
  const w = 0.4, rr = 0.1;
  hs.moveTo(-w + rr, -w); hs.lineTo(w - rr, -w); hs.quadraticCurveTo(w, -w, w, -w + rr);
  hs.lineTo(w, w - rr); hs.quadraticCurveTo(w, w, w - rr, w);
  hs.lineTo(-w + rr, w); hs.quadraticCurveTo(-w, w, -w, w - rr);
  hs.lineTo(-w, -w + rr); hs.quadraticCurveTo(-w, -w, -w + rr, -w);
  GEO.house = new THREE.ExtrudeGeometry(hs, {
    depth: 0.5, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.045, bevelSegments: 3, curveSegments: 8,
  });
  GEO.house.rotateX(-Math.PI / 2);

  // Pavé de ville : plus haut que large, arêtes cassées. C'est le module de
  // base d'un tissu urbain dense — une maisonnette isolée ne fait pas une ville.
  const bs = new THREE.Shape();
  const bw = 0.5, bd = 0.34, br = 0.055;
  bs.moveTo(-bw + br, -bd); bs.lineTo(bw - br, -bd); bs.quadraticCurveTo(bw, -bd, bw, -bd + br);
  bs.lineTo(bw, bd - br); bs.quadraticCurveTo(bw, bd, bw - br, bd);
  bs.lineTo(-bw + br, bd); bs.quadraticCurveTo(-bw, bd, -bw, bd - br);
  bs.lineTo(-bw, -bd + br); bs.quadraticCurveTo(-bw, -bd, -bw + br, -bd);
  GEO.block = new THREE.ExtrudeGeometry(bs, {
    depth: 1, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.03, bevelSegments: 2, curveSegments: 5,
  });
  GEO.block.rotateX(-Math.PI / 2);
  // Corniche : la ligne d'ombre en haut d'un immeuble, qui l'empêche de finir
  // en cube nu.
  GEO.cornice = new THREE.ExtrudeGeometry(bs, {
    depth: 0.06, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, curveSegments: 5,
  });
  GEO.cornice.rotateX(-Math.PI / 2);
  GEO.tower = lathe([[0.17, 0], [0.16, 0.6], [0.19, 0.66], [0.185, 0.78], [0.13, 0.84], [0.1, 0.95], [0, 1]], 14);

  const gable = new THREE.Shape();
  gable.moveTo(-0.56, 0); gable.lineTo(0.56, 0);
  gable.lineTo(0.5, 0.08); gable.lineTo(0.06, 0.46);
  gable.quadraticCurveTo(0, 0.5, -0.06, 0.46);
  gable.lineTo(-0.5, 0.08); gable.closePath();
  GEO.roof = new THREE.ExtrudeGeometry(gable, {
    depth: 1.05, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2, curveSegments: 6,
  });
  GEO.roof.translate(0, 0, -0.525);
  GEO.chimney = lathe([[0.05, 0], [0.055, 0.2], [0.07, 0.24], [0.065, 0.28]], 10);

  // --- tente de campement : remplace les gélules pour figurer les troupes ---
  GEO.tent = lathe([[0, 0.42], [0.1, 0.34], [0.2, 0.17], [0.26, 0.02], [0.27, 0]], 14);
  GEO.pole = lathe([[0.022, 0], [0.018, 0.6], [0.015, 1]], 8);
  GEO.flag = new THREE.PlaneGeometry(0.36, 0.22, 6, 4);
  wave(GEO.flag);

  GEO.ring = new THREE.TorusGeometry(HEX - GAP - 0.02, 0.045, 10, 40);
  GEO.ring.rotateX(-Math.PI / 2);
}

/** Ajoute des anneaux internes à un disque pour pouvoir le bosseler. */
function subdivideCircle(circle) {
  const g = new THREE.CircleGeometry(1, 26);
  const src = circle.attributes.position;
  const R = Math.max(...Array.from({ length: src.count }, (_, i) => Math.hypot(src.getX(i), src.getY(i))));
  const rings = 4, seg = 26;
  const pos = [0, 0, 0], idx = [];
  for (let ri = 1; ri <= rings; ri++) {
    for (let si = 0; si < seg; si++) {
      const a = (si / seg) * Math.PI * 2;
      const rad = (ri / rings) * R;
      pos.push(Math.cos(a) * rad, Math.sin(a) * rad, 0);
    }
  }
  for (let si = 0; si < seg; si++) idx.push(0, 1 + si, 1 + ((si + 1) % seg));
  for (let ri = 1; ri < rings; ri++) {
    const a0 = 1 + (ri - 1) * seg, b0 = 1 + ri * seg;
    for (let si = 0; si < seg; si++) {
      const sn = (si + 1) % seg;
      idx.push(a0 + si, b0 + si, b0 + sn, a0 + si, b0 + sn, a0 + sn);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(idx);
  const uv = [];
  for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] / (R * 2) + 0.5, pos[i + 1] / (R * 2) + 0.5);
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.dispose();
  return out;
}

function bumpGround(geo, amp) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const d = Math.hypot(x, y);
    const falloff = Math.max(0, 1 - Math.pow(d / 0.9, 6));   // les bords restent nets
    pos.setZ(i, (fbm(x * 2.4, y * 2.4, 0.5, 3) - 0.5) * amp * 2 * falloff);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

function wave(plane) {
  const pos = plane.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, Math.sin((x + 0.18) * 9) * 0.035 * (x + 0.18));
  }
  pos.needsUpdate = true;
  plane.computeVertexNormals();
}

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness ?? 0.82, metalness: 0, flatShading: false, ...opts,
  });
}

const TERRAIN_3D = {
  prairie: '#7fbe47', foret: '#3f7f42', colline: '#bb9a55',
  montagne: '#8e8478', sable: '#eed79b',
};
const TERRAIN_LIGHT = {
  prairie: '#a8dc72', foret: '#63a35f', colline: '#d8bb7c',
  montagne: '#b0a698', sable: '#fff0c6',
};
const TERRAIN_DARK = {
  prairie: '#4f8f2f', foret: '#2a5c30', colline: '#8e7038',
  montagne: '#6a6258', sable: '#c9ab6a',
};

function buildSharedMaterials() {
  const groundBump = bumpTexture({ size: 256, blobs: 320, repeat: 5, contrast: 1 });

  MAT.terrain = {};
  MAT.ground = {};
  Object.keys(TERRAINS).forEach((k) => {
    MAT.terrain[k] = mat(TERRAIN_3D[k], { roughness: 0.92 });
    MAT.ground[k] = new THREE.MeshStandardMaterial({
      map: grainTexture(TERRAIN_3D[k], TERRAIN_LIGHT[k], TERRAIN_DARK[k], { size: 256, repeat: 3.4, blobs: 300 }),
      bumpMap: groundBump, bumpScale: 2.2, roughness: 0.96, metalness: 0,
    });
  });

  const strata = strataTexture('#8b6a47', '#4d3826');
  const strataSand = strataTexture('#d8b87e', '#8a6f45');
  MAT.flanc = new THREE.MeshStandardMaterial({ map: strata, bumpMap: groundBump, bumpScale: 2.4, roughness: 1 });
  MAT.flancSable = new THREE.MeshStandardMaterial({ map: strataSand, bumpMap: groundBump, bumpScale: 2.2, roughness: 1 });

  MAT.trunk = new THREE.MeshStandardMaterial({
    map: grainTexture('#7a5433', '#9a6f47', '#513824', { repeat: 1, blobs: 160 }),
    roughness: 1,
  });
  MAT.leaf = ['#5f9e50', '#4a8a45', '#78b45e'].map((c, i) => new THREE.MeshStandardMaterial({
    map: grainTexture(c, '#9ed07f', '#2f6636', { repeat: 1.4, blobs: 260 }),
    bumpMap: groundBump, bumpScale: 0.9,
    roughness: 0.95, metalness: 0,
  }));
  MAT.rock = new THREE.MeshStandardMaterial({
    map: grainTexture('#9a9287', '#c0b8ab', '#6b655c', { repeat: 1.3, blobs: 300 }),
    bumpMap: groundBump, bumpScale: 1.8, roughness: 1,
  });
  MAT.wall = new THREE.MeshStandardMaterial({
    map: grainTexture('#e3cfa8', '#f7ead0', '#b8a077', { repeat: 1.6, blobs: 220 }),
    bumpMap: bumpTexture({ size: 192, blobs: 220, repeat: 4, contrast: 0.8 }), bumpScale: 1.1, roughness: 0.88,
  });
  MAT.roofRed = new THREE.MeshStandardMaterial({ map: roofTexture('#a8412f', '#71291d'), roughness: 0.85 });
  MAT.roofBlue = new THREE.MeshStandardMaterial({ map: roofTexture('#41597f', '#2a3c56'), roughness: 0.85 });
  MAT.gold = mat('#e8b93f', { roughness: 0.42, metalness: 0.35 });
  MAT.pole = mat('#6b5641', { roughness: 1 });
  MAT.canvasTent = new THREE.MeshStandardMaterial({
    map: grainTexture('#e6dcc6', '#fffaf0', '#b7a988', { repeat: 1.2, blobs: 150 }), roughness: 0.95,
  });
  MAT.fog = mat('#63798c', { roughness: 1, transparent: true, opacity: 0.72 });
  MAT.fogSide = mat('#4a5c6e', { roughness: 1 });
  MAT.clan = {};
  CLANS.forEach((c) => { MAT.clan[c.key] = mat(c.color, { roughness: 0.6 }); });
  MAT.player = mat(PALETTE.joueur, { roughness: 0.5 });
  MAT.ringSel = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 });
}

function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d').createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, PALETTE.ciel_haut);
  g.addColorStop(0.62, '#bfe3ea');
  g.addColorStop(1, PALETTE.ciel_bas);
  const ctx = c.getContext('2d');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

// =============================================================================
// INITIALISATION
// =============================================================================
export function initWorld(canvas, { onSelect } = {}) {
  canvasEl = canvas;
  onSelectCb = onSelect || null;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(PALETTE.brume, 18, 46);

  camera = new THREE.PerspectiveCamera(38, 1, 0.5, 160);
  camera.position.set(0, 16, 19);

  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.minDistance = 8;
  controls.maxDistance = 46;
  controls.minPolarAngle = Math.PI * 0.14;
  controls.maxPolarAngle = Math.PI * 0.42;
  controls.enablePan = false;

  hemi = new THREE.HemisphereLight('#cfe4f5', '#5b4c3c', 0.78);
  scene.add(hemi);
  // Soleil bas et chaud : c'est ce qui donne les ombres longues des références.
  sun = new THREE.DirectionalLight('#ffd39a', 1.75);
  sun.position.set(-9, 13, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1536, 1536);
  sun.shadow.bias = -0.0012;
  const sc = sun.shadow.camera;
  sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 1; sc.far = 44;
  scene.add(sun, sun.target);

  buildSharedGeometries();
  buildSharedMaterials();

  worldGroup = new THREE.Group(); scene.add(worldGroup);
  decorGroup = new THREE.Group(); scene.add(decorGroup);
  markerGroup = new THREE.Group(); scene.add(markerGroup);

  seaMesh = new THREE.Mesh(
    new THREE.CircleGeometry(70, 64),
    new THREE.MeshStandardMaterial({ color: PALETTE.mer, roughness: 0.28, metalness: 0.05 }),
  );
  seaMesh.rotation.x = -Math.PI / 2;
  seaMesh.position.y = -1.55;
  seaMesh.receiveShadow = true;
  scene.add(seaMesh);

  selectedRing = new THREE.Mesh(GEO.ring, MAT.ringSel);
  selectedRing.visible = false;
  markerGroup.add(selectedRing);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();               // sans ça le contexte n'est jamais restauré
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    buildSharedGeometries(); buildSharedMaterials();
    lastSig = null;
    if (lastPayload) renderWorld(lastPayload, { force: true });
    if (!raf) raf = requestAnimationFrame(tick);
  }, false);

  clock = new THREE.Clock();
  resize();
  window.addEventListener('resize', resize);
  raf = requestAnimationFrame(tick);
}

function resize() {
  if (!renderer || !canvasEl) return;
  const w = canvasEl.clientWidth || 1;
  const h = canvasEl.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Sur un écran étroit on recule et on redresse la caméra, sinon l'archipel
  // déborde des deux côtés et on ne voit plus que trois tuiles.
  const narrow = w / h < 1.15;
  const dist = narrow ? 21 : 16;
  const polar = narrow ? 0.28 : 0.30;
  camera.updateProjectionMatrix();
  controls.minDistance = dist * 0.5;
  controls.maxDistance = dist * 1.9;
  if (!controls._userMoved) {
    const azim = controls.getAzimuthalAngle();
    camera.position.setFromSphericalCoords(dist, Math.PI * polar, azim);
    camera.position.add(controls.target);
    controls.update();
  }
  scene.fog.near = dist * 0.75;
  scene.fog.far = dist * 2.4;
}

// =============================================================================
// CONSTRUCTION DE LA CARTE
// =============================================================================
function clearGroup(g) {
  while (g.children.length) {
    const c = g.children.pop();
    if (c === selectedRing) continue;
    c.traverse?.((n) => { if (n.geometry && !Object.values(GEO).includes(n.geometry)) n.geometry.dispose(); });
  }
}

function rngFrom(q, r) {
  let h = ((q + 32) * 73856093) ^ ((r + 32) * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  return () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 4294967296; };
}

/**
 * @param {object} p { tiles, capitalProgress, selected }
 * capitalProgress : 0 → 1+ selon les heures du mois. C'est ce qui fait grandir
 * la ville de la capitale, exactement comme avant.
 */
/** Signature de ce qui est réellement dessiné : ni le temps ni les ressources
 *  n'y entrent, seulement la géographie et l'état des territoires. */
function worldSignature(p) {
  let sig = Math.round((p.capitalProgress ?? 0) * 40) + '|';
  const tiles = p.tiles || {};
  for (const k in tiles) {
    const t = tiles[k];
    sig += `${k}${t.revealed ? 1 : 0}${t.owner || '-'}${t.building || '-'}${t.garrison || 0}${t.neutralGarrison || 0};`;
  }
  return sig;
}

let lastSig = null;

/**
 * Reconstruire l'archipel à chaque rendu du tableau de bord coûtait plusieurs
 * centaines de maillages pour rien — au point de figer la page pendant une
 * série d'encodages. On ne rebâtit que si la carte a réellement changé.
 */
export function renderWorld(p, { force = false } = {}) {
  if (!scene) return;
  const sig = worldSignature(p);
  if (!force && sig === lastSig) {
    lastPayload = p;
    placeSelection(p.selected, p.tiles || {});
    return;
  }
  lastSig = sig;
  lastPayload = p;
  clearGroup(worldGroup);
  clearGroup(decorGroup);
  pickTargets = [];

  const tiles = p.tiles || {};
  const visible = Object.values(tiles).filter((t) => t.revealed
    || neighbors(t.q, t.r).some(([nq, nr]) => tiles[tileKey(nq, nr)]?.revealed));
  visible.forEach((t) => {
    const { x, z } = axialToWorld(t.q, t.r, HEX);
    const rng = rngFrom(t.q, t.r);
    const hidden = !t.revealed;

    // Chaque île flotte à sa propre hauteur : c'est ce léger désordre qui donne
    // le relief des références, sans avoir à modéliser du terrain.
    const bob = hidden ? -0.55 : (rng() - 0.5) * 0.34;

    const top = new THREE.Mesh(GEO.tile, hidden ? MAT.fog : MAT.terrain[t.terrain]);
    top.position.set(x, bob, z);
    top.castShadow = true; top.receiveShadow = true;
    top.userData.tile = { q: t.q, r: t.r };
    worldGroup.add(top);
    pickTargets.push(top);

    const plinth = new THREE.Mesh(GEO.plinth, hidden ? MAT.fogSide : (t.terrain === 'sable' ? MAT.flancSable : MAT.flanc));
    plinth.position.set(x, bob - 1.35, z);
    plinth.scale.set(0.94, 1, 0.94);
    plinth.receiveShadow = true;
    worldGroup.add(plinth);

    if (hidden) return;
    const y = bob + GEO.tileTop;
    decorateTile(t, x, y, z, rng, p);
  });

  placeSelection(p.selected, tiles);
}

function decorateTile(t, x, y, z, rng, p) {
  const put = (mesh, dx, dz, ry = 0) => {
    mesh.position.set(x + dx, y, z + dz);
    mesh.rotation.y = ry;
    mesh.castShadow = true; mesh.receiveShadow = true;
    decorGroup.add(mesh);
    return mesh;
  };

  // Nappe de sol bosselée posée sur la tuile : c'est elle qui porte la texture
  // et casse l'aplat parfait du dessus extrudé.
  const ground = new THREE.Mesh(GEO.ground, MAT.ground[t.terrain]);
  ground.position.set(x, y + 0.008, z);
  ground.rotation.y = rng() * Math.PI;
  ground.receiveShadow = true;
  decorGroup.add(ground);

  const pickCanopy = () => GEO.canopy[Math.floor(rng() * GEO.canopy.length)];
  const pickRock = () => GEO.rock[Math.floor(rng() * GEO.rock.length)];

  /** Un arbre = un tronc évasé + deux houppiers sculptés décalés. */
  const tree = (dx, dz, scale) => {
    const trunk = new THREE.Mesh(GEO.trunk, MAT.trunk);
    trunk.scale.set(scale * 1.05, scale * 2.5, scale * 1.05);
    put(trunk, dx, dz, rng() * Math.PI);
    const leafMat = MAT.leaf[Math.floor(rng() * MAT.leaf.length)];
    const c1 = new THREE.Mesh(pickCanopy(), leafMat);
    c1.scale.setScalar(scale * 1.15);
    put(c1, dx, dz, rng() * Math.PI).position.y += scale * 2.35;
    const c2 = new THREE.Mesh(pickCanopy(), leafMat);
    c2.scale.setScalar(scale * 0.78);
    put(c2, dx + (rng() - 0.5) * scale * 0.9, dz + (rng() - 0.5) * scale * 0.9, rng() * Math.PI)
      .position.y += scale * (2.9 + rng() * 0.4);
  };

  if (t.terrain === 'foret') {
    const n = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, d = rng() * 0.5;
      tree(Math.cos(a) * d, Math.sin(a) * d, 0.2 + rng() * 0.07);
    }
  } else if (t.terrain === 'montagne' || t.terrain === 'colline') {
    const n = t.terrain === 'montagne' ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, d = rng() * 0.38;
      const s = (t.terrain === 'montagne' ? 0.4 : 0.26) * (0.7 + rng() * 0.6);
      const rock = new THREE.Mesh(pickRock(), MAT.rock);
      rock.scale.set(s, s * (1.15 + rng() * 0.7), s * (0.85 + rng() * 0.3));
      put(rock, Math.cos(a) * d, Math.sin(a) * d, rng() * Math.PI).position.y += s * 0.45;
    }
    if (t.terrain === 'colline' && rng() < 0.6) tree((rng() - 0.5) * 0.8, (rng() - 0.5) * 0.8, 0.16);
  } else if (t.terrain === 'prairie') {
    if (rng() < 0.45) tree((rng() - 0.5) * 0.9, (rng() - 0.5) * 0.9, 0.17 + rng() * 0.05);
    const tufts = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < tufts; i++) {
      const s = 0.1 + rng() * 0.07;
      const bush = new THREE.Mesh(GEO.bush, MAT.leaf[1]);
      bush.scale.set(s * 1.7, s, s * 1.7);
      put(bush, (rng() - 0.5) * 1.1, (rng() - 0.5) * 1.1, rng() * Math.PI).position.y += s * 0.3;
    }
  } else if (t.terrain === 'sable' && rng() < 0.5) {
    const s = 0.13 + rng() * 0.08;
    const rock = new THREE.Mesh(pickRock(), MAT.rock);
    rock.scale.set(s * 1.4, s * 0.7, s * 1.2);
    put(rock, (rng() - 0.5) * 1, (rng() - 0.5) * 1, rng() * Math.PI).position.y += s * 0.25;
  }

  /** Une maison = corps enduit + toit à deux pans + cheminée. */
  const house = (dx, dz, h, ry, blue, k = 1) => {
    const body = new THREE.Mesh(GEO.house, MAT.wall);
    body.scale.set(k, h * 1.3, k);
    put(body, dx, dz, ry);
    const wallTop = 0.5 * h * 1.3;
    const roof = new THREE.Mesh(GEO.roof, blue ? MAT.roofBlue : MAT.roofRed);
    roof.scale.set(k * 0.82, k * 0.9, k * 0.8);
    put(roof, dx, dz, ry).position.y += wallTop;
    if (rng() < 0.55) {
      const ch = new THREE.Mesh(GEO.chimney, MAT.wall);
      ch.scale.setScalar(k);
      put(ch, dx + Math.cos(ry + 1) * 0.13 * k, dz + Math.sin(ry + 1) * 0.13 * k, ry)
        .position.y += wallTop + 0.2 * k;
    }
  };

  // --- la capitale grandit avec les heures encodées ---
  if (t.capital) {
    const progress = Math.max(0, Math.min(1.6, p.capitalProgress ?? 0));
    town(x, y, z, rng, progress, put);
  } else if (t.building) {
    if (t.building === 'rempart') {
      // Le rempart cerne la tuile plutôt que de poser un cube au centre.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.5;
        const seg = new THREE.Mesh(GEO.rock, MAT.rock);
        seg.scale.set(0.3, 0.26, 0.16);
        put(seg, Math.cos(a) * 0.68, Math.sin(a) * 0.68, a).position.y += 0.16;
      }
    } else {
      house(0, 0, t.building === 'caserne' ? 0.55 : 0.45, rng() * Math.PI, t.building === 'caserne', 0.72);
    }
  }

  // --- bannière du propriétaire ---
  const ownerMat = t.owner === 'joueur' ? MAT.player : (MAT.clan[t.owner] || null);
  if (ownerMat) {
    const pole = new THREE.Mesh(GEO.pole, MAT.pole);
    pole.scale.set(1, 0.95, 1);
    put(pole, 0.55, 0.45).position.y += 0.02;
    const flag = new THREE.Mesh(GEO.flag, ownerMat);
    flag.material.side = THREE.DoubleSide;
    put(flag, 0.72, 0.45, -0.6).position.y += 0.78;
  }

  // --- campement : une tente par troupe, plafonné pour rester lisible ---
  const troops = t.owner ? (t.garrison || 0) : (t.neutralGarrison || 0);
  const shown = Math.min(5, troops);
  for (let i = 0; i < shown; i++) {
    const a = (i / 5) * Math.PI * 2 + 1.1;
    const tent = new THREE.Mesh(GEO.tent, t.owner ? MAT.canvasTent : MAT.canvasTent);
    const s = 0.3 + (i % 2) * 0.06;
    tent.scale.setScalar(s);
    put(tent, Math.cos(a) * 0.66, Math.sin(a) * 0.66 + 0.06, rng() * Math.PI);
  }
}

/**
 * Un tissu urbain, pas un lotissement : des pavés serrés le long de rues, des
 * hauteurs très variées, un beffroi. C'est la variation de hauteur et la densité
 * qui font lire « ville » à distance — pas le nombre de petites maisons.
 */
function town(x, y, z, rng, progress, put) {
  const R = 0.68;                       // rayon bâtissable, marge de bord comprise
  const square = new THREE.Mesh(GEO.ground, MAT.ground.colline);
  square.scale.set(0.96, 1, 0.96);
  square.position.set(x, y + 0.03, z);
  square.receiveShadow = true;
  decorGroup.add(square);

  // Implantation sur anneaux, avec un pas d'arc calculé à partir de l'emprise
  // réelle des blocs. Sans ça les façades s'interpénètrent et la ville devient
  // un tas de gravats plutôt qu'un tissu urbain.
  const rings = 3;
  const K_MIN = 0.26, K_MAX = 0.36;
  const footprint = 0.5 * 2 * K_MAX * 1.12;      // largeur du bloc + une ruelle
  const density = 0.72 + progress * 0.25;
  let placed = 0;

  for (let ring = 1; ring <= rings; ring++) {
    const rad = (ring / rings) * (R - footprint * 0.55);
    const slots = Math.max(4, Math.floor((2 * Math.PI * rad) / footprint));
    for (let i = 0; i < slots; i++) {
      if (rng() > density) continue;
      const a = (i / slots) * Math.PI * 2 + ring * 0.42;
      const bx = Math.cos(a) * rad, bz = Math.sin(a) * rad;
      // Le centre-ville est haut, les faubourgs s'écrasent : c'est cette
      // silhouette décroissante qui fait lire « ville » de loin.
      const falloff = 1 - (rad / R) * 0.3;
      const h = (0.34 + rng() * 0.34) * falloff * (0.9 + progress * 0.5);
      const k = K_MIN + rng() * (K_MAX - K_MIN);
      const ry = a + Math.PI / 2;                 // les façades suivent la rue

      const body = new THREE.Mesh(GEO.block, MAT.wall);
      body.scale.set(k, h, k * (0.9 + rng() * 0.3));
      put(body, bx, bz, ry);

      if (rng() < 0.55) {
        const roof = new THREE.Mesh(GEO.roof, rng() < 0.35 ? MAT.roofBlue : MAT.roofRed);
        roof.scale.set(k * 0.94, k * 0.85, k * 0.64);
        put(roof, bx, bz, ry).position.y += h;
      } else {
        const c = new THREE.Mesh(GEO.cornice, MAT.wall);
        c.scale.set(k * 1.06, 1, k * 1.04);
        put(c, bx, bz, ry).position.y += h - 0.02;
      }
      placed++;
    }
  }

  // Beffroi central : le repère qui donne l'échelle à tout le reste.
  const th = 0.8 + progress * 0.5;
  const tower = new THREE.Mesh(GEO.tower, MAT.wall);
  tower.scale.set(0.4, th, 0.4);
  put(tower, 0, 0, rng() * Math.PI);
  const belfry = new THREE.Mesh(GEO.roof, MAT.roofBlue);
  belfry.scale.set(0.22, 0.26, 0.22);
  put(belfry, 0, 0, 0.4).position.y += th * 0.93;

  // Donjon doré : la garantie mensuelle atteinte se voit de loin.
  if (progress >= 1) {
    const keep = new THREE.Mesh(GEO.tower, MAT.gold);
    keep.scale.set(0.4, 0.85, 0.4);
    put(keep, -0.3, 0.3, 0);
  }
  return placed;
}

function placeSelection(sel, tiles) {
  if (!selectedRing) return;
  if (!sel || !tiles[tileKey(sel.q, sel.r)]) { selectedRing.visible = false; return; }
  const { x, z } = axialToWorld(sel.q, sel.r, HEX);
  selectedRing.position.set(x, GEO.tileTop + 0.05, z);
  selectedRing.visible = true;
}

export function setSelected(sel) {
  if (lastPayload) { lastPayload.selected = sel; placeSelection(sel, lastPayload.tiles || {}); }
}

// =============================================================================
// INTERACTION
// =============================================================================
function onPointerDown(e) {
  if (!camera || !pickTargets.length) return;
  controls._userMoved = true;
  const rect = canvasEl.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  const start = { x: e.clientX, y: e.clientY };
  const up = (ev) => {
    canvasEl.removeEventListener('pointerup', up);
    // Un glissement de caméra ne doit pas sélectionner : on ne valide le clic
    // que si le doigt n'a quasiment pas bougé.
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 8) return;
    picker.setFromCamera(pointer, camera);
    const hit = picker.intersectObjects(pickTargets, false)[0];
    if (hit && hit.object.userData.tile && onSelectCb) onSelectCb(hit.object.userData.tile);
  };
  canvasEl.addEventListener('pointerup', up);
}

/** Sélection par coordonnées, pour les tests et le clavier. */
export function selectByAxial(q, r) {
  if (onSelectCb) onSelectCb({ q, r });
}

// =============================================================================
// BOUCLE
// =============================================================================
function tick() {
  raf = requestAnimationFrame(tick);
  const dt = clock.getDelta();
  hoverTime += dt;
  if (selectedRing && selectedRing.visible) {
    selectedRing.material.opacity = 0.55 + Math.sin(hoverTime * 3.4) * 0.35;
    selectedRing.scale.setScalar(1 + Math.sin(hoverTime * 3.4) * 0.02);
  }
  // Respiration très lente des îles : ça suffit à rendre la scène vivante sans
  // donner le mal de mer ni coûter en batterie.
  if (worldGroup) worldGroup.position.y = Math.sin(hoverTime * 0.5) * 0.03;
  controls.update();
  renderer.render(scene, camera);
}

export function disposeWorld() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  window.removeEventListener('resize', resize);
  if (canvasEl) canvasEl.removeEventListener('pointerdown', onPointerDown);
  renderer?.dispose();
  renderer = scene = camera = controls = null;
}

/** Rapproche la caméra d'un territoire. Sert au double-appui dans le jeu, et
 *  à juger le bâti pendant le développement. */
export function focusTile(q, r, distance = 5.5) {
  if (!controls || !camera) return;
  const { x, z } = axialToWorld(q, r, HEX);
  controls.target.set(x, GEO.tileTop, z);
  const azim = controls.getAzimuthalAngle();
  camera.position.setFromSphericalCoords(distance, Math.PI * 0.34, azim);
  camera.position.add(controls.target);
  controls._userMoved = true;
  controls.update();
}

/**
 * Volumes réellement posés autour d'un point, en coordonnées monde.
 * Écrit après une séance passée à deviner pourquoi le bâti semblait plat :
 * la géométrie était juste, seules les proportions étaient trop basses. Mesurer
 * a réglé en un appel ce que trois hypothèses n'avaient pas trouvé.
 */
export function debugMeshesAt(x = 0, z = 0, radius = 1) {
  const out = [];
  const box = new THREE.Box3();
  decorGroup.children.forEach((m) => {
    if (Math.hypot(m.position.x - x, m.position.z - z) > radius) return;
    box.setFromObject(m);
    out.push({
      geo: Object.entries(GEO).find(([, g]) => g === m.geometry || (Array.isArray(g) && g.includes(m.geometry)))?.[0] || '?',
      y: +m.position.y.toFixed(3),
      size: [+(box.max.x - box.min.x).toFixed(3), +(box.max.y - box.min.y).toFixed(3), +(box.max.z - box.min.z).toFixed(3)],
      yRange: [+box.min.y.toFixed(3), +box.max.y.toFixed(3)],
    });
  });
  return out;
}

export function isReady() { return !!renderer; }

/**
 * Échantillonne le centre de l'image juste après un rendu. Sans le `render()`
 * qui précède, `readPixels` renvoie un tampon déjà effacé par le compositeur —
 * on croirait la scène vide alors qu'elle est parfaitement dessinée.
 * Sert aux tests visuels et au diagnostic d'un canvas noir.
 */
export function samplePixels(size = 48) {
  if (!renderer) return null;
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(size * size * 4);
  gl.readPixels(Math.max(0, (w - size) >> 1), Math.max(0, (h - size) >> 1), size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const uniq = new Set();
  for (let i = 0; i < px.length; i += 4) uniq.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
  return { tints: uniq.size, sample: [...uniq].slice(0, 4) };
}
