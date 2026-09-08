// =============================================================================
// 🏝️  LES MARCHES DE NESSY · rendu 3D de l'archipel
// -----------------------------------------------------------------------------
// Direction artistique : matières réelles, éclairage par image.
//
// Le rendu procédural (bruit + textures peintes dans un canvas) plafonnait au
// « stylisé » : on ne fabrique pas de la matière crédible avec des taches
// dessinées. Les matières viennent donc de vraies textures embarquées dans
// assets/textures (voir assets/LICENCES.md), et l'éclairage d'une carte HDR
// équirectangulaire passée au PMREM — c'est elle qui donne les reflets, les
// dégradés d'ambiance et le poids des ombres, bien plus qu'une lampe de plus.
//
// Les fonctions procédurales sont conservées : elles servent de repli quand un
// fichier ne se charge pas, pour que la scène ne soit jamais nue.
//
// Ce module ne connaît PAS les règles du jeu : on lui passe une carte de tuiles,
// il la dessine et signale la tuile touchée. Toute la logique vit dans game.js.
// =============================================================================
import * as THREE from './vendor/three/three.module.js?v=2026-09-08-01';
import { OrbitControls } from './vendor/three/OrbitControls.js?v=2026-09-08-01';
import { RGBELoader } from './vendor/three/RGBELoader.js?v=2026-09-08-01';
import { GLTFLoader } from './vendor/three/GLTFLoader.js?v=2026-09-08-01';
import { axialToWorld, TERRAINS, CLANS, neighbors, tileKey } from './game.js?v=2026-09-08-01';

const HEX = 1.0;                 // rayon d'un hexagone
const GAP = 0.13;                // interstice : c'est lui qui fait « îles séparées »
const TILE_H = 0.42;

// Palette : des verts un peu délavés et des sables chauds, comme une maquette
// peinte à la main. Les couleurs pures « écran » cassaient l'effet cartoon.
const PALETTE = {
  ciel_haut: '#8fd3e8', ciel_bas: '#ffe6c4',
  mer: '#2e7d99', mer_profonde: '#1b4f66',
  brume: '#8fb3c9',
  flanc: '#8a6a4a',           // la roche sous la tuile
  flanc_sable: '#c2a06f',
  joueur: '#f2c14e',
  neutre: '#9aa7b0',
};

let renderer, scene, camera, controls, clock, raf = null;
let canvasEl, worldGroup, decorGroup, markerGroup, armyGroup, reachGroup, marqueGroup, seaMesh;
let seaWaves = null;
let envReady = false;
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

  // Le sol de la tuile : une nappe subdivisée puis sculptée. C'est elle qui
  // porte le relief — sans quoi la carte reste un plateau de jeu en plastique.
  const groundBase = subdivideCircle(new THREE.CircleGeometry((HEX - GAP) * 0.855 - 0.015, 26));
  GEO.ground = {};
  // Chaque terrain a son propre profil d'élévation. Une montagne qui n'est
  // qu'un caillou posé sur une plaque plate ne lira jamais comme une montagne.
  RELIEF.forEach(({ key, amp, peak, ridge }) => {
    const g = groundBase.clone();
    reliefGround(g, amp, peak, ridge, key);
    g.rotateX(-Math.PI / 2);
    GEO.ground[key] = g;
  });
  groundBase.dispose();

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

  // Pion d'armée : un fanion sur socle, lisible de loin même à petite taille.
  GEO.armyBase = new THREE.CylinderGeometry(0.3, 0.34, 0.1, 18);
  GEO.armyMast = lathe([[0.035, 0], [0.03, 0.5], [0.025, 0.62]], 10);
  GEO.armyFlag = new THREE.PlaneGeometry(0.42, 0.26, 8, 4);
  wave(GEO.armyFlag);
  // Disque de portée posé à plat sur la tuile.
  GEO.reach = new THREE.CircleGeometry((HEX - GAP) * 0.8, 24);
  GEO.reach.rotateX(-Math.PI / 2);
  // Deux lames croisées : le signe universel « ici on s'est battu ». Une simple
  // pastille de couleur se confondait avec les cases à portée.
  GEO.lame = new THREE.BoxGeometry(0.075, 0.075, 0.62);

  // Cible de sélection : un hexagone plat, invisible, posé sur la tuile.
  GEO.pick = new THREE.CircleGeometry(HEX * 0.92, 6);
  GEO.pick.rotateX(-Math.PI / 2);
  GEO.pick.rotateY(Math.PI / 6);

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

// amp : bosses de surface · peak : hauteur du sommet · ridge : rugosité des arêtes
const RELIEF = [
  { key: 'prairie',  amp: 0.07, peak: 0.00, ridge: 0.6 },
  { key: 'sable',    amp: 0.05, peak: 0.00, ridge: 0.4 },
  { key: 'foret',    amp: 0.11, peak: 0.10, ridge: 0.8 },
  { key: 'colline',  amp: 0.14, peak: 0.42, ridge: 1.0 },
  { key: 'montagne', amp: 0.18, peak: 1.15, ridge: 1.6 },
];

/**
 * Sculpte la nappe : un dôme central dont la hauteur dépend du terrain, plus
 * du bruit. Les bords restent au niveau de la tuile pour que les îles se
 * raccordent proprement.
 */
function reliefGround(geo, amp, peak, ridge, seedKey) {
  const seed = hashStr(seedKey) % 1000;
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const d = Math.hypot(x, y);
    const bord = Math.max(0, 1 - Math.pow(d / 0.78, 5));      // s'annule sur le pourtour
    const dome = peak * Math.pow(Math.max(0, 1 - d / 0.8), 1.7);
    const bruit = (fbm(x * 3 + seed, y * 3 + seed, 0.5, 4) - 0.5) * 2;
    pos.setZ(i, (dome + bruit * amp * ridge) * bord);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/**
 * Hauteur du relief en un point local de la tuile. Reprend exactement la
 * formule de reliefGround : sans ça, les arbres flottent ou s'enfoncent.
 */
export function reliefHeight(terrain, dx, dz) {
  const r = RELIEF.find((x) => x.key === terrain) || RELIEF[0];
  const seed = hashStr(r.key) % 1000;
  const d = Math.hypot(dx, dz);
  const bord = Math.max(0, 1 - Math.pow(d / 0.78, 5));
  const dome = r.peak * Math.pow(Math.max(0, 1 - d / 0.8), 1.7);
  const bruit = (fbm(dx * 3 + seed, dz * 3 + seed, 0.5, 4) - 0.5) * 2;
  return (dome + bruit * r.amp * r.ridge) * bord;
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
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

const TEX_BASE = './assets/textures/';
const texLoader = new THREE.TextureLoader();
let texturesReady = false;

/**
 * Charge une texture et la configure pour être répétée sur une surface.
 * En cas d'échec (fichier absent, réseau coupé) on ne casse rien : la matière
 * garde la texture procédurale posée à la construction.
 */
function loadTex(file, { repeat = 1, srgb = false } = {}) {
  const t = texLoader.load(TEX_BASE + file, undefined, undefined, (e) => {
    console.warn('[kopek] texture non chargée', file, e);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Remplace les matières procédurales par les vraies textures. Appelé après la
 * construction, de façon asynchrone : la scène s'affiche tout de suite avec le
 * rendu de repli, puis se « densifie » quand les fichiers arrivent.
 */
function applyRealTextures() {
  if (texturesReady) return;
  texturesReady = true;

  // Un matcap encode matière ET éclairage dans une image. Teinté par matière,
  // il donne à une géométrie simple l'aspect d'un rendu de studio — c'est
  // exactement ce qui manquait pour sortir de l'aplat « low poly ».
  const mcDoux = loadTex('matcap_doux.jpg', { srgb: true });
  const mcDur = loadTex('matcap_dur.jpg', { srgb: true });
  mcDoux.wrapS = mcDoux.wrapT = THREE.ClampToEdgeWrapping; mcDoux.repeat.set(1, 1);
  mcDur.wrapS = mcDur.wrapT = THREE.ClampToEdgeWrapping; mcDur.repeat.set(1, 1);
  MATCAP.doux = mcDoux; MATCAP.dur = mcDur;

  const rocheRelief = loadTex('roche_relief.jpg', { repeat: 3 });
  // La même image servie deux fois : en relief (linéaire) et en couleur (sRGB).
  // Réutiliser la brique pour la pierre donnait des rochers en maçonnerie.
  const rocheCouleur = loadTex('roche_relief.jpg', { repeat: 2.4, srgb: true });
  const falaiseCouleur = loadTex('roche_relief.jpg', { repeat: 1.6, srgb: true });

  // Sol : une seule photo d'herbe, teintée par terrain. Une texture par type
  // aurait quadruplé le poids pour un gain nul à cette distance.
  const herbe = loadTex('sol_herbe.jpg', { repeat: 2.2, srgb: true });
  Object.keys(TERRAINS).forEach((k) => {
    const m = MAT.ground[k];
    m.map = herbe;
    m.color = new THREE.Color(GROUND_TINT[k]);
    m.bumpMap = rocheRelief;
    m.bumpScale = k === 'montagne' || k === 'colline' ? 1.4 : 0.8;
    m.roughness = 0.95;
    m.needsUpdate = true;
  });

  const murCouleur = loadTex('mur_couleur.jpg', { repeat: 1.4, srgb: true });
  const murRelief = loadTex('mur_relief.jpg', { repeat: 1.4 });
  const murRugosite = loadTex('mur_rugosite.jpg', { repeat: 1.4 });

  [[MAT.flanc, '#a97f52'], [MAT.flancSable, '#dcbe8c']].forEach(([m, c]) => {
    m.map = falaiseCouleur; m.bumpMap = rocheRelief; m.bumpScale = 2.6;
    m.color = new THREE.Color(c); m.roughness = 1; m.needsUpdate = true;
  });

  const boisRelief = loadTex('bois_relief.jpg', { repeat: 1 });

  // Le feuillage garde sa teinte propre mais gagne le relief de la roche :
  // c'est ce qui casse l'aspect « boule de plastique ».
  // Le décor reçoit le matcap et sa carte de relief. Le sol reste en PBR pour
  // continuer à recevoir les ombres portées : un matcap ne les reçoit pas.
  const poser = (m, mc, bump, scale) => {
    m.matcap = mc;
    if (bump) { m.bumpMap = bump; m.bumpScale = scale; }
    m.needsUpdate = true;
  };
  poser(MAT.rock, mcDur, rocheRelief, 1.4);
  poser(MAT.wall, mcDoux, murRelief, 0.5);
  poser(MAT.roofRed, mcDoux, murRelief, 0.4);
  poser(MAT.roofBlue, mcDoux, murRelief, 0.4);
  poser(MAT.trunk, mcDur, boisRelief, 0.6);
  poser(MAT.pole, mcDur, boisRelief, 0.5);
  poser(MAT.gold, mcDoux, null, 0);
  poser(MAT.canvasTent, mcDoux, null, 0);
  MAT.leaf.forEach((m) => poser(m, mcDoux, rocheRelief, 1.2));

  if (seaMesh) {
    const vagues = loadTex('eau_normales.jpg', { repeat: 14 });
    seaMesh.material.normalMap = vagues;
    seaMesh.material.normalScale = new THREE.Vector2(0.55, 0.55);
    seaMesh.material.roughness = 0.12;
    seaMesh.material.metalness = 0.05;
    seaMesh.material.needsUpdate = true;
    seaWaves = vagues;
  }
}

/** L'herbe est monochrome : la teinte fait la différence entre les terrains. */
const GROUND_TINT = {
  prairie: '#7cb54a', foret: '#4a7d3c', colline: '#9c8452',
  montagne: '#7d766a', sable: '#d9bb7c',
};

/**
 * Éclairage par image. Sans lui, une matière PBR reste plate quel que soit le
 * nombre de lampes : c'est l'environnement qui porte les reflets et l'ambiance.
 */
function loadEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  new RGBELoader().load('./assets/env/ciel_venise_1k.hdr', (hdr) => {
    const env = pmrem.fromEquirectangular(hdr).texture;
    scene.environment = env;
    hdr.dispose();
    pmrem.dispose();
    envReady = true;
  }, undefined, (e) => {
    console.warn('[kopek] environnement HDR non chargé, éclairage de repli', e);
    pmrem.dispose();
  });
}

const MATCAP = {};

/**
 * Matière de décor. On la crée d'emblée en MeshMatcapMaterial : un matcap ne
 * s'ajoute pas après coup sur une matière PBR, le shader ne le lirait pas.
 * Tant que l'image n'est pas chargée, la teinte seule fait l'affaire.
 */
function matcapMat(tint, opts = {}) {
  return new THREE.MeshMatcapMaterial({ color: new THREE.Color(tint), ...opts });
}

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

  MAT.trunk = matcapMat('#7d5a38');
  MAT.leaf = ['#6fae52', '#4f8f44', '#84c266'].map((c) => matcapMat(c));
  MAT.rock = matcapMat('#a09a90');
  MAT.wall = matcapMat('#e6d9bd');
  MAT.roofRed = matcapMat('#a8412f');
  MAT.roofBlue = matcapMat('#41597f');
  MAT.gold = matcapMat('#e8b93f');
  MAT.pole = matcapMat('#6b5641');
  MAT.canvasTent = matcapMat('#e6dcc6');
  MAT.fog = mat('#63798c', { roughness: 1, transparent: true, opacity: 0.72 });
  MAT.fogSide = mat('#4a5c6e', { roughness: 1 });
  MAT.clan = {};
  CLANS.forEach((c) => { MAT.clan[c.key] = mat(c.color, { roughness: 0.6 }); });
  MAT.player = mat(PALETTE.joueur, { roughness: 0.5 });
  MAT.pick = new THREE.MeshBasicMaterial({ visible: false });
  MAT.ringSel = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 });
  // Portée : bleu pour un déplacement, rouge pour un assaut. La couleur dit
  // ce qui va se passer avant qu'on touche.
  MAT.reachMove = new THREE.MeshBasicMaterial({ color: '#5eb0ff', transparent: true, opacity: 0.35, depthWrite: false });
  MAT.reachAttack = new THREE.MeshBasicMaterial({ color: '#ff5a5a', transparent: true, opacity: 0.4, depthWrite: false });
  MAT.marque = {
    victoire: new THREE.MeshBasicMaterial({ color: '#6ee7a8', transparent: true, opacity: 0.95 }),
    defense:  new THREE.MeshBasicMaterial({ color: '#6ee7a8', transparent: true, opacity: 0.95 }),
    defaite:  new THREE.MeshBasicMaterial({ color: '#ff7b7b', transparent: true, opacity: 0.95 }),
    perte:    new THREE.MeshBasicMaterial({ color: '#ff7b7b', transparent: true, opacity: 0.95 }),
  };
  MAT.armyBase = mat('#3d3a35', { roughness: 0.9 });
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
  renderer.toneMappingExposure = 0.78;

  scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(PALETTE.brume, 18, 46);

  camera = new THREE.PerspectiveCamera(36, 1, 0.5, 260);
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

  hemi = new THREE.HemisphereLight('#c3d8ea', '#4d4438', 0.42);
  scene.add(hemi);
  // Soleil bas et chaud : c'est ce qui donne les ombres longues des références.
  sun = new THREE.DirectionalLight('#ffeacd', 1.45);
  sun.position.set(-9, 13, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1536, 1536);
  sun.shadow.bias = -0.0012;
  const sc = sun.shadow.camera;
  sc.left = -26; sc.right = 26; sc.top = 26; sc.bottom = -26; sc.near = 1; sc.far = 80;
  scene.add(sun, sun.target);

  buildSharedGeometries();
  buildSharedMaterials();
  loadEnvironment();
  applyRealTextures();
  // Les modèles arrivent après coup : on force un redessin à leur arrivée,
  // sinon la carte resterait vide jusqu'au prochain changement d'état.
  loadModels(() => { lastSig = null; if (lastPayload) renderWorld(lastPayload, { force: true }); });

  worldGroup = new THREE.Group(); scene.add(worldGroup);
  decorGroup = new THREE.Group(); scene.add(decorGroup);
  markerGroup = new THREE.Group(); scene.add(markerGroup);
  marqueGroup = new THREE.Group(); scene.add(marqueGroup);
  armyGroup = new THREE.Group(); scene.add(armyGroup);
  reachGroup = new THREE.Group(); scene.add(reachGroup);

  seaMesh = new THREE.Mesh(
    new THREE.CircleGeometry(90, 96),
    new THREE.MeshStandardMaterial({ color: PALETTE.mer, roughness: 0.15, metalness: 0.05 }),
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
    texturesReady = false; applyRealTextures(); loadEnvironment();
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
  const dist = narrow ? 38 : 31;
  const polar = narrow ? 0.26 : 0.28;
  camera.updateProjectionMatrix();
  controls.minDistance = dist * 0.22;
  controls.maxDistance = dist * 1.6;
  if (!controls._userMoved) {
    const azim = controls.getAzimuthalAngle();
    camera.position.setFromSphericalCoords(dist, Math.PI * polar, azim);
    camera.position.add(controls.target);
    controls.update();
  }
  scene.fog.near = dist * 0.55;
  scene.fog.far = dist * 2.1;
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
  (p.armies || []).forEach((a) => { sig += `${a.id}${a.q},${a.r}:${a.str}:${a.mp};`; });
  sig += '|' + (p.reach ? [...p.reach.keys()].join(',') : '') + '|';
  (p.marques || []).forEach((m) => { sig += `${m.q},${m.r}:${m.kind};`; });
  sig += '|';
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
  // Tout le monde est dessiné. Ce qui n'est pas exploré l'est en sourdine :
  // on voit le relief du pays et les bannières adverses, mais pas le détail.
  // Cacher 180 territoires sur 217 rendait la carte incompréhensible et
  // donnait l'impression d'un monde minuscule.
  const visible = Object.values(tiles);
  const socles = [];
  visible.forEach((t) => {
    const { x, z } = axialToWorld(t.q, t.r, HEX);
    const rng = rngFrom(t.q, t.r);
    const hidden = !t.revealed;

    socles.push({
      name: tileModel(t, rng), x, z,
      y: hidden ? -0.05 : 0, ry: rng() * Math.PI * 2, fog: hidden,
    });

    // La sélection tape sur une cible plate invisible : viser les maillages du
    // décor rendrait le toucher imprécis selon ce qui se trouve dessus.
    const cible = new THREE.Mesh(GEO.pick, MAT.pick);
    cible.position.set(x, 0.06, z);
    cible.userData.tile = { q: t.q, r: t.r };
    worldGroup.add(cible);
    pickTargets.push(cible);

    if (hidden) {
      // On montre quand même la bannière d'un siège de clan repéré : c'est ce
      // qui donne au joueur une raison d'aller voir.
      if (t.owner && t.owner !== 'joueur' && t.seat) {
        const banniere = inst(`flag_${colorOf(t.owner)}`, 0.6, 0);
        if (banniere) { banniere.position.set(x + 0.5, -0.05, z + 0.44); decorGroup.add(banniere); }
      }
      return;
    }
    decorateTile(t, x, 0, z, rng, p);
  });
  drawTilesInstanced(socles);

  placeSelection(p.selected, tiles);
  drawArmies(p);
  drawMarques(p);
  drawReach(p);
}

/**
 * Les armées sont dessinées dans leur propre groupe : elles bougent souvent,
 * il serait absurde de reconstruire tout l'archipel à chaque pas.
 */
function drawArmies(p) {
  clearGroup(armyGroup);
  const tiles = p.tiles || {};
  (p.armies || []).forEach((a) => {
    const t = tiles[tileKey(a.q, a.r)];
    if (!t) return;
    // Une colonne ennemie doit se voir arriver, y compris dans la brume : la
    // cacher jusqu'à ce qu'elle frappe donnait un monde qui semble mort, puis
    // un territoire perdu sans prévenir. Dans la brume, on la pose plus bas et
    // sans jetons : on voit qu'elle vient, pas encore sa force exacte.
    const brume = !t.revealed;
    const { x, z } = axialToWorld(a.q, a.r, HEX);
    const y = brume ? 0.06 : 0.14;
    const mat = a.owner === 'joueur' ? MAT.player : (MAT.clan[a.owner] || MAT.player);

    const base = new THREE.Mesh(GEO.armyBase, MAT.armyBase);
    base.position.set(x, y + 0.05, z);
    base.castShadow = true;
    armyGroup.add(base);

    const mast = new THREE.Mesh(GEO.armyMast, MAT.pole);
    mast.position.set(x, y + 0.1, z);
    mast.castShadow = true;
    armyGroup.add(mast);

    const flag = new THREE.Mesh(GEO.armyFlag, mat);
    flag.material.side = THREE.DoubleSide;
    flag.position.set(x + 0.2, y + 0.58, z);
    flag.rotation.y = -0.5;
    flag.castShadow = true;
    armyGroup.add(flag);

    // Un jeton par troupe, en arc devant le fanion : la force se lit d'un coup.
    const jetons = brume ? 0 : Math.min(6, a.str);
    for (let i = 0; i < jetons; i++) {
      const ang = -0.9 + (i / 5) * 1.8;
      const pion = new THREE.Mesh(GEO.troop, mat);
      pion.position.set(x + Math.sin(ang) * 0.26, y + 0.16, z + Math.cos(ang) * 0.26 - 0.05);
      pion.castShadow = true;
      armyGroup.add(pion);
    }
  });
}

/**
 * Les faits de guerre récents : deux lames croisées plantées sur la case. Elles
 * répondent à « on ne voit pas d'activité » — un combat qui s'est réglé pendant
 * l'absence laisse enfin quelque chose à voir sur la carte.
 */
function drawMarques(p) {
  clearGroup(marqueGroup);
  (p.marques || []).forEach((m) => {
    const { x, z } = axialToWorld(m.q, m.r, HEX);
    const mat = MAT.marque[m.kind] || MAT.marque.defaite;
    [0.7, -0.7].forEach((rot) => {
      const lame = new THREE.Mesh(GEO.lame, mat);
      lame.position.set(x, 0.62, z);
      lame.rotation.set(0.45, 0, rot);
      lame.castShadow = true;
      marqueGroup.add(lame);
    });
  });
}

/** Cases atteignables par l'armée sélectionnée. */
function drawReach(p) {
  clearGroup(reachGroup);
  const cells = p.reach;
  if (!cells) return;
  cells.forEach((info) => {
    const { x, z } = axialToWorld(info.q, info.r, HEX);
    const disc = new THREE.Mesh(GEO.reach, info.attack ? MAT.reachAttack : MAT.reachMove);
    disc.position.set(x, 0.12, z);
    reachGroup.add(disc);
  });
}

// =============================================================================
// MODÈLES · KayKit Medieval Hexagon Pack (CC0) — voir assets/LICENCES.md
// -----------------------------------------------------------------------------
// Le décor n'est plus généré par du code. Des maillages faits par un artiste
// donnent des silhouettes qu'aucun bruit fractal ne produira : c'est la
// silhouette qui se lit de loin, pas la matière.
// =============================================================================
const MODELS = {};
let modelsReady = false;
let onModelsReady = null;

const MODEL_LIST = [
  'hex_grass', 'hex_water',
  'mountain_A_grass_trees', 'mountain_B_grass_trees', 'hills_A_trees', 'hill_single_A',
  'rock_single_A', 'rock_single_B', 'tree_single_A', 'tree_single_B',
  'building_home_A_blue', 'building_home_B_blue', 'building_castle_blue',
  'building_church_blue', 'building_market_blue', 'building_tower_A_blue',
  'building_mine_blue', 'building_windmill_blue',
  'building_castle_red', 'building_home_A_red', 'building_tower_A_red',
  'building_castle_green', 'building_home_A_green', 'building_tower_A_green',
  'building_castle_yellow', 'building_home_A_yellow', 'building_tower_A_yellow',
  'flag_blue', 'flag_red', 'flag_green', 'flag_yellow',
];

/** Couleur de bannière d'un propriétaire, pour choisir la variante du modèle. */
const OWNER_COLOR = { joueur: 'blue', ombre: 'red', cendre: 'yellow', givre: 'blue', ronce: 'green' };
function colorOf(owner) { return OWNER_COLOR[owner] || 'red'; }

export function loadModels(onReady) {
  onModelsReady = onReady;
  const loader = new GLTFLoader();
  let restants = MODEL_LIST.length;
  MODEL_LIST.forEach((name) => {
    loader.load(`./assets/models/${name}.gltf`, (gltf) => {
      const racine = gltf.scene;
      racine.traverse((n) => {
        if (!n.isMesh) return;
        n.castShadow = true;
        n.receiveShadow = true;
        // L'atlas du pack est en sRGB ; sans ça tout ressort délavé.
        if (n.material && n.material.map) n.material.map.colorSpace = THREE.SRGBColorSpace;
      });
      MODELS[name] = racine;
      if (--restants === 0) { modelsReady = true; if (onModelsReady) onModelsReady(); }
    }, undefined, (e) => {
      console.warn('[kopek] modèle non chargé', name, e);
      if (--restants === 0) { modelsReady = true; if (onModelsReady) onModelsReady(); }
    });
  });
}

/**
 * Modèle de la tuile elle-même. Montagnes et collines du pack embarquent leur
 * propre socle hexagonal : les poser SUR une tuile d'herbe donnait des dalles
 * grises flottantes. Elles remplacent donc la tuile.
 */
function tileModel(t, rng) {
  if (t.terrain === 'montagne') return rng() < 0.5 ? 'mountain_A_grass_trees' : 'mountain_B_grass_trees';
  if (t.terrain === 'colline') return 'hills_A_trees';
  return 'hex_grass';
}

// Une matière assombrie par matière d'origine, mise en cache : sans ça on
// recréerait des centaines de matières à chaque redessin.
const fogCache = new Map();
function fogMaterial(src) {
  if (!src) return src;
  if (fogCache.has(src.uuid)) return fogCache.get(src.uuid);
  const m = src.clone();
  m.color = new THREE.Color(0x7d93a8);
  if (m.map) m.color.multiplyScalar(1);
  m.roughness = 1;
  m.metalness = 0;
  fogCache.set(src.uuid, m);
  return m;
}

/**
 * Aplatit un modèle en une liste de (géométrie, matière, transformation locale).
 * Calculé une fois par modèle : c'est la base de l'instanciation.
 */
const flatCache = new Map();
function flatten(name) {
  if (flatCache.has(name)) return flatCache.get(name);
  const src = MODELS[name];
  if (!src) return [];
  src.updateMatrixWorld(true);
  const parts = [];
  src.traverse((n) => {
    if (!n.isMesh) return;
    parts.push({ geometry: n.geometry, material: n.material, matrix: n.matrixWorld.clone() });
  });
  flatCache.set(name, parts);
  return parts;
}

/**
 * Dessine toutes les tuiles en maillages instanciés : 217 hexagones posés un
 * par un font autant d'appels de dessin et effondrent la fluidité sur
 * téléphone. Regroupés par modèle, il en reste une poignée.
 */
function drawTilesInstanced(entries) {
  const groupes = new Map();
  entries.forEach((e) => {
    const cle = e.name + (e.fog ? '#brume' : '');
    if (!groupes.has(cle)) groupes.set(cle, { name: e.name, fog: e.fog, items: [] });
    groupes.get(cle).items.push(e);
  });

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const un = new THREE.Vector3(1, 1, 1);

  groupes.forEach(({ name, fog, items }) => {
    flatten(name).forEach((part) => {
      const mat = fog ? fogMaterial(part.material) : part.material;
      const inst = new THREE.InstancedMesh(part.geometry, mat, items.length);
      inst.castShadow = !fog;
      inst.receiveShadow = true;
      items.forEach((e, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), e.ry);
        pos.set(e.x, e.y, e.z);
        m.compose(pos, q, un).multiply(part.matrix);
        inst.setMatrixAt(i, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      worldGroup.add(inst);
    });
  });
}

/** Copie d'un modèle, prête à être posée. Les matières sont partagées. */
function inst(name, scale = 1, ry = 0) {
  const src = MODELS[name];
  if (!src) return null;
  const o = src.clone(true);
  o.scale.setScalar(scale);
  o.rotation.y = ry;
  return o;
}

// Le pack est calibré pour un hexagone de rayon 1 « pointy-top » ; notre grille
// utilise le même repère, il n'y a donc qu'un facteur d'échelle global.
const MODEL_SCALE = 1.0;

/** Décor d'une tuile : relief, nature, bâti, bannière. */
function decorateTile(t, x, y, z, rng, p) {
  const poser = (o, dx = 0, dz = 0, dy = 0) => {
    if (!o) return null;
    o.position.set(x + dx, y + dy, z + dz);
    decorGroup.add(o);
    return o;
  };

  // Le relief est porté par la tuile elle-même (voir tileModel) ; ici on
  // n'ajoute que ce qui se pose dessus.
  if (t.terrain === 'montagne' || t.terrain === 'colline') {
    if (rng() < 0.5) poser(inst('rock_single_A', 0.4, rng() * Math.PI * 2), (rng() - 0.5) * 0.8, (rng() - 0.5) * 0.8);
  } else if (t.terrain === 'foret') {
    const n = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, d = rng() * 0.55;
      poser(inst(rng() < 0.5 ? 'tree_single_A' : 'tree_single_B', 0.55 + rng() * 0.2, rng() * Math.PI * 2),
            Math.cos(a) * d, Math.sin(a) * d);
    }
  } else if (t.terrain === 'sable' && rng() < 0.45) {
    poser(inst('rock_single_B', 0.5 + rng() * 0.25, rng() * Math.PI * 2),
          (rng() - 0.5) * 0.9, (rng() - 0.5) * 0.9);
  } else if (t.terrain === 'prairie') {
    if (rng() < 0.35) poser(inst('tree_single_A', 0.55, rng() * Math.PI * 2), (rng() - 0.5) * 0.9, (rng() - 0.5) * 0.9);
    if (rng() < 0.25) poser(inst('rock_single_A', 0.45, rng() * Math.PI * 2), (rng() - 0.5) * 1, (rng() - 0.5) * 1);
  }

  // --- la capitale : une vraie ville qui grandit avec les heures ---
  if (t.capital) {
    town(x, y, z, rng, Math.max(0, Math.min(1.6, p.capitalProgress ?? 0)), poser);
  } else if (t.building) {
    const c = colorOf(t.owner);
    const modele = {
      caserne: `building_tower_A_${c}`,
      ferme: 'building_windmill_blue',
      scierie: 'building_market_blue',
      mine: 'building_mine_blue',
      rempart: `building_tower_A_${c}`,
    }[t.building];
    poser(inst(modele, SCALE_BUILDING, rng() * Math.PI * 2));
  } else if (t.seat) {
    poser(inst(`building_castle_${colorOf(t.owner)}`, SCALE_CASTLE, rng() * Math.PI * 2));
  } else if (t.owner && t.owner !== 'joueur') {
    poser(inst(`building_home_A_${colorOf(t.owner)}`, SCALE_BUILDING, rng() * Math.PI * 2));
  }

  // --- bannière du propriétaire ---
  if (t.owner) {
    poser(inst(`flag_${colorOf(t.owner)}`, 0.6, rng() * 0.6), 0.52, 0.44);
  }

  // --- garnison : de petites tours marquent la présence de troupes ---
  const troops = t.owner ? (t.garrison || 0) : (t.neutralGarrison || 0);
  if (troops > 0 && !t.capital) {
    const c = t.owner ? colorOf(t.owner) : 'red';
    poser(inst(`building_tower_A_${c}`, SCALE_TOWER * 0.8, rng() * Math.PI), -0.48, 0.44);
  }
}

/**
 * La ville de la capitale. Le nombre de bâtiments suit les heures encodées :
 * c'est le seul endroit où le travail réel se voit dans le paysage.
 */
// Le château du pack est conçu pour occuper plusieurs tuiles : à l'échelle 1
// il écrase ses voisines. Ces facteurs le ramènent à la taille d'un hexagone.
const SCALE_CASTLE = 0.42;
const SCALE_BUILDING = 0.34;
const SCALE_TOWER = 0.3;

function town(x, y, z, rng, progress, poser) {
  // Le château d'abord : il donne l'échelle et le centre.
  poser(inst('building_castle_blue', SCALE_CASTLE, 0.3));

  const batiments = ['building_home_A_blue', 'building_home_B_blue', 'building_market_blue',
                     'building_church_blue', 'building_windmill_blue'];
  const combien = 2 + Math.round(progress * 5);
  for (let i = 0; i < combien; i++) {
    const a = (i / Math.max(3, combien)) * Math.PI * 2 + 0.7;
    const d = 0.42 + (i % 2) * 0.16;
    poser(inst(batiments[i % batiments.length], SCALE_BUILDING, a + Math.PI), Math.cos(a) * d, Math.sin(a) * d);
  }
  // Le donjon doré des références n'existe pas dans le pack : la garantie
  // atteinte se marque par l'église, visible de loin.
  if (progress >= 1) poser(inst('building_church_blue', SCALE_BUILDING * 1.25, -0.4), 0.05, -0.5);
}

function placeSelection(sel, tiles) {
  if (!selectedRing) return;
  if (!sel || !tiles[tileKey(sel.q, sel.r)]) { selectedRing.visible = false; return; }
  const { x, z } = axialToWorld(sel.q, sel.r, HEX);
  selectedRing.position.set(x, 0.14, z);
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
  // Les vagues défilent en décalant la carte de normales : aucun maillage à
  // recalculer, la mer bouge pour le prix d'une soustraction.
  if (seaWaves) {
    seaWaves.offset.x = hoverTime * 0.012;
    seaWaves.offset.y = hoverTime * 0.008;
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
  controls.target.set(x, 0.1, z);
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
/** Combien de maillages d'armée sont posés autour d'un point. Sert au test qui
 *  vérifie qu'une colonne ennemie est bien dessinée, brume ou pas. */
export function debugArmyMeshesAt(x = 0, z = 0, radius = 1) {
  return armyGroup.children.filter((m) => Math.hypot(m.position.x - x, m.position.z - z) <= radius).length;
}

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

/** État réel des matières : la texture est-elle chargée, et à quelle teinte ? */
export function debugMaterials() {
  const out = {};
  const put = (name, m) => {
    if (!m) return;
    out[name] = {
      map: m.map ? (m.map.image ? `${m.map.image.width}x${m.map.image.height}` : 'en attente') : 'aucune',
      bump: m.bumpMap ? (m.bumpMap.image ? 'chargé' : 'en attente') : 'aucun',
      teinte: m.color ? '#' + m.color.getHexString() : '-',
    };
  };
  Object.entries(MAT.ground || {}).forEach(([k, m]) => put('sol.' + k, m));
  put('mur', MAT.wall); put('roche', MAT.rock); put('flanc', MAT.flanc);
  put('feuillage', MAT.leaf && MAT.leaf[0]);
  out._environnement = envReady ? 'HDR appliqué' : 'HDR absent';
  out._texturesDemandees = texturesReady;
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
