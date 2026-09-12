// =============================================================================
// CARTE 3D · le rendu de L'Empire de Nessy
// -----------------------------------------------------------------------------
// Écrit pour le moteur de empire.js, et pour lui seul. Le renderer précédent
// traînait quinze cents lignes de décor procédural abandonné : on peut habiller
// une forme, on ne peut pas lui inventer une silhouette, et ces silhouettes-là
// viennent maintenant d'un artiste (KayKit, CC0 — voir assets/LICENCES.md).
//
// Ce qui sépare un prototype d'un jeu tient en quatre choses, et c'est là qu'est
// l'effort : la lumière, la caméra, l'animation, et le fait que chaque chose
// affichée réponde à une question du joueur.
// =============================================================================
import * as THREE from './vendor/three/three.module.js?v=2026-09-12-01';
import { OrbitControls } from './vendor/three/OrbitControls.js?v=2026-09-12-01';
import { RGBELoader } from './vendor/three/RGBELoader.js?v=2026-09-12-01';
import { GLTFLoader } from './vendor/three/GLTFLoader.js?v=2026-09-12-01';
import { axialToWorld, tileKey, TERRAINS, RESSOURCES, peupleById, JOUEUR } from './empire.js?v=2026-09-12-01';

// Le socle du pack mesure exactement 2,0 de plat à plat, soit un hexagone de
// rayon 2/√3. En les espaçant à 1,0 on les faisait se chevaucher de 13 % : les
// falaises d'une tuile ressortaient à travers sa voisine, et le relief semblait
// empilé au lieu d'être continu. À la bonne mesure, les socles se touchent et
// il ne reste que la falaise du littoral.
const HEX = 2 / Math.sqrt(3);      // 1,1547
const PALETTE = {
  mer: '#2a7ba6', brume: '#a9c2d4',
  selection: '#ffffff', marche: '#5eb0ff', assaut: '#ff5f5f',
};

let renderer, scene, camera, controls, horloge;
let canvasEl, onSelect = null, raf = null;
let groupeSol, groupeDecor, groupeVilles, groupeUnites, groupeAides, groupeBords;
let mer = null, soleil = null, anneauSel = null;
let cibles = [];                 // cases cliquables
const pointeur = new THREE.Vector2();
const rayon = new THREE.Raycaster();
let dernierRendu = null, derniereSignature = null;
let cadre = 0;
let envPrete = false;

// Les unités se déplacent d'une case à l'autre en glissant : un pion qui se
// téléporte ne se suit pas des yeux, et c'est la première chose qui fait
// « prototype » plutôt que « jeu ».
const animations = new Map();    // idUnite → { deX, deZ, versX, versZ, debut, duree }

// ---------- Modèles -----------------------------------------------------------
const MODELES = {};
let modelesPrets = false;
let quandPrets = null;

const LISTE = [
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

// Chaque peuple a sa teinte de bâti dans le pack.
// La teinte du pack doit correspondre à la couleur du peuple, sinon la
// frontière dit une chose et le bâti une autre — c'est ce qui rendait la carte
// impossible à lire d'un coup d'œil.
const TEINTE = { [JOUEUR]: 'yellow', ombre: 'red', givre: 'blue', ronce: 'green' };
const teinteDe = (p) => TEINTE[p] || 'red';

export function chargerModeles(pret) {
  quandPrets = pret;
  const loader = new GLTFLoader();
  let restants = LISTE.length;
  LISTE.forEach((nom) => {
    loader.load(`./assets/models/${nom}.gltf`, (gltf) => {
      gltf.scene.traverse((n) => {
        if (!n.isMesh) return;
        n.castShadow = true;
        n.receiveShadow = true;
        // L'atlas du pack est en sRGB ; sans ça tout ressort délavé.
        if (n.material && n.material.map) n.material.map.colorSpace = THREE.SRGBColorSpace;
      });
      MODELES[nom] = gltf.scene;
      if (--restants === 0) { modelesPrets = true; if (quandPrets) quandPrets(); }
    }, undefined, () => {
      if (--restants === 0) { modelesPrets = true; if (quandPrets) quandPrets(); }
    });
  });
}

function instance(nom, echelle = 1, rotY = 0) {
  const src = MODELES[nom];
  if (!src) return null;
  const o = src.clone(true);
  o.scale.setScalar(echelle);
  o.rotation.y = rotY;
  return o;
}

// ---------- Scène -------------------------------------------------------------
export function initCarte(canvas, opts = {}) {
  canvasEl = canvas;
  onSelect = opts.onSelect || null;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;

  scene = new THREE.Scene();
  scene.background = cielDegrade();
  scene.fog = new THREE.Fog(PALETTE.brume, 30, 120);

  camera = new THREE.PerspectiveCamera(38, 1, 0.5, 300);
  camera.position.set(0, 14, 16);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minPolarAngle = Math.PI * 0.13;
  controls.maxPolarAngle = Math.PI * 0.44;
  controls.enablePan = true;
  controls.screenSpacePanning = false;
  controls.panSpeed = 0.7;
  controls.addEventListener('start', () => { controls._bouge = true; });

  // Soleil rasant et ciel froid : c'est ce contraste qui donne du relief à des
  // volumes simples. Une lumière frontale les aplatit complètement.
  const ciel = new THREE.HemisphereLight('#bcd8f2', '#6a5637', 0.48);
  scene.add(ciel);
  soleil = new THREE.DirectionalLight('#ffe7b8', 1.85);
  soleil.position.set(-11, 15, 8);
  soleil.castShadow = true;
  soleil.shadow.mapSize.set(2048, 2048);
  soleil.shadow.bias = -0.0012;
  soleil.shadow.normalBias = 0.02;
  const sc = soleil.shadow.camera;
  sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 90;
  scene.add(soleil, soleil.target);

  groupeSol = new THREE.Group();    scene.add(groupeSol);
  groupeDecor = new THREE.Group();  scene.add(groupeDecor);
  groupeBords = new THREE.Group();  scene.add(groupeBords);
  groupeAides = new THREE.Group();  scene.add(groupeAides);
  groupeVilles = new THREE.Group(); scene.add(groupeVilles);
  groupeUnites = new THREE.Group(); scene.add(groupeUnites);

  construireMer();
  construireAnneauSelection();
  chargerEnvironnement();
  chargerModeles(() => { derniereSignature = null; if (dernierRendu) rendre(dernierRendu, { force: true }); });

  horloge = new THREE.Clock();
  canvas.addEventListener('pointerdown', surPointeurBas);
  canvas.addEventListener('pointerup', surPointeurHaut);
  window.addEventListener('resize', redimensionner);
  redimensionner();
  boucle();
}

/** Un dégradé de ciel peint dans un canevas : moins cher qu'une HDR pour le fond. */
function cielDegrade() {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 256;
  const g = c.getContext('2d').createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.0, '#1d4a70');
  g.addColorStop(0.40, '#6ea8d2');
  g.addColorStop(0.70, '#c8dde9');
  g.addColorStop(0.88, '#f0dcbd');
  g.addColorStop(1.0, '#d9b489');
  const ctx = c.getContext('2d');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

/** L'éclairage d'ambiance vient d'une carte HDR : c'est lui qui évite le plastique. */
function chargerEnvironnement() {
  new RGBELoader().load('./assets/env/ciel_venise_1k.hdr', (hdr) => {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(hdr).texture;
    hdr.dispose(); pmrem.dispose();
    envPrete = true;
  }, undefined, () => { envPrete = false; });
}

function construireMer() {
  // 28×28 et non 60×60 : la houle se lit tout aussi bien et coûte cinq fois
  // moins cher. Recalculer 3721 sommets et leurs normales à chaque image
  // vidait la batterie d'un téléphone pour une ondulation qu'on distingue à
  // peine.
  const geo = new THREE.PlaneGeometry(120, 120, 28, 28);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color: PALETTE.mer, roughness: 0.12, metalness: 0.25,
    transparent: true, opacity: 0.9,
  });
  mer = new THREE.Mesh(geo, mat);
  mer.position.y = -0.22;
  mer.receiveShadow = true;
  mer.userData.base = geo.attributes.position.array.slice();
  scene.add(mer);
}

function construireAnneauSelection() {
  const geo = new THREE.RingGeometry(HEX * 0.72, HEX * 0.9, 6);
  geo.rotateX(-Math.PI / 2); geo.rotateY(Math.PI / 6);
  anneauSel = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: PALETTE.selection, transparent: true, opacity: 0.95, depthWrite: false,
  }));
  anneauSel.renderOrder = 5;
  anneauSel.visible = false;
  scene.add(anneauSel);
}

// ---------- Boucle et animation ----------------------------------------------
function boucle() {
  raf = requestAnimationFrame(boucle);
  if (document.hidden) return;       // onglet caché : rien à dessiner
  const t = horloge.getElapsedTime();

  // La mer respire. Une surface plate et figée trahit immédiatement le décor.
  // On la met à jour trois fois moins souvent que l'affichage : l'œil ne voit
  // pas la différence, la machine si.
  cadre++;
  if (mer && cadre % 3 === 0) {
    const pos = mer.geometry.attributes.position;
    const base = mer.userData.base;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3], z = base[i * 3 + 2];
      pos.array[i * 3 + 1] = Math.sin(x * 0.35 + t * 0.9) * 0.05
                           + Math.cos(z * 0.28 - t * 0.7) * 0.045;
    }
    pos.needsUpdate = true;
    if (cadre % 9 === 0) mer.geometry.computeVertexNormals();
  }

  // Les bannières flottent, les pions respirent : le mouvement rend une scène
  // vivante bien plus sûrement qu'un polygone de plus.
  groupeUnites.children.forEach((o) => {
    if (o.userData.fanion) o.rotation.z = Math.sin(t * 2.2 + o.userData.phase) * 0.16;
    if (o.userData.pion) o.position.y = o.userData.y0 + Math.sin(t * 1.7 + o.userData.phase) * 0.03;
  });
  groupeVilles.children.forEach((o) => {
    if (o.userData.fanion) o.rotation.z = Math.sin(t * 1.9 + o.userData.phase) * 0.14;
  });
  groupeAides.children.forEach((o) => {
    if (o.userData.pulse) {
      const k = 0.82 + 0.18 * Math.sin(t * 3 + o.userData.phase);
      o.scale.setScalar(k);
      if (o.material) o.material.opacity = o.userData.op * (0.7 + 0.3 * Math.sin(t * 3 + o.userData.phase));
    }
  });

  // Déplacements en cours.
  const maintenant = performance.now();
  animations.forEach((a, id) => {
    const k = Math.min(1, (maintenant - a.debut) / a.duree);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // accélère puis freine
    if (a.objet) {
      a.objet.position.x = a.deX + (a.versX - a.deX) * e;
      a.objet.position.z = a.deZ + (a.versZ - a.deZ) * e;
    }
    if (k >= 1) animations.delete(id);
  });

  if (anneauSel && anneauSel.visible) {
    anneauSel.material.opacity = 0.6 + 0.35 * Math.sin(t * 3.4);
  }

  controls.update();
  renderer.render(scene, camera);
}

export function arreter() { if (raf) cancelAnimationFrame(raf); raf = null; }

function redimensionner() {
  if (!canvasEl || !renderer) return;
  const w = canvasEl.clientWidth || 1;
  const h = canvasEl.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const etroit = w / h < 1.15;
  const dist = etroit ? 27 : 22;
  controls.minDistance = dist * 0.35;
  controls.maxDistance = dist * 3.4;
  if (!controls._bouge) {
    const azim = controls.getAzimuthalAngle();
    camera.position.setFromSphericalCoords(dist, Math.PI * (etroit ? 0.30 : 0.32), azim);
    camera.position.add(controls.target);
    controls.update();
  }
  scene.fog.near = dist * 1.6;
  scene.fog.far = dist * 6;
}

/** Recentre la caméra en douceur sur une case. */
export function viser(q, r, { immediat = false } = {}) {
  const { x, z } = axialToWorld(q, r, HEX);
  const cible = new THREE.Vector3(x, 0, z);
  if (immediat) { controls.target.copy(cible); controls.update(); return; }
  const depart = controls.target.clone();
  const t0 = performance.now();
  const duree = 420;
  const pas = () => {
    const k = Math.min(1, (performance.now() - t0) / duree);
    const e = 1 - Math.pow(1 - k, 3);
    controls.target.lerpVectors(depart, cible, e);
    controls.update();
    if (k < 1) requestAnimationFrame(pas);
  };
  pas();
}

// ---------- Le rendu de la carte ---------------------------------------------
/** Quel modèle de socle pour ce terrain. */
function modeleSol(t, alea) {
  switch (t.terrain) {
    case 'eau': return 'hex_water';
    case 'montagne': return alea() < 0.5 ? 'mountain_A_grass_trees' : 'mountain_B_grass_trees';
    case 'colline': return alea() < 0.55 ? 'hills_A_trees' : 'hill_single_A';
    default: return 'hex_grass';
  }
}

// Prairie, plaine et désert partagent le même modèle d'hexagone : sans teinte,
// la carte est un aplat uniforme où aucun terrain ne se reconnaît. On multiplie
// la matière du pack par une couleur — c'est gratuit et ça change tout.
const TEINTE_SOL = {
  prairie: 0x8fd96e,
  plaine:  0xd8dd92,
  foret:   0x76b866,
  desert:  0xf2dda6,
};

/** Six variations discrètes autour d'une teinte, indexées pour rester en cache. */
const cacheNuance = new Map();
function nuance(base, n) {
  const cle = base * 10 + n;
  if (cacheNuance.has(cle)) return cacheNuance.get(cle);
  const c = new THREE.Color(base);
  const k = 1 + (n - 2.5) * 0.035;                 // ±9 %
  c.multiplyScalar(k);
  c.offsetHSL((n - 2.5) * 0.006, 0, 0);
  const v = c.getHex();
  cacheNuance.set(cle, v);
  return v;
}

const cacheTeinte = new Map();
function matTeinte(src, teinte) {
  if (!src || !teinte) return src;
  const cle = src.uuid + ':' + teinte;
  if (cacheTeinte.has(cle)) return cacheTeinte.get(cle);
  const m = src.clone();
  m.color = new THREE.Color(teinte);
  cacheTeinte.set(cle, m);
  return m;
}

/** Matériau assombri pour la brume de guerre, mis en cache par matière source. */
const cacheBrume = new Map();
function matBrume(src) {
  if (!src) return src;
  if (cacheBrume.has(src.uuid)) return cacheBrume.get(src.uuid);
  const m = src.clone();
  // Un cran de détail en moins, pas une frontière : repeindre l'inexploré en
  // gris franc dessinait un halo autour du joueur qu'on lisait comme « chez moi ».
  m.color = new THREE.Color(0x93a6b5);
  m.roughness = 1; m.metalness = 0;
  cacheBrume.set(src.uuid, m);
  return m;
}

/** Aplatit un modèle en (géométrie, matière, transformation) : base de l'instanciation. */
const cachePlat = new Map();
function aplatir(nom) {
  if (cachePlat.has(nom)) return cachePlat.get(nom);
  const src = MODELES[nom];
  if (!src) return [];
  src.updateMatrixWorld(true);
  const parts = [];
  src.traverse((n) => {
    if (!n.isMesh) return;
    parts.push({ geo: n.geometry, mat: n.material, mat4: n.matrixWorld.clone() });
  });
  cachePlat.set(nom, parts);
  return parts;
}

/**
 * Les 271 socles partent en InstancedMesh, groupés par (modèle, brume). Dessiner
 * la carte entière coûte alors moins cher que d'en dessiner un tiers un par un.
 */
function poserSols(entrees) {
  const paquets = new Map();
  entrees.forEach((e) => {
    aplatir(e.nom).forEach((part, i) => {
      const cle = `${e.nom}#${i}#${e.brume ? 'b' : 'n'}#${e.teinte || 0}`;
      if (!paquets.has(cle)) paquets.set(cle, { part, brume: e.brume, teinte: e.teinte, liste: [] });
      paquets.get(cle).liste.push(e);
    });
  });
  const m4 = new THREE.Matrix4(), tmp = new THREE.Matrix4();
  paquets.forEach(({ part, brume, teinte, liste }) => {
    const mat = brume ? matBrume(part.mat) : matTeinte(part.mat, teinte);
    const lot = new THREE.InstancedMesh(part.geo, mat, liste.length);
    lot.castShadow = true; lot.receiveShadow = true;
    liste.forEach((e, i) => {
      m4.makeRotationY(e.ry);
      tmp.makeTranslation(e.x, e.y, e.z);
      m4.premultiply(tmp);
      m4.multiply(part.mat4);
      lot.setMatrixAt(i, m4);
    });
    lot.instanceMatrix.needsUpdate = true;
    groupeSol.add(lot);
  });
}

function alea3(q, r) {
  let h = ((q * 73856093) ^ (r * 19349663)) >>> 0;
  return () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
}

function vider(g) {
  while (g.children.length) {
    const o = g.children.pop();
    o.traverse?.((n) => { if (n.isInstancedMesh) n.dispose(); });
  }
}

/** Signature de ce qui est réellement dessiné : on ne rebâtit que si ça change. */
function signature(p) {
  let s = '';
  Object.values(p.tuiles || {}).forEach((t) => {
    s += `${t.q},${t.r}:${t.terrain}${t.explore ? 1 : 0}${t.proprietaire || '-'}${t.ressource || '-'};`;
  });
  (p.villes || []).forEach((v) => { s += `V${v.id}${v.q},${v.r}${v.peuple}${v.pop}${(v.batiments || []).join('')};`; });
  (p.unites || []).forEach((u) => { s += `U${u.id}${u.q},${u.r}${u.type}${u.peuple}${Math.round(u.pv / 10)}${u.fortifie ? 'f' : ''};`; });
  s += `S${p.selection ? p.selection.q + ',' + p.selection.r : '-'}`;
  s += `P${p.portee ? [...p.portee.keys()].join('|') : '-'}`;
  s += `M${(p.marques || []).map((m) => m.q + ',' + m.r + m.genre).join('|')}`;
  return s;
}

/** Dessine tout. `payload` vient de empire.js, jamais du DOM. */
export function rendre(p, { force = false } = {}) {
  if (!scene) return;
  dernierRendu = p;
  const sig = signature(p);
  if (!force && sig === derniereSignature) { placerSelection(p.selection); return; }
  derniereSignature = sig;

  vider(groupeSol); vider(groupeDecor); vider(groupeVilles);
  vider(groupeUnites); vider(groupeAides); vider(groupeBords);
  cibles = [];

  const tuiles = p.tuiles || {};
  const sols = [];
  Object.values(tuiles).forEach((t) => {
    // Le hors-monde n'est pas encore là : l'horizon recule à mesure que
    // l'empire grandit, et dessiner d'emblée les huit cents tuiles engendrées
    // coûterait cher pour montrer des terres qu'on ne peut pas fouler.
    if (t.hors) return;
    const { x, z } = axialToWorld(t.q, t.r, HEX);
    const alea = alea3(t.q, t.r);
    const brume = !t.explore;
    // Une variation de teinte case par case : sur du plat, un aplat parfaitement
    // uniforme fait ressortir chaque couture d'hexagone et la carte ressemble à
    // un carrelage. Six nuances suffisent à casser la grille.
    const base = TEINTE_SOL[t.terrain] || 0;
    sols.push({ nom: modeleSol(t, alea), x, z, y: brume ? -0.04 : 0,
                ry: Math.floor(alea() * 6) * Math.PI / 3, brume,
                teinte: base ? nuance(base, Math.floor(alea() * 6)) : 0 });

    // Cible de clic : un hexagone plat invisible. Viser les maillages du décor
    // rendrait le toucher imprécis selon ce qui pousse dessus.
    const cible = new THREE.Mesh(GEO_PICK(), MAT_PICK());
    cible.position.set(x, 0.06, z);
    cible.userData.case = { q: t.q, r: t.r };
    groupeSol.add(cible);
    cibles.push(cible);

    if (!brume) decorerCase(t, x, z, alea);
  });
  poserSols(sols);

  dessinerFrontieres(p, tuiles);
  dessinerVilles(p);
  dessinerUnites(p);
  dessinerAides(p);
  placerSelection(p.selection);
}

let _geoPick = null, _matPick = null;
function GEO_PICK() {
  if (!_geoPick) {
    _geoPick = new THREE.CircleGeometry(HEX * 0.92, 6);
    _geoPick.rotateX(-Math.PI / 2); _geoPick.rotateY(Math.PI / 6);
  }
  return _geoPick;
}
function MAT_PICK() {
  if (!_matPick) _matPick = new THREE.MeshBasicMaterial({ visible: false });
  return _matPick;
}

/** Arbres, rochers et ressources : ce qui fait qu'une case se reconnaît de loin. */
function decorerCase(t, x, z, alea) {
  if (t.terrain === 'foret') {
    const n = 2 + Math.floor(alea() * 2);
    for (let i = 0; i < n; i++) {
      const a = alea() * Math.PI * 2, d = alea() * 0.42;
      const arbre = instance(alea() < 0.5 ? 'tree_single_A' : 'tree_single_B', 0.55 + alea() * 0.2, alea() * 6.28);
      if (arbre) { arbre.position.set(x + Math.cos(a) * d, 0.16, z + Math.sin(a) * d); groupeDecor.add(arbre); }
    }
  }
  if ((t.terrain === 'prairie' || t.terrain === 'plaine') && alea() < 0.7) {
    const n = 1 + (alea() < 0.55 ? 1 : 0) + (alea() < 0.25 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = alea() * 6.28, d = 0.2 + alea() * 0.3;
      const objet = instance(alea() < 0.55 ? 'tree_single_A' : 'rock_single_B', 0.3 + alea() * 0.12, alea() * 6.28);
      if (objet) { objet.position.set(x + Math.cos(a) * d, 0.16, z + Math.sin(a) * d); groupeDecor.add(objet); }
    }
  }
  if (t.terrain === 'desert' && alea() < 0.45) {
    const roc = instance(alea() < 0.5 ? 'rock_single_A' : 'rock_single_B', 0.5, alea() * 6.28);
    if (roc) { roc.position.set(x + (alea() - 0.5) * 0.5, 0.16, z + (alea() - 0.5) * 0.5); groupeDecor.add(roc); }
  }
  // Une ressource se voit : c'est elle qui donne envie d'une case précise.
  if (t.ressource) {
    const marque = jetonRessource(t.ressource);
    if (marque) { marque.position.set(x + 0.34, 0.30, z + 0.30); groupeDecor.add(marque); }
  }
}

// ---------- Jetons dessinés ---------------------------------------------------
// Les icônes sont peintes dans un canevas puis posées sur un disque : à l'échelle
// d'une carte, un pictogramme net se lit instantanément là où une figurine de
// trois millimètres n'est qu'une tache.
const cacheJeton = new Map();
function texteTexture(glyphe, fond, encre = '#1b1712') {
  const cle = glyphe + fond + encre;
  if (cacheJeton.has(cle)) return cacheJeton.get(cle);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = fond;
  x.beginPath(); x.arc(64, 64, 60, 0, Math.PI * 2); x.fill();
  x.strokeStyle = 'rgba(0,0,0,0.35)'; x.lineWidth = 6; x.stroke();
  x.fillStyle = encre;
  x.font = '600 66px system-ui, -apple-system, Segoe UI, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(glyphe, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cacheJeton.set(cle, tex);
  return tex;
}

const GLYPHE_RESSOURCE = { ble: '🌾', chevaux: '🐴', fer: '⛏', or: '◆', pierre: '▲', gibier: '🦌' };
function jetonRessource(cle) {
  const tex = texteTexture(GLYPHE_RESSOURCE[cle] || '•', '#efe2c6');
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(0.17, 18),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2.2;
  m.renderOrder = 3;
  return m;
}

const GLYPHE_UNITE = {
  colon: '⚒', eclaireur: '◇', guerrier: '⚔', archer: '➶',
  cavalier: '♞', belier: '⌂', chevalier: '♜',
};

// ---------- Frontières --------------------------------------------------------
const matFrontiere = new Map();
function matBord(couleur) {
  if (!matFrontiere.has(couleur)) {
    matFrontiere.set(couleur, new THREE.MeshBasicMaterial({
      color: couleur, transparent: true, opacity: 0.92, depthWrite: false }));
  }
  return matFrontiere.get(couleur);
}
const matVoiles = new Map();
function matVoile(couleur) {
  if (!matVoiles.has(couleur)) {
    matVoiles.set(couleur, new THREE.MeshBasicMaterial({
      color: couleur, transparent: true, opacity: 0.16, depthWrite: false }));
  }
  return matVoiles.get(couleur);
}

let _geoBord = null;
function geoBord() {
  if (!_geoBord) {
    _geoBord = new THREE.RingGeometry(HEX * 0.80, HEX * 0.97, 6);
    _geoBord.rotateX(-Math.PI / 2); _geoBord.rotateY(Math.PI / 6);
  }
  return _geoBord;
}

/**
 * Un anneau à la couleur du peuple sur chaque case possédée et explorée. Sans
 * lui, rien sur la carte ne dit à qui appartient une case sans bâtiment — et la
 * question « quel est mon territoire ? » reste sans réponse.
 */
function dessinerFrontieres(p, tuiles) {
  const parPeuple = new Map();
  Object.values(tuiles).forEach((t) => {
    if (!t.proprietaire || !t.explore) return;     // on ne sait pas qui tient ce qu'on n'a pas vu
    const c = peupleById(t.proprietaire).couleur;
    if (!parPeuple.has(c)) parPeuple.set(c, []);
    parPeuple.get(c).push(t);
  });
  const m4 = new THREE.Matrix4();
  parPeuple.forEach((liste, couleur) => {
    const lot = new THREE.InstancedMesh(geoBord(), matBord(couleur), liste.length);
    const fond = new THREE.InstancedMesh(geoDisque(), matVoile(couleur), liste.length);
    liste.forEach((t, i) => {
      const { x, z } = axialToWorld(t.q, t.r, HEX);
      m4.makeTranslation(x, 0.155, z);
      lot.setMatrixAt(i, m4);
      m4.makeTranslation(x, 0.148, z);
      fond.setMatrixAt(i, m4);
    });
    lot.instanceMatrix.needsUpdate = true; lot.renderOrder = 2;
    fond.instanceMatrix.needsUpdate = true; fond.renderOrder = 1;
    groupeBords.add(fond); groupeBords.add(lot);
  });
}

// ---------- Villes ------------------------------------------------------------
/**
 * Une ville se lit d'abord à sa taille : une bourgade et une capitale ne doivent
 * pas se ressembler. On empile les modèles du pack au fur et à mesure qu'elle
 * grandit, plutôt que d'agrandir un seul bâtiment — c'est ce qui donne
 * l'impression d'une ville et non d'un gros jouet.
 */
function dessinerVilles(p) {
  (p.villes || []).forEach((v) => {
    const tuile = (p.tuiles || {})[tileKey(v.q, v.r)];
    if (tuile && !tuile.explore) return;
    const { x, z } = axialToWorld(v.q, v.r, HEX);
    const teinte = teinteDe(v.peuple);
    const alea = alea3(v.q * 31, v.r * 17);

    const coeur = instance(v.capitale ? `building_castle_${teinte}` : `building_tower_A_${teinte}`,
                           v.capitale ? 0.44 : 0.36, alea() * 6.28);
    if (coeur) { coeur.position.set(x, 0.16, z); groupeVilles.add(coeur); }

    // Les faubourgs : une maison de plus tous les deux habitants.
    const maisons = Math.min(5, Math.floor((v.pop - 1) / 1.6));
    for (let i = 0; i < maisons; i++) {
      const a = (i / Math.max(1, maisons)) * Math.PI * 2 + alea();
      const nom = i % 2 ? `building_home_A_${teinte}` : (MODELES[`building_home_B_${teinte}`] ? `building_home_B_${teinte}` : `building_home_A_${teinte}`);
      const m = instance(nom, 0.3, a + Math.PI);
      if (m) { m.position.set(x + Math.cos(a) * 0.5, 0.16, z + Math.sin(a) * 0.5); groupeVilles.add(m); }
    }
    // Les bâtiments construits se voient : bâtir doit changer quelque chose.
    const bats = v.batiments || [];
    const extras = [];
    if (bats.includes('marche')) extras.push('building_market_blue');
    if (bats.includes('bibliotheque') || bats.includes('temple')) extras.push('building_church_blue');
    if (bats.includes('atelier')) extras.push('building_mine_blue');
    if (bats.includes('grenier')) extras.push('building_windmill_blue');
    extras.slice(0, 3).forEach((nom, i) => {
      const a = 2.1 + i * 1.5;
      const m = instance(nom, 0.28, a + Math.PI);
      if (m) { m.position.set(x + Math.cos(a) * 0.56, 0.16, z + Math.sin(a) * 0.56); groupeVilles.add(m); }
    });

    // Bannière : c'est elle qu'on cherche des yeux pour savoir à qui est la ville.
    const drapeau = instance(`flag_${teinte}`, v.capitale ? 0.72 : 0.58, 0);
    if (drapeau) {
      drapeau.position.set(x + 0.42, 0.16, z + 0.38);
      drapeau.userData.fanion = true;
      drapeau.userData.phase = alea() * 6.28;
      groupeVilles.add(drapeau);
    }
    // Les murailles se voient aussi : deux tours d'angle.
    if (bats.includes('muraille')) {
      [-0.5, 0.5].forEach((s, i) => {
        const m = instance(`building_tower_A_${teinte}`, 0.22, 0);
        if (m) { m.position.set(x + s * 0.62, 0.16, z - 0.5 + i * 1.0); groupeVilles.add(m); }
      });
    }
  });
}

// ---------- Unités ------------------------------------------------------------
function dessinerUnites(p) {
  (p.unites || []).forEach((u) => {
    const tuile = (p.tuiles || {})[tileKey(u.q, u.r)];
    if (tuile && !tuile.explore) return;
    const { x, z } = axialToWorld(u.q, u.r, HEX);
    const couleur = peupleById(u.peuple).couleur;
    const phase = (u.id.charCodeAt(1) || 3) * 0.7;

    const groupe = new THREE.Group();
    groupe.position.set(x, 0, z);

    // Socle : un jeton posé sur la case, pas une figurine illisible.
    const socle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.38, 0.09, 20),
      new THREE.MeshStandardMaterial({ color: couleur, roughness: 0.55, metalness: 0.1 }));
    socle.position.y = 0.30;
    socle.castShadow = true;
    groupe.add(socle);

    const face = new THREE.Mesh(
      new THREE.CircleGeometry(0.285, 22),
      new THREE.MeshBasicMaterial({ map: texteTexture(GLYPHE_UNITE[u.type] || '•', '#f7f0e2'), transparent: true }));
    face.rotation.x = -Math.PI / 2;
    face.position.y = 0.355;
    groupe.add(face);

    // Barre de vie : seulement quand l'unité est blessée, sinon c'est du bruit.
    if (u.pv < u.pvMax) {
      const largeur = 0.46;
      const fond = new THREE.Mesh(new THREE.PlaneGeometry(largeur, 0.075),
        new THREE.MeshBasicMaterial({ color: '#2a1d1d', transparent: true, opacity: 0.85, depthWrite: false }));
      fond.position.set(0, 0.62, 0); fond.rotation.x = -0.35; fond.renderOrder = 6;
      groupe.add(fond);
      const part = Math.max(0.02, u.pv / u.pvMax);
      const barre = new THREE.Mesh(new THREE.PlaneGeometry(largeur * part, 0.055),
        new THREE.MeshBasicMaterial({ color: part > 0.5 ? '#6ee7a8' : part > 0.25 ? '#f6c667' : '#ff7b7b', depthWrite: false }));
      barre.position.set(-largeur * (1 - part) / 2, 0.62, 0.004);
      barre.rotation.x = -0.35; barre.renderOrder = 7;
      groupe.add(barre);
    }
    if (u.fortifie) {
      const bouclier = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.45, 6),
        new THREE.MeshBasicMaterial({ color: '#dfe8ef', transparent: true, opacity: 0.8, depthWrite: false }));
      bouclier.rotation.x = -Math.PI / 2; bouclier.rotation.y = Math.PI / 6;
      bouclier.position.y = 0.345;
      groupe.add(bouclier);
    }

    groupe.userData.pion = true;
    groupe.userData.phase = phase;
    groupe.userData.y0 = 0;
    groupe.userData.uniteId = u.id;
    groupeUnites.add(groupe);

    // Si l'unité vient de bouger, on la fait glisser depuis son ancienne case.
    const dep = departs.get(u.id);
    if (dep && (dep.q !== u.q || dep.r !== u.r)) {
      const de = axialToWorld(dep.q, dep.r, HEX);
      animations.set(u.id, { objet: groupe, deX: de.x, deZ: de.z, versX: x, versZ: z,
                             debut: performance.now(), duree: 380 });
      groupe.position.set(de.x, 0, de.z);
    }
    departs.set(u.id, { q: u.q, r: u.r });
  });
  // Les unités disparues n'ont plus de position à mémoriser.
  const vivantes = new Set((p.unites || []).map((u) => u.id));
  [...departs.keys()].forEach((id) => { if (!vivantes.has(id)) departs.delete(id); });
}
const departs = new Map();

// ---------- Aides visuelles ---------------------------------------------------
let _geoDisque = null;
function geoDisque() {
  if (!_geoDisque) {
    _geoDisque = new THREE.CircleGeometry(HEX * 0.82, 6);
    _geoDisque.rotateX(-Math.PI / 2); _geoDisque.rotateY(Math.PI / 6);
  }
  return _geoDisque;
}

/**
 * La portée de l'unité choisie, et les faits de guerre récents. C'est ce qui
 * répond à « je peux faire quoi ? » sans ouvrir un seul menu : bleu on marche,
 * rouge on frappe.
 */
function dessinerAides(p) {
  if (p.portee) {
    p.portee.forEach((c) => {
      const { x, z } = axialToWorld(c.q, c.r, HEX);
      const d = new THREE.Mesh(geoDisque(), new THREE.MeshBasicMaterial({
        color: c.attaque ? PALETTE.assaut : PALETTE.marche,
        transparent: true, opacity: c.attaque ? 0.42 : 0.3, depthWrite: false }));
      d.position.set(x, 0.14, z);
      d.renderOrder = 2;
      groupeAides.add(d);
    });
  }
  (p.jouables || []).forEach((c) => {
    const { x, z } = axialToWorld(c.q, c.r, HEX);
    const d = new THREE.Mesh(geoDisque(), new THREE.MeshBasicMaterial({
      color: '#ffd97a', transparent: true, opacity: 0.34, depthWrite: false }));
    d.position.set(x, 0.145, z);
    d.renderOrder = 2;
    d.userData.pulse = true; d.userData.op = 0.34; d.userData.phase = (c.q + c.r) * 0.6;
    groupeAides.add(d);
  });
  (p.marques || []).forEach((m) => {
    const { x, z } = axialToWorld(m.q, m.r, HEX);
    const couleur = m.genre === 'victoire' ? '#6ee7a8' : '#ff7b7b';
    [0.7, -0.7].forEach((rot) => {
      const lame = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.6),
        new THREE.MeshBasicMaterial({ color: couleur }));
      lame.position.set(x, 0.66, z);
      lame.rotation.set(0.45, 0, rot);
      groupeAides.add(lame);
    });
  });
}

function placerSelection(sel) {
  if (!anneauSel) return;
  if (!sel) { anneauSel.visible = false; return; }
  const { x, z } = axialToWorld(sel.q, sel.r, HEX);
  anneauSel.position.set(x, 0.17, z);
  anneauSel.visible = true;
}

export function selectionner(q, r) { placerSelection(q == null ? null : { q, r }); }

// ---------- Toucher / cliquer -------------------------------------------------
let basXY = null;
function surPointeurBas(e) { basXY = { x: e.clientX, y: e.clientY }; }
function surPointeurHaut(e) {
  if (!basXY) return;
  // Un glissement fait tourner la caméra ; seul un vrai appui sélectionne.
  const bouge = Math.hypot(e.clientX - basXY.x, e.clientY - basXY.y);
  basXY = null;
  if (bouge > 8 || !onSelect) return;
  const r = canvasEl.getBoundingClientRect();
  pointeur.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointeur.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  rayon.setFromCamera(pointeur, camera);
  const touche = rayon.intersectObjects(cibles, false)[0];
  if (touche && touche.object.userData.case) onSelect(touche.object.userData.case);
}

// ---------- Diagnostics -------------------------------------------------------
// Mesurer coûte un appel et tranche ce que trois hypothèses ne trouvent pas.
export function debugScene() {
  return {
    sols: groupeSol.children.length, decor: groupeDecor.children.length,
    villes: groupeVilles.children.length, unites: groupeUnites.children.length,
    aides: groupeAides.children.length, bords: groupeBords.children.length,
    cibles: cibles.length, modeles: Object.keys(MODELES).length, env: envPrete,
  };
}
export function debugPixels(taille = 48) {
  // On redessine juste avant de lire : sur un canevas à double tampon, lire
  // après coup renvoie un tampon vide et fait croire à une scène noire.
  renderer.render(scene, camera);
  const w = renderer.domElement.width, h = renderer.domElement.height;
  const buf = new Uint8Array(taille * taille * 4);
  const gl = renderer.getContext();
  gl.readPixels((w - taille) / 2, (h - taille) / 2, taille, taille, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const teintes = new Set();
  for (let i = 0; i < buf.length; i += 4) {
    teintes.add(`${buf[i] >> 4},${buf[i + 1] >> 4},${buf[i + 2] >> 4}`);
  }
  return { teintes: teintes.size, exemple: [...teintes].slice(0, 4) };
}
