// =============================================================================
// L'EMPIRE DE NESSY · moteur de jeu
// -----------------------------------------------------------------------------
// Un jeu de conquête au tour par tour, dans la lignée de Civilization : on fonde
// des villes, elles grandissent et produisent, on recherche des technologies, on
// lève des armées et on prend les capitales adverses.
//
// Trois règles tiennent tout le fichier :
//
//   1. Aucun DOM, aucun Firestore, aucun three.js ici. Ce module est du calcul
//      pur : c'est ce qui permet de le tester sans navigateur.
//   2. Le lien avec les heures facturées est à SENS UNIQUE. Le jeu lit les
//      prestations, il n'en écrit jamais. Aucune action de jeu ne peut modifier
//      une heure, un projet ou la facturation.
//   3. La carte n'est pas stockée : elle est régénérée depuis une graine, et
//      seules les tuiles modifiées partent en base. Une partie pèse quelques
//      kilo-octets, pas des centaines.
// =============================================================================

// ---------- Géométrie hexagonale ---------------------------------------------
// Coordonnées axiales, hexagones pointe en haut.
export const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export const tileKey = (q, r) => `${q},${r}`;

export function hexDistance(aq, ar, bq, br) {
  return (Math.abs(aq - bq) + Math.abs(aq + ar - bq - br) + Math.abs(ar - br)) / 2;
}
export function neighbors(q, r) { return HEX_DIRS.map(([dq, dr]) => [q + dq, r + dr]); }

export function axialToWorld(q, r, size = 1) {
  return { x: size * Math.sqrt(3) * (q + r / 2), z: size * 1.5 * r };
}

/** Les cases situées exactement à `rayon` du centre, dans l'ordre du tour. */
export function anneau(cq, cr, rayon) {
  if (rayon <= 0) return [[cq, cr]];
  const out = [];
  let q = cq + HEX_DIRS[4][0] * rayon, r = cr + HEX_DIRS[4][1] * rayon;
  for (let d = 0; d < 6; d++) {
    for (let i = 0; i < rayon; i++) {
      out.push([q, r]);
      q += HEX_DIRS[d][0]; r += HEX_DIRS[d][1];
    }
  }
  return out;
}

/** Toutes les cases à portée `rayon`, la case centrale comprise. */
export function disque(q, r, rayon) {
  const out = [];
  for (let dq = -rayon; dq <= rayon; dq++) {
    for (let dr = Math.max(-rayon, -dq - rayon); dr <= Math.min(rayon, -dq + rayon); dr++) {
      out.push([q + dq, r + dr]);
    }
  }
  return out;
}

// ---------- Hasard reproductible ---------------------------------------------
// La même graine doit toujours donner la même carte : c'est ce qui permet de ne
// pas la stocker.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ---------- Terrains ----------------------------------------------------------
// Chaque terrain donne trois rendements : nourriture (croissance), production
// (construction), or (entretien et achats). Plus un bonus défensif, qui fait que
// la géographie compte dans les combats.
export const TERRAINS = {
  prairie:  { label: 'Prairie',  f: 3, p: 0, o: 0, def: 0,  cout: 1 },
  plaine:   { label: 'Plaine',   f: 2, p: 1, o: 1, def: 0,  cout: 1 },
  foret:    { label: 'Forêt',    f: 1, p: 2, o: 0, def: 25, cout: 2 },
  colline:  { label: 'Colline',  f: 1, p: 2, o: 1, def: 30, cout: 2 },
  montagne: { label: 'Montagne', f: 0, p: 1, o: 2, def: 50, cout: 3 },
  desert:   { label: 'Désert',   f: 0, p: 0, o: 1, def: 0,  cout: 1 },
  eau:      { label: 'Mer',      f: 2, p: 0, o: 2, def: 0,  cout: null },   // cout null = infranchissable
};

/** Un terrain sans `cout` ne se traverse pas — et le hors-monde non plus. */
export function franchissable(t) {
  return !!t && !t.hors && TERRAINS[t.terrain] && TERRAINS[t.terrain].cout != null;
}

// ---------- Ressources spéciales ---------------------------------------------
// Elles donnent une raison de vouloir UNE case précise plutôt qu'une autre :
// sans elles, toutes les prairies se valent et le territoire n'a pas d'enjeu.
export const RESSOURCES = {
  ble:      { label: 'Blé',      f: 2, p: 0, o: 0, terrains: ['prairie', 'plaine'] },
  chevaux:  { label: 'Chevaux',  f: 0, p: 1, o: 1, terrains: ['prairie', 'plaine'] },
  fer:      { label: 'Fer',      f: 0, p: 2, o: 0, terrains: ['colline', 'montagne'] },
  or:       { label: 'Or',       f: 0, p: 0, o: 4, terrains: ['colline', 'montagne', 'desert'] },
  pierre:   { label: 'Pierre',   f: 0, p: 2, o: 0, terrains: ['colline', 'plaine'] },
  gibier:   { label: 'Gibier',   f: 2, p: 1, o: 0, terrains: ['foret'] },
};

/** Rendements d'une case, ressource comprise. */
export function rendements(t) {
  const base = TERRAINS[t.terrain] || TERRAINS.plaine;
  const res = t.ressource ? RESSOURCES[t.ressource] : null;
  return {
    f: base.f + (res ? res.f : 0),
    p: base.p + (res ? res.p : 0),
    o: base.o + (res ? res.o : 0),
  };
}

// ---------- Les peuples -------------------------------------------------------
export const JOUEUR = 'nessy';
export const PEUPLES = [
  { id: JOUEUR,   nom: 'Marche de Nessy',   couleur: '#f2c14e', ia: false },
  { id: 'ombre',  nom: 'Clan de l’Ombre',   couleur: '#b4436c', ia: true },
  { id: 'givre',  nom: 'Marche de Givre',   couleur: '#3f8fb0', ia: true },
  { id: 'ronce',  nom: 'Seigneurs de Ronce',couleur: '#5c8f3a', ia: true },
];
// Réserve de peuples, puis génération : quand l'un est soumis, un autre se
// lève. Une partie sans fin ne peut pas s'arrêter faute d'adversaire, et six
// peuples de réserve s'épuisent en quelques mois de jeu.
export const VIVIER = [
  { id: 'brume',  nom: 'Fils de la Brume',  couleur: '#7d6fb5' },
  { id: 'silex',  nom: 'Tribu du Silex',    couleur: '#c08a3e' },
  { id: 'maree',  nom: 'Gens de la Marée',  couleur: '#3fa8a0' },
  { id: 'braise', nom: 'Ordre de Braise',   couleur: '#c25b3a' },
  { id: 'saule',  nom: 'Cercle du Saule',   couleur: '#6f9e5c' },
  { id: 'roche',  nom: 'Maîtres de Roche',  couleur: '#8e8b98' },
];
const TOUS_PEUPLES = [...PEUPLES, ...VIVIER.map((p) => ({ ...p, ia: true }))];

const TETES = ['Fils', 'Gens', 'Clan', 'Ordre', 'Tribu', 'Cercle', 'Maîtres', 'Marche', 'Ligue', 'Sires'];
const QUEUES = ['du Corbeau', 'des Sables', 'de l’Aulne', 'du Granit', 'des Cendres', 'du Héron',
                'de la Faille', 'des Tourbes', 'du Vent', 'de l’Ombre longue', 'des Hauts', 'du Sel'];
export function peupleEngendre(n) {
  return {
    id: 'peuple' + n,
    nom: `${TETES[n % TETES.length]} ${QUEUES[(n * 7 + 3) % QUEUES.length]}`,
    couleur: `hsl(${(n * 47 + 15) % 360} 52% 52%)`,
    ia: true,
  };
}

export const peupleById = (id) => {
  const connu = TOUS_PEUPLES.find((p) => p.id === id);
  if (connu) return connu;
  const m = /^peuple(\d+)$/.exec(String(id || ''));
  return m ? peupleEngendre(Number(m[1])) : PEUPLES[0];
};

/** Les peuples adverses qui tiennent encore au moins une ville. */
export function rivauxActifs(etat) {
  const vivants = new Set((etat.villes || []).map((v) => v.peuple));
  return [...vivants].filter((id) => id !== JOUEUR).map(peupleById);
}

// ---------- Génération de la carte -------------------------------------------
// Le monde est engendré une seule fois jusqu'à RAYON_MONDE, mais seul un disque
// de rayon `etat.rayon` en fait partie au départ ; il grandit avec l'empire.
// Engendrer au fur et à mesure aurait cassé le déterminisme : les terrains sont
// attribués par quantiles sur l'ensemble des terres, donc ajouter une couronne
// changerait rétroactivement le terrain des cases déjà découvertes.
export const RAYON_MONDE = 16;         // 817 tuiles engendrées d'un coup
export const RAYON_CARTE = 9;          // le monde connu au premier tour
export const MARGE_EXTENSION = 2;      // on repousse l'horizon à cette distance

/**
 * Carte déterministe. On pose d'abord un relief par bruit sommé, puis on en
 * déduit les terrains : procéder par tirage indépendant case par case donnait
 * une purée où forêts et montagnes se mélangeaient sans logique.
 */
export function genererCarte(graine) {
  const rng = mulberry32(hashSeed(graine));
  // Quelques centres d'altitude tirés au sort : c'est eux qui créent les
  // chaînes de collines et de montagnes plutôt qu'un semis uniforme.
  const reliefs = Array.from({ length: 14 }, () => ({
    q: Math.round((rng() * 2 - 1) * RAYON_MONDE * 0.8),
    r: Math.round((rng() * 2 - 1) * RAYON_MONDE * 0.8),
    force: 0.55 + rng() * 0.75,
    portee: 3.0 + rng() * 4.5,
  }));
  const humides = Array.from({ length: 10 }, () => ({
    q: Math.round((rng() * 2 - 1) * RAYON_MONDE * 0.8),
    r: Math.round((rng() * 2 - 1) * RAYON_MONDE * 0.8),
    portee: 3.5 + rng() * 5.0,
  }));

  // On calcule d'abord les deux champs continus, puis on découpe par quantiles.
  // Comparer l'altitude à des seuils absolus dépendait de l'échelle du bruit :
  // sept bosses sommées donnaient cent quarante-cinq montagnes sur deux cent
  // soixante-et-onze. Les quantiles garantissent le même mélange à chaque carte.
  const tuiles = {};
  const terres = [];
  disque(0, 0, RAYON_MONDE).forEach(([q, r]) => {
    const d = hexDistance(0, 0, q, r);
    let alt = 0;
    reliefs.forEach((c) => {
      const dd = hexDistance(q, r, c.q, c.r);
      alt += c.force * Math.exp(-(dd * dd) / (2 * c.portee * c.portee));
    });
    let hum = 0;
    humides.forEach((c) => {
      const dd = hexDistance(q, r, c.q, c.r);
      hum += Math.exp(-(dd * dd) / (2 * c.portee * c.portee));
    });
    alt += (rng() - 0.5) * 0.18;
    hum += (rng() - 0.5) * 0.25;

    const t = { q, r, terrain: 'eau', ressource: null, proprietaire: null, ville: null, explore: false, _alt: alt, _hum: hum };
    tuiles[tileKey(q, r)] = t;
    if (d < RAYON_MONDE) terres.push(t);          // la mer ferme le monde
  });

  const part = (liste, champ, debut, fin) => {
    const tries = [...liste].sort((a, b) => b[champ] - a[champ]);
    return tries.slice(Math.round(tries.length * debut), Math.round(tries.length * fin));
  };
  part(terres, '_alt', 0, 0.08).forEach((t) => { t.terrain = 'montagne'; });
  part(terres, '_alt', 0.08, 0.28).forEach((t) => { t.terrain = 'colline'; });
  const plates = terres.filter((t) => t.terrain === 'eau');
  part(plates, '_hum', 0, 0.30).forEach((t) => { t.terrain = 'foret'; });
  part(plates, '_hum', 0.30, 0.62).forEach((t) => { t.terrain = 'prairie' });
  part(plates, '_hum', 0.62, 0.88).forEach((t) => { t.terrain = 'plaine'; });
  part(plates, '_hum', 0.88, 1).forEach((t) => { t.terrain = 'desert'; });
  terres.forEach((t) => { delete t._alt; delete t._hum; });
  Object.values(tuiles).forEach((t) => { delete t._alt; delete t._hum; });

  // Ressources : posées après le relief, sur les terrains qui les acceptent.
  const cases = Object.values(tuiles);
  Object.entries(RESSOURCES).forEach(([cle, res]) => {
    const eligibles = cases.filter((t) => res.terrains.includes(t.terrain) && !t.ressource);
    // Une densité fixe par ressource : assez rare pour valoir un détour, assez
    // fréquente pour qu'il y en ait près de chez soi.
    const combien = Math.max(3, Math.round(eligibles.length * 0.09));
    for (let i = 0; i < combien && eligibles.length; i++) {
      const idx = Math.floor(rng() * eligibles.length);
      eligibles[idx].ressource = cle;
      eligibles.splice(idx, 1);
    }
  });

  return tuiles;
}

/** Un site correct pour une capitale de départ : de la terre, pas un désert. */
function meilleurSite(tuiles, q, r, rayonMax = 2) {
  let best = null, bestScore = -Infinity;
  disque(q, r, rayonMax).forEach(([sq, sr]) => {
    const t = tuiles[tileKey(sq, sr)];
    if (!t || !franchissable(t) || t.terrain === 'montagne') return;
    // La nourriture pèse lourd : une ville qui ne grandit pas ne produit rien
    // non plus, alors qu'une ville pauvre en or se rattrape toujours.
    let score = 0, nourriture = 0;
    disque(sq, sr, 1).forEach(([nq, nr]) => {
      const n = tuiles[tileKey(nq, nr)];
      if (!n) return;
      const y = rendements(n);
      nourriture += y.f;
      score += y.f * 4 + y.p * 1.5 + y.o * 0.8;
    });
    if (nourriture < 8) score -= 40;          // un site qui affame est écarté
    if (score > bestScore) { bestScore = score; best = t; }
  });
  // Rien de viable à deux cases ? On élargit plutôt que de renoncer : une
  // capitale tombée au milieu d'un massif montagneux empêchait purement et
  // simplement la partie de démarrer.
  if (!best && rayonMax < 6) return meilleurSite(tuiles, q, r, rayonMax + 2);
  return best;
}

// ---------- Bâtiments ---------------------------------------------------------
export const BATIMENTS = {
  grenier:     { label: 'Grenier',      cout: 40, or: 1, tech: 'agriculture',  effet: '+40 % de croissance' },
  caserne:     { label: 'Caserne',      cout: 50, or: 1, tech: 'bronze',       effet: 'Unités produites 25 % plus vite' },
  marche:      { label: 'Marché',       cout: 55, or: 0, tech: 'commerce',     effet: '+3 or par tour' },
  bibliotheque:{ label: 'Bibliothèque', cout: 60, or: 1, tech: 'ecriture',     effet: '+3 science par tour' },
  muraille:    { label: 'Muraille',     cout: 70, or: 1, tech: 'maconnerie',   effet: '+60 % de défense' },
  temple:      { label: 'Temple',       cout: 65, or: 1, tech: 'ecriture',     effet: 'Les frontières s’étendent plus vite' },
  atelier:     { label: 'Atelier',      cout: 80, or: 2, tech: 'feodalite',    effet: '+30 % de production' },
};

// ---------- Unités ------------------------------------------------------------
// PV, attaque et défense sont volontairement dans les mêmes ordres de grandeur
// que Civilization : un rapport de force du simple au double doit se voir, sans
// qu'une unité isolée puisse balayer une armée.
export const UNITES = {
  colon:     { label: 'Colon',     cout: 50, mp: 2, pv: 60,  atk: 0,  def: 4,  tech: null,          fonde: true },
  eclaireur: { label: 'Éclaireur', cout: 25, mp: 4, pv: 60,  atk: 4,  def: 4,  tech: null,          vue: 3 },
  guerrier:  { label: 'Guerrier',  cout: 35, mp: 2, pv: 100, atk: 10, def: 10, tech: null },
  archer:    { label: 'Archer',    cout: 45, mp: 2, pv: 100, atk: 15, def: 7,  tech: 'bronze' },
  cavalier:  { label: 'Cavalier',  cout: 60, mp: 4, pv: 100, atk: 17, def: 11, tech: 'equitation',  ressource: 'chevaux' },
  belier:    { label: 'Bélier',    cout: 70, mp: 2, pv: 120, atk: 12, def: 8,  tech: 'mathematiques', siege: 2.5 },
  chevalier: { label: 'Chevalier', cout: 90, mp: 4, pv: 130, atk: 24, def: 18, tech: 'feodalite',   ressource: 'chevaux' },
};

// ---------- Technologies ------------------------------------------------------
export const TECHS = {
  agriculture:  { label: 'Agriculture',   cout: 25,  requiert: [] },
  bronze:       { label: 'Travail du bronze', cout: 45, requiert: ['agriculture'] },
  commerce:     { label: 'Commerce',      cout: 60,  requiert: ['agriculture'] },
  ecriture:     { label: 'Écriture',      cout: 80,  requiert: ['commerce'] },
  equitation:   { label: 'Équitation',    cout: 95,  requiert: ['bronze'] },
  maconnerie:   { label: 'Maçonnerie',    cout: 110, requiert: ['bronze'] },
  mathematiques:{ label: 'Mathématiques', cout: 150, requiert: ['ecriture', 'maconnerie'] },
  feodalite:    { label: 'Féodalité',     cout: 210, requiert: ['equitation', 'mathematiques'] },
};

/**
 * Après l'arbre, la recherche ne s'arrête pas : elle devient des édits, qu'on
 * repromulgue indéfiniment, chacun plus cher que le précédent. Un arbre fini
 * dans une partie infinie laisserait la science sans emploi au bout d'un mois.
 */
export const EDITS = {
  edit_labour: { label: 'Édit des labours',  effet: 'nourriture', gain: 0.08, base: 260 },
  edit_forge:  { label: 'Édit des forges',   effet: 'production', gain: 0.08, base: 280 },
  edit_taille: { label: 'Édit de la taille', effet: 'or',         gain: 0.10, base: 300 },
  edit_ban:    { label: 'Édit du ban',       effet: 'combat',     gain: 0.06, base: 340 },
};

export const nbEdits = (etat, cle) => ((etat.edits || {})[cle] || 0);

/** Coût du prochain exemplaire : il monte, donc promulguer reste un choix. */
export function coutEdit(etat, cle) {
  const e = EDITS[cle];
  return e ? Math.round(e.base * Math.pow(1.45, nbEdits(etat, cle))) : Infinity;
}

/** Le multiplicateur accumulé pour un effet donné. */
export function bonusEdits(etat, effet) {
  let m = 1;
  Object.entries(EDITS).forEach(([cle, e]) => { if (e.effet === effet) m += e.gain * nbEdits(etat, cle); });
  return m;
}

/** Une technologie est accessible si tous ses prérequis sont acquis. */
export function techsDisponibles(etat) {
  const acquises = etat.techs || [];
  return Object.entries(TECHS)
    .filter(([cle, t]) => !acquises.includes(cle) && t.requiert.every((r) => acquises.includes(r)))
    .map(([cle, t]) => ({ cle, ...t }));
}

/** Ce qu'une ville peut mettre en chantier, avec la raison quand c'est non. */
export function chantiersPossibles(etat, ville, tuiles) {
  const acquises = etat.techs || [];
  const out = [];
  Object.entries(UNITES).forEach(([cle, u]) => {
    if (u.tech && !acquises.includes(u.tech)) return;
    if (u.ressource && !ressourceAccessible(etat, tuiles, u.ressource)) return;
    out.push({ genre: 'unite', cle, label: u.label, cout: u.cout });
  });
  Object.entries(BATIMENTS).forEach(([cle, b]) => {
    if (b.tech && !acquises.includes(b.tech)) return;
    if ((ville.batiments || []).includes(cle)) return;
    out.push({ genre: 'batiment', cle, label: b.label, cout: b.cout, effet: b.effet });
  });
  return out;
}

/** Possède-t-on au moins une case avec cette ressource ? */
export function ressourceAccessible(etat, tuiles, ressource) {
  return Object.values(tuiles).some((t) => t.ressource === ressource && t.proprietaire === JOUEUR);
}

// ---------- État de la partie -------------------------------------------------
export const VERSION_ETAT = 2;
// La réserve doit être large. Un joueur qui découvre le jeu passe ses premiers
// tours à chercher quoi faire : avec huit tours au départ et un toutes les
// douze minutes, il se retrouvait au tour 33 avec une seule ville et zéro tour
// en réserve — c'est-à-dire bloqué, sans avoir jamais rien pu essayer.
export const TOURS_MAX = 40;
export const MS_PAR_TOUR = 4 * 60 * 1000;     // un tour se recharge en 4 minutes
export const TOURS_PAR_HEURE = 3;             // chaque heure facturée en offre trois

export function nouvelEtat(graine, maintenant = Date.now()) {
  const etat = {
    version: VERSION_ETAT,
    graine: String(graine),
    rayon: RAYON_CARTE,          // le monde connu, qui grandit avec l'empire
    tour: 1,
    tours: 20,                   // de quoi apprendre sans se bloquer
    dernierRecharge: maintenant,
    toursAccordes: 0,            // heures déjà converties, pour ne pas les compter deux fois
    or: 60, science: 0,
    techs: [], edits: {}, recherche: 'agriculture', progresRecherche: 0,
    villes: [], unites: [], seqUnite: 0, seqVille: 0,
    changements: {},             // seules les tuiles modifiées sont persistées
    journal: [], marques: [],
    vaincus: [], peuplesLeves: [],
    stats: { villesFondees: 0, villesPrises: 0, combatsGagnes: 0, unitesPerdues: 0, peuplesSoumis: 0, exils: 0 },
  };
  const tuiles = genererCarte(etat.graine);
  installerPeuples(etat, tuiles);
  return etat;
}

/** Pose les quatre capitales, le joueur au centre et les rivaux en couronne. */
function installerPeuples(etat, tuiles) {
  const rng = mulberry32(hashSeed(etat.graine + ':peuples'));
  const capitale = meilleurSite(tuiles, 0, 0);
  fonderVille(etat, tuiles, capitale.q, capitale.r, JOUEUR, 'Nessy', true);
  // Deux colons : fonder sa deuxième et sa troisième ville est le vrai premier
  // objectif, et attendre d'en produire un coûtait quinze tours de retard sur
  // des rivaux qui, eux, commencent déjà avec le leur.
  //
  // On les pose sur des cases distinctes. Le déplacement interdit déjà deux
  // unités du même camp sur une case ; les empiler au départ contredisait la
  // règle et, surtout, les rendait toutes invisibles sous le château.
  poserDepart(etat, tuiles, capitale, ['colon', 'guerrier', 'colon', 'guerrier', 'eclaireur'], JOUEUR);

  // Un anneau hexagonal, pas un cercle trigonométrique : `cos/sin` sur des
  // coordonnées axiales donne des distances qui vont du simple au double selon
  // l'angle, et un rival se retrouvait parfois à six cases quand un autre était
  // à dix. On répartit sur le vrai anneau.
  const ring = anneau(capitale.q, capitale.r, 6);
  const ias = PEUPLES.filter((p) => p.ia);
  ias.forEach((p, i) => {
    const depart = Math.floor((i / ias.length) * ring.length + rng() * 2);
    let site = null;
    for (let pas = 0; pas < ring.length && !site; pas++) {
      const [rq, rr] = ring[(depart + pas) % ring.length];
      const essai = meilleurSite(tuiles, rq, rr);
      if (!essai || essai.ville) continue;
      if (hexDistance(essai.q, essai.r, capitale.q, capitale.r) < 5) continue;
      if ((etat.villes || []).some((v) => hexDistance(v.q, v.r, essai.q, essai.r) < 5)) continue;
      site = essai;
    }
    if (!site) return;
    fonderVille(etat, tuiles, site.q, site.r, p.id, p.nom.split(' ').pop(), true);
    poserDepart(etat, tuiles, site, ['guerrier', 'colon'], p.id);
  });
  explorerAutour(etat, tuiles, capitale.q, capitale.r, 3);
}

/** Répartit les unités de départ sur la ville et ses voisines libres. */
function poserDepart(etat, tuiles, centre, types, peuple) {
  const places = [tuiles[tileKey(centre.q, centre.r)],
    ...neighbors(centre.q, centre.r).map(([q, r]) => tuiles[tileKey(q, r)])]
    .filter((t) => t && franchissable(t));
  types.forEach((type, i) => {
    const t = places.find((c) => !uniteEn(etat, c.q, c.r)) || places[i % places.length];
    if (t) creerUnite(etat, t.q, t.r, type, peuple);
  });
}

/** Reconstruit la carte depuis la graine et réapplique les cases modifiées. */
export function hydrater(etat) {
  const tuiles = genererCarte(etat.graine);
  Object.entries(etat.changements || {}).forEach(([cle, patch]) => {
    if (tuiles[cle]) Object.assign(tuiles[cle], patch);
  });
  marquerFrontiere(etat, tuiles);
  return tuiles;
}

/** Ce qui est au-delà du monde connu n'existe pas encore : ni traversable, ni dessiné. */
export function marquerFrontiere(etat, tuiles) {
  const rayon = etat.rayon || RAYON_CARTE;
  Object.values(tuiles).forEach((t) => { t.hors = hexDistance(0, 0, t.q, t.r) > rayon; });
}

/**
 * Repousse l'horizon quand l'empire s'en approche. Une partie sans fin ne peut
 * pas se jouer sur une carte finie : on en fait le tour en quelques heures et il
 * ne reste plus rien à découvrir.
 */
export function etendreMonde(etat, tuiles) {
  const rayon = etat.rayon || RAYON_CARTE;
  if (rayon >= RAYON_MONDE) return 0;
  const proche = [...villesDe(etat), ...unitesDe(etat)]
    .some((x) => hexDistance(0, 0, x.q, x.r) >= rayon - MARGE_EXTENSION);
  if (!proche) return 0;
  etat.rayon = Math.min(RAYON_MONDE, rayon + 2);
  marquerFrontiere(etat, tuiles);
  noter(etat, 'L’horizon recule : de nouvelles terres apparaissent au-delà des marches.', 'bien');
  return etat.rayon - rayon;
}

/** Toute modification de tuile passe par ici, sinon elle ne serait pas sauvée. */
function marquer(etat, t) {
  etat.changements = etat.changements || {};
  etat.changements[tileKey(t.q, t.r)] = {
    proprietaire: t.proprietaire, ville: t.ville, explore: t.explore,
    ameliore: t.ameliore || null,
  };
}

export function explorerAutour(etat, tuiles, q, r, rayon = 2) {
  disque(q, r, rayon).forEach(([nq, nr]) => {
    const t = tuiles[tileKey(nq, nr)];
    if (t && !t.explore) { t.explore = true; marquer(etat, t); }
  });
}

// ---------- Villes ------------------------------------------------------------
export const DIST_MIN_VILLES = 3;      // deux villes ne se collent pas
export const RAYON_INITIAL = 1;
export const RAYON_MAX = 3;

export function villeEn(etat, q, r) {
  return (etat.villes || []).find((v) => v.q === q && v.r === r);
}
export function villesDe(etat, peuple = JOUEUR) {
  return (etat.villes || []).filter((v) => v.peuple === peuple);
}

/** Le seuil de nourriture pour passer au niveau suivant : croissant, comme partout. */
export function seuilCroissance(pop) { return 12 + pop * pop * 6; }
/** Le seuil de culture pour pousser les frontières d'un cran. */
export function seuilFrontiere(rayon) { return 20 + rayon * rayon * 25; }

export function peutFonder(etat, tuiles, q, r, peuple = JOUEUR) {
  const t = tuiles[tileKey(q, r)];
  if (!t) return { ok: false, raison: 'Hors de la carte.' };
  if (!franchissable(t)) return { ok: false, raison: 'On ne fonde pas une ville en mer.' };
  if (t.terrain === 'montagne') return { ok: false, raison: 'La montagne ne nourrit personne.' };
  if (t.ville) return { ok: false, raison: 'Il y a déjà une ville ici.' };
  const trop = (etat.villes || []).some((v) => hexDistance(v.q, v.r, q, r) < DIST_MIN_VILLES);
  if (trop) return { ok: false, raison: `Trop près d’une autre ville (${DIST_MIN_VILLES} cases minimum).` };
  if (t.proprietaire && t.proprietaire !== peuple) return { ok: false, raison: 'Ce territoire appartient à un autre peuple.' };
  return { ok: true };
}

export function fonderVille(etat, tuiles, q, r, peuple = JOUEUR, nom = null, capitale = false) {
  const t = tuiles[tileKey(q, r)];
  if (!t) return { ok: false, error: 'Territoire inconnu.' };
  etat.seqVille = (etat.seqVille || 0) + 1;
  const ville = {
    id: 'v' + etat.seqVille,
    nom: nom || nomDeVille(etat, peuple),
    peuple, fondateur: peuple, q, r, capitale,
    pop: 1, nourriture: 0, culture: 0, rayon: RAYON_INITIAL,
    production: 0, chantier: null,
    batiments: [], pv: 100,
  };
  etat.villes.push(ville);
  t.ville = ville.id;
  t.proprietaire = peuple;
  marquer(etat, t);
  // Les frontières de départ : la ville et sa première couronne.
  disque(q, r, RAYON_INITIAL).forEach(([nq, nr]) => {
    const n = tuiles[tileKey(nq, nr)];
    if (n && !n.proprietaire) { n.proprietaire = peuple; marquer(etat, n); }
  });
  if (peuple === JOUEUR) {
    etat.stats.villesFondees = (etat.stats.villesFondees || 0) + 1;
    explorerAutour(etat, tuiles, q, r, 2);
    noter(etat, `${ville.nom} est fondée.`, 'bien');
  }
  return { ok: true, ville };
}

const NOMS_VILLES = ['Aubeline', 'Valcreux', 'Pierrefonte', 'Clairmarais', 'Roqueterre',
  'Hautbois', 'Fontgrise', 'Bellerive', 'Montnoir', 'Sauveterre', 'Longpré', 'Vieux-Gué'];
function nomDeVille(etat, peuple) {
  const deja = new Set((etat.villes || []).map((v) => v.nom));
  const libre = NOMS_VILLES.find((n) => !deja.has(n));
  return libre || `Colonie ${(etat.villes || []).filter((v) => v.peuple === peuple).length + 1}`;
}

/**
 * Les cases réellement exploitées par une ville : la case centrale, plus les
 * meilleures de son territoire, à raison d'une par habitant. C'est ce qui fait
 * qu'agrandir une ville rapporte, et qu'un bon emplacement vaut mieux qu'un grand.
 */
export function casesExploitees(etat, tuiles, ville) {
  const centre = tuiles[tileKey(ville.q, ville.r)];
  const autour = disque(ville.q, ville.r, ville.rayon)
    .map(([q, r]) => tuiles[tileKey(q, r)])
    .filter((t) => t && t !== centre && t.proprietaire === ville.peuple && !t.ville)
    .sort((a, b) => {
      const ya = rendements(a), yb = rendements(b);
      return (yb.f * 2 + yb.p * 1.6 + yb.o) - (ya.f * 2 + ya.p * 1.6 + ya.o);
    });
  return [centre, ...autour.slice(0, ville.pop)].filter(Boolean);
}

/** Ce que la ville rapporte ce tour-ci, bâtiments compris. */
export function revenusVille(etat, tuiles, ville) {
  const cases = casesExploitees(etat, tuiles, ville);
  // La case centrale est aménagée : elle a un plancher. Sans lui, une capitale
  // tombée sur des collines aurifères affichait zéro surplus et ne grandissait
  // jamais — le joueur voyait de l'or s'entasser sans qu'il se passe rien.
  const centre = rendements(cases[0]);
  let f = Math.max(centre.f, 2), p = Math.max(centre.p, 1), o = centre.o;
  if (ville.capitale) { f += 1; p += 1; o += 2; }
  cases.slice(1).forEach((t) => {
    const y = rendements(t);
    f += y.f; p += y.p; o += y.o;
  });
  const b = ville.batiments || [];
  if (b.includes('grenier')) f = Math.round(f * 1.4);
  if (b.includes('atelier')) p = Math.round(p * 1.3);
  if (b.includes('marche')) o += 3;
  if (ville.peuple === JOUEUR) {
    f = Math.round(f * bonusEdits(etat, 'nourriture'));
    p = Math.round(p * bonusEdits(etat, 'production'));
    o = Math.round(o * bonusEdits(etat, 'or'));
  }
  const science = 1 + ville.pop + (b.includes('bibliotheque') ? 3 : 0);
  const culture = 1 + (b.includes('temple') ? 3 : 0);
  const entretien = b.reduce((a, k) => a + (BATIMENTS[k] ? BATIMENTS[k].or : 0), 0);
  const nourritureConsommee = ville.pop * 2;
  return { f, p, o, science, culture, entretien,
           surplus: f - nourritureConsommee, orNet: o - entretien };
}

// ---------- Journal et marques ------------------------------------------------
// Le journal est la mémoire du joueur entre deux sessions : sans lui, revenir
// après deux jours ne raconte rien.
export function noter(etat, texte, genre = 'info') {
  etat.journal = etat.journal || [];
  etat.journal.unshift({ t: Date.now(), tour: etat.tour, texte, genre });
  if (etat.journal.length > 60) etat.journal.length = 60;
}
function poserMarque(etat, q, r, genre) {
  etat.marques = etat.marques || [];
  etat.marques.unshift({ q, r, genre, tour: etat.tour });
  if (etat.marques.length > 14) etat.marques.length = 14;
}
/** Les faits de guerre des trois derniers tours : au-delà, ce n'est plus une nouvelle. */
export function marquesRecentes(etat) {
  return (etat.marques || []).filter((m) => etat.tour - m.tour <= 3);
}

// ---------- Unités ------------------------------------------------------------
export function creerUnite(etat, q, r, type, peuple = JOUEUR) {
  const modele = UNITES[type];
  if (!modele) return null;
  etat.seqUnite = (etat.seqUnite || 0) + 1;
  const u = {
    id: 'u' + etat.seqUnite, type, peuple, q, r,
    pv: modele.pv, pvMax: modele.pv,
    mp: modele.mp, mpMax: modele.mp,
    fortifie: false,
  };
  etat.unites = etat.unites || [];
  etat.unites.push(u);
  return u;
}
export function uniteEn(etat, q, r) { return (etat.unites || []).find((u) => u.q === q && u.r === r); }
export function uniteParId(etat, id) { return (etat.unites || []).find((u) => u.id === id); }
export function unitesDe(etat, peuple = JOUEUR) { return (etat.unites || []).filter((u) => u.peuple === peuple); }

/** Une case est-elle traversable par cette unité ? */
function libre(etat, tuiles, u, q, r) {
  const t = tuiles[tileKey(q, r)];
  if (!t || !franchissable(t)) return false;
  const occupant = uniteEn(etat, q, r);
  if (occupant && occupant.peuple === u.peuple) return false;   // une unité par case
  return true;
}

/**
 * Les cases atteignables, avec leur coût et ce qui s'y passera. Un parcours en
 * largeur pondéré : la forêt et la montagne coûtent plus cher, ce qui rend le
 * relief tactique au lieu d'être décoratif.
 */
export function portee(etat, tuiles, u) {
  const depart = tileKey(u.q, u.r);
  const vus = new Map([[depart, { q: u.q, r: u.r, cout: 0, attaque: false }]]);
  const file = [{ q: u.q, r: u.r, reste: u.mp }];
  while (file.length) {
    const cur = file.shift();
    neighbors(cur.q, cur.r).forEach(([nq, nr]) => {
      const t = tuiles[tileKey(nq, nr)];
      if (!t || !franchissable(t)) return;
      const cout = TERRAINS[t.terrain].cout;
      if (cout > cur.reste) return;
      const cle = tileKey(nq, nr);
      const occupant = uniteEn(etat, nq, nr);
      const villeIci = t.ville ? (etat.villes || []).find((v) => v.id === t.ville) : null;
      const hostile = (occupant && occupant.peuple !== u.peuple)
                   || (villeIci && villeIci.peuple !== u.peuple);
      if (hostile) {
        // On peut frapper une case hostile adjacente, mais pas la traverser.
        if (!vus.has(cle) || vus.get(cle).cout > u.mp - cur.reste + cout) {
          vus.set(cle, { q: nq, r: nr, cout: u.mp - cur.reste + cout, attaque: true });
        }
        return;
      }
      if (occupant && occupant.peuple === u.peuple) return;
      const total = u.mp - cur.reste + cout;
      if (!vus.has(cle) || vus.get(cle).cout > total) {
        vus.set(cle, { q: nq, r: nr, cout: total, attaque: false });
        file.push({ q: nq, r: nr, reste: cur.reste - cout });
      }
    });
  }
  vus.delete(depart);
  return vus;
}

// ---------- Combat ------------------------------------------------------------
/**
 * Combat à points de vie, comme dans les Civilization modernes : les deux camps
 * encaissent, personne ne disparaît d'un coup, et une unité blessée reste sur la
 * carte. Une résolution en tout ou rien rendait chaque assaut incompréhensible :
 * on perdait une armée sans savoir de combien on s'était trompé.
 */
export function degats(attaque, defense) {
  const ratio = Math.max(0.2, Math.min(5, attaque / Math.max(1, defense)));
  return Math.max(6, Math.round(30 * Math.pow(ratio, 1.4)));
}

/** Force d'attaque effective, bonus d'heures compris. */
export function forceAttaque(etat, u, bonusPct = 0) {
  const m = UNITES[u.type];
  const blesse = 0.5 + 0.5 * (u.pv / u.pvMax);      // une unité à moitié morte frappe moins fort
  const edits = u.peuple === JOUEUR ? bonusEdits(etat, 'combat') : 1;
  return m.atk * blesse * (1 + bonusPct / 100) * edits;
}

/** Force de défense effective : terrain, fortification, murailles. */
export function forceDefense(etat, tuiles, u, ville = null) {
  const m = UNITES[u.type];
  const t = tuiles[tileKey(u.q, u.r)];
  let pct = t ? TERRAINS[t.terrain].def : 0;
  if (u.fortifie) pct += 25;
  if (ville && (ville.batiments || []).includes('muraille')) pct += 60;
  const blesse = 0.5 + 0.5 * (u.pv / u.pvMax);
  return m.def * blesse * (1 + pct / 100);
}

/** Défense d'une ville sans garnison : elle n'est pas libre à prendre. */
export function defenseVille(etat, tuiles, ville) {
  const t = tuiles[tileKey(ville.q, ville.r)];
  let pct = t ? TERRAINS[t.terrain].def : 0;
  if ((ville.batiments || []).includes('muraille')) pct += 60;
  if (ville.capitale) pct += 30;
  // Une ville doit demander un siège, pas trois coups d'épée. Avec une défense
  // de base faible, un guerrier isolé prenait une capitale en trois tours et la
  // partie était finie avant d'avoir commencé.
  return (20 + ville.pop * 4) * (1 + pct / 100);
}

// ---------- Ordres du joueur --------------------------------------------------
/** Déplace une unité, ou l'envoie au combat si la case visée est hostile. */
export function deplacer(etat, tuiles, idUnite, q, r, bonusPct = 0, rng = Math.random) {
  const u = uniteParId(etat, idUnite);
  if (!u) return { ok: false, error: 'Unité inconnue.' };
  if (u.peuple !== JOUEUR) return { ok: false, error: 'Cette unité ne vous appartient pas.' };
  const cible = portee(etat, tuiles, u).get(tileKey(q, r));
  if (!cible) return { ok: false, error: 'Hors de portée pour ce tour.' };

  if (!cible.attaque) {
    u.q = q; u.r = r;
    u.mp = Math.max(0, u.mp - cible.cout);
    u.fortifie = false;
    explorerAutour(etat, tuiles, q, r, UNITES[u.type].vue || 2);
    return { ok: true, deplace: true };
  }
  return attaquer(etat, tuiles, u, q, r, bonusPct, rng);
}

/** Un assaut : sur une unité, ou sur une ville quand la case n'est pas défendue. */
export function attaquer(etat, tuiles, u, q, r, bonusPct = 0, rng = Math.random) {
  const t = tuiles[tileKey(q, r)];
  const defenseur = uniteEn(etat, q, r);
  const ville = t && t.ville ? (etat.villes || []).find((v) => v.id === t.ville) : null;
  if (UNITES[u.type].atk <= 0) return { ok: false, error: `Un ${UNITES[u.type].label.toLowerCase()} ne se bat pas.` };

  const siege = ville ? (UNITES[u.type].siege || 1) : 1;
  const atk = forceAttaque(etat, u, bonusPct) * siege;

  if (defenseur) {
    const def = forceDefense(etat, tuiles, defenseur, ville);
    const subit = degats(atk, def);
    const rend = Math.round(degats(def, atk) * 0.6);      // la riposte fait moins mal
    defenseur.pv -= subit;
    u.pv -= rend;
    u.mp = 0; u.fortifie = false;
    const res = { ok: true, combat: true, subit, rend, cible: UNITES[defenseur.type].label };
    if (defenseur.pv <= 0) {
      etat.unites = etat.unites.filter((x) => x.id !== defenseur.id);
      res.tue = true;
      if (u.peuple === JOUEUR) etat.stats.combatsGagnes = (etat.stats.combatsGagnes || 0) + 1;
      noter(etat, `${UNITES[defenseur.type].label} ${peupleById(defenseur.peuple).nom} détruit.`,
            u.peuple === JOUEUR ? 'bien' : 'mal');
      poserMarque(etat, q, r, u.peuple === JOUEUR ? 'victoire' : 'perte');
    }
    if (u.pv <= 0) {
      etat.unites = etat.unites.filter((x) => x.id !== u.id);
      res.perdu = true;
      if (u.peuple === JOUEUR) etat.stats.unitesPerdues = (etat.stats.unitesPerdues || 0) + 1;
      poserMarque(etat, u.q, u.r, u.peuple === JOUEUR ? 'perte' : 'victoire');
    }
    return res;
  }

  if (ville && ville.peuple !== u.peuple) {
    const def = defenseVille(etat, tuiles, ville);
    const subit = degats(atk, def);
    ville.pv = (ville.pv == null ? 100 : ville.pv) - subit;
    u.mp = 0; u.fortifie = false;
    if (ville.pv <= 0) { return { ok: true, ...prendreVille(etat, tuiles, ville, u.peuple), combat: true, subit }; }
    return { ok: true, combat: true, subit, rend: 0, cible: ville.nom, villePv: ville.pv };
  }
  return { ok: false, error: 'Rien à attaquer ici.' };
}

/** La prise d'une ville : elle change de camp, amoindrie. */
function prendreVille(etat, tuiles, ville, peuple) {
  const ancien = ville.peuple;
  ville.peuple = peuple;
  // Une capitale prise cesse d'en être une : le vainqueur garde la sienne.
  // Sans cette ligne, un conquérant accumulait les capitales — cinquante pour
  // un seul peuple — plus aucune ville ne pouvait faire sécession, et le monde
  // se figeait définitivement autour de lui.
  if (ville.capitale) {
    ville.capitale = (etat.villes || []).some((v) => v.peuple === peuple && v.capitale && v !== ville)
      ? false : true;
  }
  ville.pv = 60;
  ville.pop = Math.max(1, Math.floor(ville.pop * 0.6));
  ville.chantier = null; ville.production = 0;
  ville.batiments = (ville.batiments || []).filter((b) => b !== 'muraille');
  disque(ville.q, ville.r, ville.rayon).forEach(([q, r]) => {
    const t = tuiles[tileKey(q, r)];
    if (t && t.proprietaire === ancien) { t.proprietaire = peuple; marquer(etat, t); }
  });
  const t = tuiles[tileKey(ville.q, ville.r)];
  if (t) { t.proprietaire = peuple; marquer(etat, t); }
  if (peuple === JOUEUR) etat.stats.villesPrises = (etat.stats.villesPrises || 0) + 1;
  poserMarque(etat, ville.q, ville.r, peuple === JOUEUR ? 'victoire' : 'perte');
  noter(etat, peuple === JOUEUR
    ? `${ville.nom} est prise !`
    : `${ville.nom} est tombée aux mains ${deQui(ancien === JOUEUR ? peuple : peuple)}.`,
    peuple === JOUEUR ? 'bien' : 'mal');
  verifierMonde(etat, tuiles);
  return { villePrise: ville.nom, ancien };
}
function deQui(id) { return 'de ' + peupleById(id).nom; }

export function fortifier(etat, idUnite) {
  const u = uniteParId(etat, idUnite);
  if (!u) return { ok: false, error: 'Unité inconnue.' };
  u.fortifie = true; u.mp = 0;
  return { ok: true };
}

// ---------- Actions de gestion ------------------------------------------------
export function fonderIci(etat, tuiles, idUnite) {
  const u = uniteParId(etat, idUnite);
  if (!u) return { ok: false, error: 'Unité inconnue.' };
  if (!UNITES[u.type].fonde) return { ok: false, error: 'Seul un colon fonde une ville.' };
  const test = peutFonder(etat, tuiles, u.q, u.r, u.peuple);
  if (!test.ok) return { ok: false, error: test.raison };
  const res = fonderVille(etat, tuiles, u.q, u.r, u.peuple);
  if (res.ok) etat.unites = etat.unites.filter((x) => x.id !== u.id);   // le colon devient la ville
  return res;
}

export function mettreEnChantier(etat, ville, genre, cle) {
  const source = genre === 'unite' ? UNITES[cle] : BATIMENTS[cle];
  if (!source) return { ok: false, error: 'Chantier inconnu.' };
  ville.chantier = { genre, cle, cout: source.cout };
  return { ok: true };
}

export function choisirRecherche(etat, cle) {
  if (EDITS[cle]) { etat.recherche = cle; return { ok: true }; }
  if (!TECHS[cle]) return { ok: false, error: 'Technologie inconnue.' };
  if ((etat.techs || []).includes(cle)) return { ok: false, error: 'Déjà acquise.' };
  const manque = TECHS[cle].requiert.filter((r) => !(etat.techs || []).includes(r));
  if (manque.length) return { ok: false, error: `Il faut d’abord ${manque.map((k) => TECHS[k].label).join(' et ')}.` };
  etat.recherche = cle;
  return { ok: true };
}

// ---------- Le tour -----------------------------------------------------------
/**
 * Recharge la réserve de tours en fonction du temps réel écoulé et des heures
 * facturées. C'est le seul lien du jeu vers le suivi du temps, et il ne va que
 * dans ce sens : encoder donne des tours, jouer ne touche à aucune heure.
 */
export function rechargerTours(etat, heuresFacturees = 0, maintenant = Date.now()) {
  const avant = etat.tours;
  const ecoule = Math.max(0, maintenant - (etat.dernierRecharge ?? maintenant));
  const gagnes = Math.floor(ecoule / MS_PAR_TOUR);
  if (gagnes > 0) {
    etat.tours = Math.min(TOURS_MAX, etat.tours + gagnes);
    etat.dernierRecharge = (etat.dernierRecharge ?? maintenant) + gagnes * MS_PAR_TOUR;
  }
  // Les heures déjà converties sont mémorisées : sinon le même total en
  // redonnerait à chaque ouverture de la page.
  const dus = Math.floor(heuresFacturees) * TOURS_PAR_HEURE;
  const nouveaux = Math.max(0, dus - (etat.toursAccordes || 0));
  if (nouveaux > 0) {
    etat.tours = Math.min(TOURS_MAX + nouveaux, etat.tours + nouveaux);
    etat.toursAccordes = dus;
    noter(etat, `+${nouveaux} tour${nouveaux > 1 ? 's' : ''} — vos heures facturées.`, 'bien');
  }
  return etat.tours - avant;
}

/** Bonus de combat tiré des paliers du contrat. Lecture seule, toujours. */
export function bonusHeures(heuresMois, socle = 25, garantie = 43.75) {
  if (heuresMois >= garantie) return { pct: 20, label: 'Minimum garanti atteint' };
  if (heuresMois >= socle) return { pct: 10, label: 'Socle atteint' };
  return { pct: 0, label: 'Sous le socle' };
}

/** Joue un tour complet : vos villes, la recherche, puis les rivaux. */
export function finirTour(etat, tuiles, rng = Math.random) {
  if ((etat.tours || 0) <= 0) return { ok: false, error: 'Plus de tour disponible. Ils se rechargent avec le temps, et vos heures facturées en donnent.' };
  etat.tours -= 1;
  etat.tour += 1;

  const resume = { produits: [], grandies: [], tech: null, or: 0, science: 0 };

  // 1. Les villes de tout le monde produisent.
  (etat.villes || []).forEach((v) => {
    const rev = revenusVille(etat, tuiles, v);
    if (v.peuple === JOUEUR) { etat.or += rev.orNet; resume.or += rev.orNet; }

    v.nourriture += rev.surplus;
    if (v.nourriture < 0) {
      // Famine : la ville rétrécit plutôt que de sombrer d'un coup.
      if (v.pop > 1) { v.pop -= 1; v.nourriture = 0; if (v.peuple === JOUEUR) noter(etat, `${v.nom} souffre de la faim.`, 'mal'); }
      else v.nourriture = 0;
    } else if (v.nourriture >= seuilCroissance(v.pop)) {
      v.nourriture = 0; v.pop += 1;
      if (v.peuple === JOUEUR) resume.grandies.push(v.nom);
    }

    v.culture = (v.culture || 0) + rev.culture;
    if (v.rayon < RAYON_MAX && v.culture >= seuilFrontiere(v.rayon)) {
      v.culture = 0; v.rayon += 1;
      etendreFrontiere(etat, tuiles, v);
    }

    if (v.pv < 100) v.pv = Math.min(100, v.pv + (v.peuple === JOUEUR ? 16 : 8));   // vos murs se relèvent plus vite

    let prod = rev.p;
    if (v.chantier && v.chantier.genre === 'unite' && (v.batiments || []).includes('caserne')) prod = Math.round(prod * 1.25);
    if (v.chantier) {
      v.production += prod;
      if (v.production >= v.chantier.cout) {
        v.production -= v.chantier.cout;
        const fait = v.chantier;
        if (fait.genre === 'unite') {
          const place = caseLibreAutour(etat, tuiles, v);
          if (place) creerUnite(etat, place.q, place.r, fait.cle, v.peuple);
        } else {
          v.batiments = [...(v.batiments || []), fait.cle];
        }
        if (v.peuple === JOUEUR) {
          resume.produits.push(`${v.nom} · ${fait.genre === 'unite' ? UNITES[fait.cle].label : BATIMENTS[fait.cle].label}`);
        }
        v.chantier = null;
      }
    }

    if (v.peuple === JOUEUR) { etat.science += rev.science; resume.science += rev.science; }
  });

  // 2. La recherche avance.
  if (etat.recherche) {
    etat.progresRecherche += resume.science;
    if (EDITS[etat.recherche]) {
      const cout = coutEdit(etat, etat.recherche);
      if (etat.progresRecherche >= cout) {
        etat.progresRecherche -= cout;
        etat.edits = { ...(etat.edits || {}) };
        etat.edits[etat.recherche] = nbEdits(etat, etat.recherche) + 1;
        resume.tech = `${EDITS[etat.recherche].label} (${etat.edits[etat.recherche]})`;
        noter(etat, `${EDITS[etat.recherche].label} promulgué pour la ${etat.edits[etat.recherche]}ᵉ fois.`, 'bien');
      }
    } else if (!(etat.techs || []).includes(etat.recherche)) {
      const cible = TECHS[etat.recherche];
      if (cible && etat.progresRecherche >= cible.cout) {
        etat.progresRecherche -= cible.cout;
        etat.techs = [...(etat.techs || []), etat.recherche];
        resume.tech = cible.label;
        noter(etat, `${cible.label} découverte.`, 'bien');
        const suite = techsDisponibles(etat)[0];
        etat.recherche = suite ? suite.cle : 'edit_labour';
      }
    }
  }

  // 3. Les unités se reposent.
  (etat.unites || []).forEach((u) => {
    u.mp = u.mpMax;
    if (u.pv < u.pvMax) u.pv = Math.min(u.pvMax, u.pv + (u.fortifie ? 15 : 8));
  });

  // 4. Les rivaux jouent.
  tourDesRivaux(etat, tuiles, rng);
  secessions(etat, tuiles, rng);
  etendreMonde(etat, tuiles);
  verifierMonde(etat, tuiles);
  return { ok: true, resume };
}

function etendreFrontiere(etat, tuiles, ville) {
  disque(ville.q, ville.r, ville.rayon).forEach(([q, r]) => {
    const t = tuiles[tileKey(q, r)];
    if (t && !t.proprietaire) { t.proprietaire = ville.peuple; marquer(etat, t); }
  });
  if (ville.peuple === JOUEUR) explorerAutour(etat, tuiles, ville.q, ville.r, ville.rayon);
}

function caseLibreAutour(etat, tuiles, ville) {
  const ici = tuiles[tileKey(ville.q, ville.r)];
  if (!uniteEn(etat, ville.q, ville.r)) return ici;
  const n = neighbors(ville.q, ville.r)
    .map(([q, r]) => tuiles[tileKey(q, r)])
    .find((t) => t && franchissable(t) && !uniteEn(etat, t.q, t.r));
  return n || null;
}

// ---------- Les rivaux --------------------------------------------------------
/**
 * Une IA simple mais qui fait les bonnes choses dans le bon ordre : elle
 * construit, elle colonise, elle masse des troupes, puis elle marche sur la
 * ville la plus proche. Un adversaire qui reste chez lui n'est qu'un décor —
 * c'est la leçon de la version précédente.
 */
function tourDesRivaux(etat, tuiles, rng) {
  PEUPLES.filter((p) => p.ia && !(etat.vaincus || []).includes(p.id)).forEach((p) => {
    const mesVilles = villesDe(etat, p.id);
    if (!mesVilles.length) return;

    // Chantiers : un colon tant qu'on a moins de trois villes, sinon des troupes.
    mesVilles.forEach((v) => {
      if (v.chantier) return;
      const militaires = unitesDe(etat, p.id).filter((u) => UNITES[u.type].atk > 0).length;
      const colonsEnRoute = unitesDe(etat, p.id).filter((u) => UNITES[u.type].fonde).length;
      // Sans plafond, les trois rivaux montaient à treize villes contre une :
      // le joueur n'avait plus une partie à jouer mais un rouleau compresseur
      // à regarder. Trois villes chacun, c'est un adversaire, pas un raz-de-marée.
      if (mesVilles.length + colonsEnRoute < IA_VILLES_MAX && rng() < 0.4) mettreEnChantier(etat, v, 'unite', 'colon');
      else if (militaires < 2 + mesVilles.length) {
        const dispo = ['guerrier', 'archer', 'cavalier']
          .filter((k) => !UNITES[k].tech || rng() < 0.4);
        mettreEnChantier(etat, v, 'unite', dispo[Math.floor(rng() * dispo.length)] || 'guerrier');
      } else if (!(v.batiments || []).includes('grenier')) mettreEnChantier(etat, v, 'batiment', 'grenier');
      else mettreEnChantier(etat, v, 'unite', 'guerrier');
    });

    // Les unités agissent.
    unitesDe(etat, p.id).forEach((u) => {
      if (!uniteParId(etat, u.id)) return;          // morte entre-temps
      if (UNITES[u.type].fonde) { iaColoniser(etat, tuiles, u, rng); return; }
      if (UNITES[u.type].atk <= 0) return;
      iaMarcher(etat, tuiles, u, rng);
    });
  });
}

function iaColoniser(etat, tuiles, u, rng) {
  const test = peutFonder(etat, tuiles, u.q, u.r, u.peuple);
  if (test.ok && hexDistance(u.q, u.r, 0, 0) < RAYON_CARTE) {
    const res = fonderVille(etat, tuiles, u.q, u.r, u.peuple);
    if (res.ok) etat.unites = etat.unites.filter((x) => x.id !== u.id);
    return;
  }
  // Sinon on s'éloigne de ses propres villes, là où il y a la place.
  const pas = [...portee(etat, tuiles, u).values()].filter((c) => !c.attaque);
  if (!pas.length) return;
  const sienne = villesDe(etat, u.peuple);
  pas.sort((a, b) => distMin(sienne, b) - distMin(sienne, a));
  const choix = pas[Math.floor(rng() * Math.min(3, pas.length))];
  u.q = choix.q; u.r = choix.r; u.mp = 0;
}

export const TOUR_PAIX = 14;      // avant ça, les rivaux s'installent au lieu d'attaquer
export const IA_VILLES_MAX = 3;   // chaque rival plafonne à trois villes

function iaMarcher(etat, tuiles, u, rng) {
  // Cible : la ville ennemie la plus proche. Le joueur en fait partie, mais les
  // clans se battent aussi entre eux — un monde où tout converge sur le joueur
  // sonne faux. Et pendant les premiers tours, personne ne marche sur vous :
  // trois armées sur la capitale au tour dix ne laissait aucune partie exister.
  const paix = etat.tour < TOUR_PAIX;
  const cibles = (etat.villes || [])
    .filter((v) => v.peuple !== u.peuple && !(paix && v.peuple === JOUEUR));
  if (!cibles.length) { u.fortifie = true; u.mp = 0; return; }

  let cible = cibles[0], d = Infinity;
  cibles.forEach((v) => {
    const dd = hexDistance(u.q, u.r, v.q, v.r) + (v.peuple === JOUEUR ? -1 : 0);
    if (dd < d) { d = dd; cible = v; }
  });

  const atteignables = portee(etat, tuiles, u);
  // Une case hostile à portée : on frappe.
  const assauts = [...atteignables.values()].filter((c) => c.attaque)
    .filter((c) => !(paix && estAuJoueur(etat, tuiles, c.q, c.r)));
  if (assauts.length) {
    assauts.sort((a, b) => hexDistance(a.q, a.r, cible.q, cible.r) - hexDistance(b.q, b.r, cible.q, cible.r));
    const cd = assauts[0];
    if (u.pv > u.pvMax * 0.35) { attaquer(etat, tuiles, u, cd.q, cd.r, 0, rng); return; }
  }
  // Trop amoché : on se fortifie et on soigne.
  if (u.pv < u.pvMax * 0.35) { u.fortifie = true; u.mp = 0; return; }

  const pas = [...atteignables.values()].filter((c) => !c.attaque);
  if (!pas.length) return;
  pas.sort((a, b) => hexDistance(a.q, a.r, cible.q, cible.r) - hexDistance(b.q, b.r, cible.q, cible.r));
  const choix = pas[0];
  u.q = choix.q; u.r = choix.r; u.mp = 0; u.fortifie = false;
}

/** La case appartient-elle au joueur, par sa ville ou par son unité ? */
function estAuJoueur(etat, tuiles, q, r) {
  const u = uniteEn(etat, q, r);
  if (u) return u.peuple === JOUEUR;
  const t = tuiles[tileKey(q, r)];
  const v = t && t.ville ? (etat.villes || []).find((x) => x.id === t.ville) : null;
  return !!v && v.peuple === JOUEUR;
}

function distMin(villes, c) {
  return villes.reduce((m, v) => Math.min(m, hexDistance(v.q, v.r, c.q, c.r)), Infinity);
}

// ---------- Fin de partie -----------------------------------------------------
/**
 * Il n'y a ni victoire ni défaite : la partie se joue pendant des mois à côté
 * des heures encodées, et un écran de fin l'arrêterait net. Soumettre un peuple
 * est un jalon, pas une conclusion — un autre se lève, et l'horizon recule.
 */
export function verifierMonde(etat, tuiles = null) {
  rivauxConnus(etat).forEach((id) => {
    if ((etat.vaincus || []).includes(id)) return;
    if ((etat.villes || []).some((v) => v.peuple === id && v.capitale)) return;
    // Sa capitale a changé de main : le vainqueur est celui qui la tient. Sans
    // cela, une capitale prise par un clan adverse faisait tomber tout son
    // domaine dans votre escarcelle sans que vous y soyez pour rien.
    const ancienne = (etat.villes || []).find((v) => v.fondateur === id && v.capitale);
    const vainqueur = ancienne ? ancienne.peuple : JOUEUR;
    etat.vaincus = [...(etat.vaincus || []), id];
    const restantes = villesDe(etat, id);
    restantes.forEach((v) => {
      v.peuple = vainqueur;
      if (tuiles) {
        disque(v.q, v.r, v.rayon).forEach(([q, r]) => {
          const t = tuiles[tileKey(q, r)];
          if (t && t.proprietaire === id) { t.proprietaire = vainqueur; marquer(etat, t); }
        });
      }
    });
    if (vainqueur === JOUEUR) {
      etat.stats.peuplesSoumis = (etat.stats.peuplesSoumis || 0) + 1;
      noter(etat, restantes.length
        ? `${peupleById(id).nom} capitule : ${restantes.length} ville${restantes.length > 1 ? 's' : ''} rejoignent votre bannière.`
        : `${peupleById(id).nom} est soumis.`, 'bien');
    } else {
      noter(etat, `${peupleById(id).nom} tombe sous la coupe de ${peupleById(vainqueur).nom}.`, 'mal');
    }
  });

  // Votre cour se déplace plutôt que de disparaître : perdre sa capitale ne doit
  // pas vous effacer de la carte comme un rival.
  const miennes = villesDe(etat, JOUEUR);
  if (miennes.length && !miennes.some((v) => v.capitale)) {
    const nouvelle = miennes.slice().sort((a, b) => b.pop - a.pop)[0];
    nouvelle.capitale = true;
    noter(etat, `La cour se replie sur ${nouvelle.nom}, qui devient votre capitale.`, 'info');
  }
  if (tuiles && !miennes.length) exil(etat, tuiles);
  if (tuiles) leverUnPeuple(etat, tuiles);
}

/** Les peuples adverses déjà entrés dans la partie. */
function rivauxConnus(etat) {
  return [...new Set([...PEUPLES.filter((p) => p.ia).map((p) => p.id), ...(etat.peuplesLeves || [])])];
}

/**
 * Les derniers fidèles repartent avec un colon. Une partie perdue pour de bon
 * serait une partie qu'on ne rouvre plus — exactement ce qu'on ne veut pas d'un
 * compagnon qu'on ouvre tous les jours.
 */
function exil(etat, tuiles) {
  if (unitesDe(etat).some((u) => UNITES[u.type].fonde)) return;
  const libres = Object.values(tuiles).filter((t) => franchissable(t) && !t.ville
    && !t.proprietaire && !uniteEn(etat, t.q, t.r) && t.terrain !== 'montagne');
  if (!libres.length) return;
  const rng = mulberry32(hashSeed(etat.graine + ':exil' + etat.tour));
  const t = libres[Math.floor(rng() * libres.length)];
  poserDepart(etat, tuiles, t, ['colon', 'guerrier'], JOUEUR);
  etat.stats.exils = (etat.stats.exils || 0) + 1;
  noter(etat, 'Vos derniers fidèles ont fui vers des terres libres. Refondez une ville.', 'mal');
}

/** Choisit un peuple qui n'a pas encore paru, du vivier ou engendré. */
function peupleNeuf(etat) {
  const deja = new Set([...PEUPLES.map((x) => x.id), ...(etat.peuplesLeves || [])]);
  const duVivier = VIVIER.find((x) => !deja.has(x.id));
  if (duVivier) return duVivier;
  for (let n = 0; n < 500; n++) {
    const cand = peupleEngendre(n);
    if (!deja.has(cand.id)) return cand;
  }
  return null;
}

/** Fait se lever un nouveau peuple tant qu'il en manque. */
function leverUnPeuple(etat, tuiles) {
  if (rivauxActifs(etat).length >= 3) return;
  const neuf = peupleNeuf(etat);
  if (!neuf) return;
  const rng = mulberry32(hashSeed(etat.graine + ':lever' + etat.tour));
  const cap = villesDe(etat)[0] || { q: 0, r: 0 };
  // On cherche loin de vous, puis on desserre : renoncer laissait le monde à un
  // seul empire, et il ne se passait plus rien du tout.
  for (const ecart of [5, 4, 3]) {
    for (let d = (etat.rayon || RAYON_CARTE) - 1; d >= 4; d--) {
      const ring = anneau(cap.q, cap.r, d);
      const depart = Math.floor(rng() * ring.length);
      for (let i = 0; i < ring.length; i++) {
        const [q, r] = ring[(depart + i) % ring.length];
        const site = meilleurSite(tuiles, q, r);
        if (!site || site.ville || site.hors) continue;
        if ((etat.villes || []).some((v) => hexDistance(v.q, v.r, site.q, site.r) < ecart)) continue;
        etat.peuplesLeves = [...(etat.peuplesLeves || []), neuf.id];
        fonderVille(etat, tuiles, site.q, site.r, neuf.id, neuf.nom.split(' ').pop(), true);
        poserDepart(etat, tuiles, site, ['guerrier', 'guerrier', 'archer', 'colon'], neuf.id);
        noter(etat, `${neuf.nom} se lève aux marches du monde.`, 'mal');
        return;
      }
    }
  }
}

export const VILLES_AVANT_SECESSION = 6;

/**
 * Les grands empires se fissurent. Sans cela, un rival chanceux monte à
 * cinquante villes, écrase tout ce qui se lève, et le monde se fige : plus
 * d'adversaire, plus rien à faire. Une sécession borne la boule de neige et
 * fournit un nouveau peuple de façon naturelle.
 *
 * Elle emporte toute une région, pas une ville isolée : un bourg seul face à un
 * empire de trente villes est repris au tour suivant, et la révolte ne servait
 * qu'à faire du bruit dans le journal.
 */
function secessions(etat, tuiles, rng) {
  rivauxActifs(etat).forEach((p) => {
    const siennes = villesDe(etat, p.id);
    if (siennes.length <= VILLES_AVANT_SECESSION) return;
    const risque = 0.10 + 0.05 * (siennes.length - VILLES_AVANT_SECESSION);
    if (rng() > Math.min(0.6, risque)) return;

    const capitale = siennes.find((v) => v.capitale) || siennes[0];
    const rebelle = siennes.filter((v) => !v.capitale)
      .sort((a, b) => hexDistance(b.q, b.r, capitale.q, capitale.r) - hexDistance(a.q, a.r, capitale.q, capitale.r))[0];
    if (!rebelle) return;
    const neuf = peupleNeuf(etat);
    if (!neuf) return;

    // La région qui se détache grandit avec l'empire : un rayon fixe de quatre
    // cases ne prélevait que deux ou trois villes sur cinquante, et la boule de
    // neige repartait aussitôt. Un empire tentaculaire perd une province entière.
    const rayonRegion = 3 + Math.floor(siennes.length / 5);
    const region = siennes.filter((v) => !v.capitale
      && hexDistance(v.q, v.r, rebelle.q, rebelle.r) <= rayonRegion);
    etat.peuplesLeves = [...(etat.peuplesLeves || []), neuf.id];
    region.forEach((v, i) => {
      v.peuple = neuf.id;
      v.fondateur = neuf.id;
      v.capitale = v === rebelle;
      disque(v.q, v.r, v.rayon).forEach(([q, r]) => {
        const t = tuiles[tileKey(q, r)];
        if (t && t.proprietaire === p.id) { t.proprietaire = neuf.id; marquer(etat, t); }
      });
      if (i < 3) creerUnite(etat, v.q, v.r, 'guerrier', neuf.id);
    });
    unitesDe(etat, p.id).forEach((u) => {
      if (hexDistance(u.q, u.r, rebelle.q, rebelle.r) <= 3 && rng() < 0.5) u.peuple = neuf.id;
    });
    noter(etat, `${neuf.nom} fait sécession : ${region.length} ville${region.length > 1 ? 's' : ''} se détachent de ${p.nom}.`, 'info');
  });
}

// ---------- Ce que l'interface demande ---------------------------------------
/**
 * Tout ce qu'on peut faire sur une case, prêt à être affiché. Chaque action
 * refusée porte sa raison : un bouton grisé sans explication est la première
 * cause du sentiment de ne rien pouvoir faire.
 */
export function actionsPour(etat, tuiles, t, uniteChoisie = null) {
  if (!t) return [];
  const out = [];
  const u = uniteChoisie ? uniteParId(etat, uniteChoisie) : null;
  const ici = uniteEn(etat, t.q, t.r);
  const ville = t.ville ? (etat.villes || []).find((v) => v.id === t.ville) : null;

  if (u && u.peuple === JOUEUR && u.q === t.q && u.r === t.r) {
    if (UNITES[u.type].fonde) {
      const test = peutFonder(etat, tuiles, t.q, t.r, JOUEUR);
      out.push({ genre: 'fonder', label: 'Fonder une ville', unite: u.id,
                 actif: test.ok, pourquoi: test.ok ? null : test.raison });
    }
    if (UNITES[u.type].atk > 0) {
      out.push({ genre: 'fortifier', label: u.fortifie ? 'Déjà fortifiée' : 'Fortifier', unite: u.id,
                 actif: !u.fortifie && u.mp > 0,
                 pourquoi: u.fortifie ? 'L’unité tient déjà la position'
                         : (u.mp <= 0 ? 'Plus de mouvement ce tour' : null) });
    }
  }

  if (ville && ville.peuple === JOUEUR) {
    out.push({ genre: 'ville', label: `Gérer ${ville.nom}`, ville: ville.id, actif: true });
  }

  if (u && u.peuple === JOUEUR && (u.q !== t.q || u.r !== t.r)) {
    const dest = portee(etat, tuiles, u).get(tileKey(t.q, t.r));
    if (dest) {
      out.push({
        genre: dest.attaque ? 'attaquer' : 'marcher',
        label: dest.attaque ? 'Attaquer' : 'Se déplacer ici',
        unite: u.id, actif: true,
        cout: dest.cout,
        cible: dest.attaque ? (ici ? UNITES[ici.type].label : (ville ? ville.nom : 'la case')) : null,
      });
    }
  }
  return out;
}

/** Ce qu'est cette case, en une phrase. */
export function situation(etat, tuiles, t) {
  if (!t) return '';
  if (!t.explore) return 'Territoire inexploré. Envoyez une unité y voir.';
  const ter = TERRAINS[t.terrain];
  const bouts = [ter.label];
  if (t.ressource) bouts.push(RESSOURCES[t.ressource].label);
  const ville = t.ville ? (etat.villes || []).find((v) => v.id === t.ville) : null;
  if (ville) bouts.push(`${ville.nom} · ${peupleById(ville.peuple).nom} · ${ville.pop} hab.`);
  else if (t.proprietaire) bouts.push(`Territoire ${peupleById(t.proprietaire).nom}`);
  if (ter.def) bouts.push(`défense +${ter.def} %`);
  return bouts.join(' · ');
}

// ---------- Objectifs ---------------------------------------------------------
// Ils répondent à « je fais quoi maintenant ? », qui est la question qui tue un
// jeu de stratégie quand elle reste sans réponse.
export const OBJECTIFS = [
  { cle: 'fonder2', label: 'Fonder une deuxième ville',
    fait: (e) => villesDe(e).length >= 2,
    aide: 'Sélectionnez un colon, marchez à trois cases de votre capitale, puis « Fonder une ville ».' },
  { cle: 'chantier', label: 'Mettre une ville en chantier',
    fait: (e) => villesDe(e).some((v) => v.chantier || (v.batiments || []).length),
    aide: 'Touchez une de vos villes, puis choisissez ce qu’elle construit.' },
  { cle: 'tech1', label: 'Découvrir une technologie',
    fait: (e) => (e.techs || []).length >= 1,
    aide: 'La recherche avance à chaque tour. Bâtissez une bibliothèque pour aller plus vite.' },
  { cle: 'fonder3', label: 'Porter l’empire à trois villes',
    fait: (e) => villesDe(e).length >= 3,
    aide: 'Produisez un colon dans une ville, puis fondez plus loin.' },
  { cle: 'armee', label: 'Lever trois unités de combat',
    fait: (e) => unitesDe(e).filter((u) => UNITES[u.type].atk > 0).length >= 3,
    aide: 'Mettez vos villes en chantier sur des guerriers ou des archers.' },
  { cle: 'premiere', label: 'Prendre une ville rivale',
    fait: (e) => ((e.stats || {}).villesPrises || 0) > 0,
    aide: 'Amenez deux ou trois unités sur une ville adverse : une seule ne suffit jamais.' },
  { cle: 'capitale', label: 'Soumettre un peuple',
    fait: (e) => ((e.stats || {}).peuplesSoumis || 0) >= 1,
    aide: 'Prenez sa capitale : le peuple capitule et ses villes rejoignent votre bannière.' },
];

/**
 * Passé la liste écrite à la main, les jalons continuent d'eux-mêmes. Le dernier
 * objectif d'une liste figée serait un mur, et c'est exactement ce qu'on ne veut
 * pas d'une partie qu'on rouvre pendant des mois à côté de ses heures.
 */
function jalonEngendre(n) {
  const rang = Math.floor(n / 2);
  if (n % 2 === 0) {
    const villes = 5 + rang * 3;
    return { cle: `villes${villes}`, label: `Porter l’empire à ${villes} villes`,
             fait: (e) => villesDe(e).length >= villes,
             aide: 'Fondez, ou prenez celles de vos voisins — les deux comptent.' };
  }
  const peuples = 2 + rang;
  return { cle: `peuples${peuples}`, label: `Soumettre ${peuples} peuples`,
           fait: (e) => ((e.stats || {}).peuplesSoumis || 0) >= peuples,
           aide: 'Un peuple soumis laisse la place à un autre : il y aura toujours un adversaire.' };
}

/** Le titre du domaine, qui monte sans plafond. */
export function titre(etat) {
  const v = villesDe(etat).length;
  const p = (etat.stats || {}).peuplesSoumis || 0;
  const paliers = ['Hameau', 'Bourg', 'Cité', 'Comté', 'Duché', 'Principauté', 'Royaume', 'Empire'];
  const niveau = Math.floor(v / 2) + p;
  if (niveau < paliers.length) return paliers[Math.max(0, niveau)];
  return `Empire · ${niveau - paliers.length + 2}ᵉ couronne`;
}

export function objectifCourant(etat) {
  const index = OBJECTIFS.findIndex((o) => !o.fait(etat));
  if (index >= 0) return { objectif: OBJECTIFS[index], index: index + 1, total: null };
  for (let n = 0; n < 400; n++) {
    const j = jalonEngendre(n);
    if (!j.fait(etat)) return { objectif: j, index: OBJECTIFS.length + n + 1, total: null };
  }
  return { objectif: null, index: OBJECTIFS.length, total: null };
}

// ---------- Les règles, écrites une seule fois --------------------------------
export const REGLES = [
  { titre: 'Le but',
    texte: 'Prendre les capitales des trois peuples rivaux. Quand une capitale tombe, le peuple capitule et ses villes rejoignent votre bannière.' },
  { titre: 'Des tours, pas une horloge',
    texte: 'Rien ne bouge sans vous : le monde n’avance que lorsque vous terminez un tour. Vous disposez d’une réserve de tours qui se recharge d’un tour toutes les 12 minutes — et chaque heure que vous facturez vous en donne deux de plus.' },
  { titre: 'Les villes font tout',
    texte: 'Une ville exploite ses cases : nourriture pour grandir, production pour bâtir, or pour tenir. Elle travaille une case de plus par habitant, et ses frontières s’étendent avec la culture.' },
  { titre: 'Fonder',
    texte: 'Un colon fonde une ville sur une case libre, à trois cases au moins d’une autre. C’est le geste le plus rentable du début de partie.' },
  { titre: 'Se battre',
    texte: 'Chaque unité a des points de vie. On attaque en amenant une unité sur une case ennemie ; les deux camps encaissent. Le terrain compte : une colline défend mieux qu’une plaine, et une muraille change tout.' },
  { titre: 'Les villes ne tombent pas seules',
    texte: 'Une ville se défend même sans garnison et répare ses murs chaque tour. Il faut plusieurs unités, ou un bélier, pour en venir à bout — c’est vrai pour vous comme pour vos rivaux.' },
  { titre: 'Vos heures comptent',
    texte: 'Elles ne donnent que des tours et un bonus d’assaut : +10 % au socle des 25 h, +20 % au minimum garanti. Le jeu ne modifie jamais vos heures, vos projets ni votre facturation.' },
];

// ---------- « Je fais quoi, là, maintenant ? » --------------------------------
/**
 * Le geste suivant, un seul, avec la case à regarder. Un objectif comme
 * « fonder une deuxième ville » ne dit pas OÙ est le colon ni quoi toucher :
 * sur un téléphone, retrouver un pion de trois millimètres parmi deux cent
 * soixante-et-onze hexagones est un jeu en soi, et ce n'est pas celui-là qu'on
 * voulait faire jouer.
 */
export function prochaineAction(etat, tuiles) {
  const mesVilles = villesDe(etat);
  if (!mesVilles.length) return { texte: 'Vous n’avez plus de ville.', cible: null };

  // 1. Un colon posé sur un site valide : c'est LE coup à jouer.
  const colons = unitesDe(etat).filter((u) => UNITES[u.type].fonde);
  const pret = colons.find((u) => peutFonder(etat, tuiles, u.q, u.r).ok);
  if (pret) {
    return { texte: 'Votre colon peut fonder une ville ici. Touchez-le, puis « Fonder une ville ».',
             cible: { q: pret.q, r: pret.r }, unite: pret.id, geste: 'fonder' };
  }
  // 2. Un colon qui n'est pas encore au bon endroit.
  if (colons.length && colons.some((u) => u.mp > 0)) {
    const u = colons.find((x) => x.mp > 0);
    const t = tuiles[tileKey(u.q, u.r)];
    const pourquoi = !t || !franchissable(t) ? 'il lui faut la terre ferme'
      : t.terrain === 'montagne' ? 'la montagne ne nourrit personne'
      : 'il faut trois cases entre deux villes';
    return { texte: `Éloignez votre colon — ${pourquoi}. Touchez-le : les cases bleues sont à sa portée.`,
             cible: { q: u.q, r: u.r }, unite: u.id, geste: 'deplacer' };
  }
  // 3. Une ville qui ne construit rien est une ville qui ne sert à rien.
  const oisive = mesVilles.find((v) => !v.chantier);
  if (oisive) {
    return { texte: `${oisive.nom} ne construit rien. Touchez la ville, puis choisissez un chantier.`,
             cible: { q: oisive.q, r: oisive.r }, ville: oisive.id, geste: 'chantier' };
  }
  // 4. Des unités qui n'ont pas bougé.
  const dormante = unitesDe(etat).find((u) => u.mp > 0 && !u.fortifie && UNITES[u.type].atk > 0);
  if (dormante) {
    return { texte: `${UNITES[dormante.type].label} n’a pas bougé. Déplacez-la, ou fortifiez-la pour tenir la position.`,
             cible: { q: dormante.q, r: dormante.r }, unite: dormante.id, geste: 'deplacer' };
  }
  // 5. Plus rien à faire : c'est le moment de finir le tour.
  return { texte: 'Tout est en ordre. Terminez le tour pour faire avancer le monde.', cible: null, geste: 'tour' };
}

/** Ce qui reste en suspens avant de finir un tour, pour ne pas le gâcher. */
export function enSuspens(etat, tuiles) {
  const villesSansChantier = villesDe(etat).filter((v) => !v.chantier).length;
  const unitesImmobiles = unitesDe(etat).filter((u) => u.mp >= u.mpMax && !u.fortifie).length;
  const bouts = [];
  if (villesSansChantier) bouts.push(`${villesSansChantier} ville${villesSansChantier > 1 ? 's' : ''} sans chantier`);
  if (unitesImmobiles) bouts.push(`${unitesImmobiles} unité${unitesImmobiles > 1 ? 's' : ''} qui n’${unitesImmobiles > 1 ? 'ont' : 'a'} pas bougé`);
  return { rien: bouts.length === 0, texte: bouts.join(' · '), villesSansChantier, unitesImmobiles };
}
