// =============================================================
// ⚔️  MOTEUR DE JEU · « Les Marches de Nessy »
// -------------------------------------------------------------
// 4X asynchrone : la production avance même application fermée. On ne stocke
// jamais de compteurs qui « tournent » — on stocke la date du dernier tour
// résolu et on rattrape le retard au chargement. C'est la seule façon d'être
// juste quel que soit l'appareil, et ça survit à une déconnexion.
//
// Ce fichier ne touche NI au DOM NI à Firestore : il transforme un état en un
// nouvel état. C'est ce qui le rend testable directement dans node.
// =============================================================

// ---------- Constantes de règles -----------------------------
export const TICK_MS = 10 * 60 * 1000;      // un tour de production = 10 minutes réelles
export const MAX_CATCHUP_TICKS = 144;       // on ne rattrape jamais plus de 24 h d'absence
export const MAP_RADIUS = 4;                // rayon de l'archipel en hexagones (61 tuiles)

export const TERRAINS = {
  prairie:  { label: 'Prairie',  or: 1, vivres: 2, def: 0,  color: '#7fb069' },
  foret:    { label: 'Forêt',    or: 1, vivres: 1, def: 15, color: '#4f7942' },
  colline:  { label: 'Colline',  or: 2, vivres: 1, def: 25, color: '#a89968' },
  montagne: { label: 'Montagne', or: 3, vivres: 0, def: 45, color: '#8b8178' },
  sable:    { label: 'Rivage',   or: 1, vivres: 1, def: 0,  color: '#e4d5a8' },
};

export const BUILDINGS = {
  ferme:    { label: 'Ferme',    cost: { or: 40 },  prod: { vivres: 3 }, terrains: ['prairie', 'sable'] },
  scierie:  { label: 'Scierie',  cost: { or: 55 },  prod: { or: 2, vivres: 1 }, terrains: ['foret'] },
  mine:     { label: 'Mine',     cost: { or: 70 },  prod: { or: 4 }, terrains: ['colline', 'montagne'] },
  caserne:  { label: 'Caserne',  cost: { or: 90 },  prod: {}, recrue: true, terrains: null },
  rempart:  { label: 'Rempart',  cost: { or: 65 },  prod: {}, def: 40, terrains: null },
};

// « Monter en grade » : le rang dépend du territoire tenu ET du travail encodé.
// Les deux comptent, pour qu'on ne puisse ni conquérir sans bosser ni l'inverse.
export const RANKS = [
  { key: 'hameau',    label: 'Hameau',    tiles: 1,  hours: 0 },
  { key: 'village',   label: 'Village',   tiles: 4,  hours: 10 },
  { key: 'bourg',     label: 'Bourg',     tiles: 8,  hours: 25 },
  { key: 'cite',      label: 'Cité',      tiles: 14, hours: 44 },
  { key: 'metropole', label: 'Métropole', tiles: 22, hours: 80 },
  { key: 'capitale',  label: 'Capitale',  tiles: 32, hours: 130 },
];

export const CLANS = [
  { key: 'ombre',  label: 'Clan de l’Ombre',  color: '#b4436c' },
  { key: 'cendre', label: 'Fils de Cendre',       color: '#c9752b' },
  { key: 'givre',  label: 'Marche de Givre',      color: '#3f8fb0' },
];

// ---------- Utilitaires --------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export const tileKey = (q, r) => `${q},${r}`;
export function hexDistance(aq, ar, bq, br) {
  return (Math.abs(aq - bq) + Math.abs(aq + ar - bq - br) + Math.abs(ar - br)) / 2;
}
export function neighbors(q, r) { return HEX_DIRS.map(([dq, dr]) => [q + dq, r + dr]); }

/** Position monde d'un hexagone « pointy-top », en unités de rayon. */
export function axialToWorld(q, r, size = 1) {
  return { x: size * Math.sqrt(3) * (q + r / 2), z: size * 1.5 * r };
}

// ---------- Génération du monde ------------------------------
/**
 * L'archipel est déterministe : la même graine redonne exactement la même carte.
 * Indispensable ici — on ne sauvegarde que la graine et les changements, pas les
 * 61 tuiles de terrain, ce qui garde le document Firestore minuscule.
 */
export function generateWorld(seedStr) {
  const rng = mulberry32(hashSeed(seedStr));
  const tiles = {};
  const list = [];
  for (let q = -MAP_RADIUS; q <= MAP_RADIUS; q++) {
    for (let r = Math.max(-MAP_RADIUS, -q - MAP_RADIUS); r <= Math.min(MAP_RADIUS, -q + MAP_RADIUS); r++) {
      const d = hexDistance(0, 0, q, r);
      let terrain;
      if (d === 0) terrain = 'prairie';
      else if (d >= MAP_RADIUS) terrain = rng() < 0.55 ? 'sable' : 'prairie';
      else {
        const roll = rng();
        if (roll < 0.34) terrain = 'prairie';
        else if (roll < 0.60) terrain = 'foret';
        else if (roll < 0.82) terrain = 'colline';
        else terrain = 'montagne';
      }
      const t = { q, r, terrain, owner: null, building: null, garrison: 0, revealed: d <= 2 };
      tiles[tileKey(q, r)] = t;
      list.push(t);
    }
  }

  // Capitale au centre.
  const capital = tiles[tileKey(0, 0)];
  capital.owner = 'joueur';
  capital.building = 'caserne';
  capital.garrison = 6;
  capital.capital = true;
  capital.revealed = true;

  // Les clans occupent le pourtour, à distance égale les uns des autres, pour
  // qu'aucun ne soit collé au joueur au premier tour.
  const rim = list.filter((t) => hexDistance(0, 0, t.q, t.r) === MAP_RADIUS);
  CLANS.forEach((clan, i) => {
    const anchor = rim[Math.floor((i / CLANS.length) * rim.length)];
    if (!anchor) return;
    anchor.owner = clan.key;
    anchor.garrison = 4 + Math.floor(rng() * 3);
    anchor.fort = true;
    neighbors(anchor.q, anchor.r).forEach(([nq, nr]) => {
      const n = tiles[tileKey(nq, nr)];
      if (n && !n.owner && rng() < 0.6) { n.owner = clan.key; n.garrison = 2 + Math.floor(rng() * 3); }
    });
  });

  // Quelques repaires neutres : de la résistance sans propriétaire, qui donne
  // au joueur de quoi s'entraîner avant d'affronter un clan.
  list.forEach((t) => {
    if (t.owner || hexDistance(0, 0, t.q, t.r) < 2) return;
    if (rng() < 0.22) { t.neutralGarrison = 2 + Math.floor(rng() * 4); }
  });

  return tiles;
}

// ---------- État initial -------------------------------------
export function newGameState(seedStr, nowMs = Date.now()) {
  return {
    version: 1,
    seed: String(seedStr),
    startedAt: nowMs,
    lastTick: nowMs,
    or: 120,
    vivres: 40,
    sceaux: 0,
    sceauxSpent: 0,
    changes: {},        // seules les tuiles modifiées sont persistées
    log: [],
    defeated: [],
  };
}

/** Reconstruit la carte complète : terrain déterministe + changements sauvegardés. */
export function hydrate(state) {
  const tiles = generateWorld(state.seed);
  Object.entries(state.changes || {}).forEach(([k, patch]) => {
    if (tiles[k]) Object.assign(tiles[k], patch);
  });
  return tiles;
}

/** Enregistre une tuile modifiée dans le delta persistant. */
function markChanged(state, t) {
  state.changes = state.changes || {};
  state.changes[tileKey(t.q, t.r)] = {
    owner: t.owner, building: t.building, garrison: t.garrison,
    revealed: t.revealed, neutralGarrison: t.neutralGarrison ?? null,
  };
}

// ---------- Lecture de l'état --------------------------------
export function ownedTiles(tiles) { return Object.values(tiles).filter((t) => t.owner === 'joueur'); }

export function production(tiles) {
  let or = 0, vivres = 0;
  ownedTiles(tiles).forEach((t) => {
    const ter = TERRAINS[t.terrain];
    or += ter.or; vivres += ter.vivres;
    const b = BUILDINGS[t.building];
    if (b) { or += b.prod.or || 0; vivres += b.prod.vivres || 0; }
  });
  return { or, vivres };
}

export function tileDefense(t) {
  const ter = TERRAINS[t.terrain];
  let pct = ter.def;
  const b = BUILDINGS[t.building];
  if (b && b.def) pct += b.def;
  if (t.fort) pct += 30;
  return pct;
}

export function rankOf(tiles, hoursTotal) {
  const n = ownedTiles(tiles).length;
  let current = RANKS[0];
  for (const r of RANKS) if (n >= r.tiles && hoursTotal >= r.hours) current = r;
  const idx = RANKS.indexOf(current);
  return { ...current, index: idx, next: RANKS[idx + 1] || null };
}

// ---------- Le lien avec les heures encodées -----------------
// Les heures ne sont JAMAIS modifiées par le jeu : elles n'entrent que dans un
// sens. Une heure facturée = un Sceau, et les deux paliers de la jauge Nessy
// donnent un bonus d'assaut. Bosser rend l'armée meilleure, pas plus nombreuse.
export const SCEAUX_PAR_HEURE = 1;

export function warBonus(hoursMonth, socleHours = 25, garantieHours = 43.75) {
  if (hoursMonth >= garantieHours) return { pct: 25, label: 'Garantie atteinte', tier: 2 };
  if (hoursMonth >= socleHours) return { pct: 12, label: 'Socle atteint', tier: 1 };
  return { pct: 0, label: 'Sous le socle', tier: 0 };
}

export function sceauxEarned(hoursTotal) { return Math.floor(hoursTotal * SCEAUX_PAR_HEURE); }

/** Sceaux réellement disponibles = gagnés par le travail − déjà dépensés. */
export function sceauxAvailable(state, hoursTotal) {
  return Math.max(0, sceauxEarned(hoursTotal) - (state.sceauxSpent || 0));
}

// ---------- Le tour de production ----------------------------
function pushLog(state, text, kind = 'info') {
  state.log = state.log || [];
  state.log.unshift({ t: Date.now(), text, kind });
  if (state.log.length > 40) state.log.length = 40;
}

/**
 * Rattrape tous les tours écoulés depuis la dernière ouverture.
 * Renvoie un résumé de ce qui s'est passé pendant l'absence.
 */
export function catchUp(state, tiles, nowMs = Date.now()) {
  const elapsed = Math.max(0, nowMs - (state.lastTick ?? nowMs));
  const wanted = Math.floor(elapsed / TICK_MS);
  const ticks = Math.min(wanted, MAX_CATCHUP_TICKS);
  if (ticks <= 0) return { ticks: 0, or: 0, vivres: 0, attacks: [], skipped: 0 };

  const rng = mulberry32(hashSeed(state.seed + ':' + Math.floor((state.lastTick ?? 0) / TICK_MS)));
  const prod = production(tiles);
  const gainedOr = prod.or * ticks;
  const gainedVivres = prod.vivres * ticks;
  state.or += gainedOr;
  state.vivres += gainedVivres;

  // Les clans vivent aussi pendant l'absence : ils renforcent leurs garnisons et
  // tentent parfois une incursion. Sans ça, revenir n'aurait aucun enjeu.
  const attacks = [];
  const clanTiles = Object.values(tiles).filter((t) => t.owner && t.owner !== 'joueur');
  for (let i = 0; i < ticks; i++) {
    if (rng() < 0.35 && clanTiles.length) {
      const t = clanTiles[Math.floor(rng() * clanTiles.length)];
      t.garrison = (t.garrison || 0) + 1;
      markChanged(state, t);
    }
    if (rng() < 0.06) {
      const raider = clanTiles.filter((t) => (t.garrison || 0) >= 5
        && neighbors(t.q, t.r).some(([nq, nr]) => tiles[tileKey(nq, nr)]?.owner === 'joueur'));
      if (raider.length) {
        const from = raider[Math.floor(rng() * raider.length)];
        const targets = neighbors(from.q, from.r)
          .map(([nq, nr]) => tiles[tileKey(nq, nr)])
          .filter((t) => t && t.owner === 'joueur' && !t.capital);
        if (targets.length) {
          const target = targets[Math.floor(rng() * targets.length)];
          const res = resolveCombat(from.garrison - 2, target.garrison, tileDefense(target), 0, rng);
          from.garrison = 2 + res.attackerLeft;
          if (res.win) {
            target.owner = from.owner; target.garrison = res.attackerLeft; target.building = null;
            attacks.push({ clan: from.owner, q: target.q, r: target.r, lost: true });
          } else {
            target.garrison = res.defenderLeft;
            attacks.push({ clan: from.owner, q: target.q, r: target.r, lost: false });
          }
          markChanged(state, from); markChanged(state, target);
        }
      }
    }
  }

  state.lastTick = (state.lastTick ?? nowMs) + ticks * TICK_MS;
  const summary = { ticks, or: gainedOr, vivres: gainedVivres, attacks, skipped: wanted - ticks };
  if (gainedOr || gainedVivres) {
    pushLog(state, `Retour d'expédition · +${gainedOr} or, +${gainedVivres} vivres sur ${ticks} tour${ticks > 1 ? 's' : ''}.`, 'prod');
  }
  attacks.forEach((a) => pushLog(state,
    a.lost ? `Un territoire est tombé aux mains du clan ${a.clan}.` : `Une incursion du clan ${a.clan} a été repoussée.`,
    a.lost ? 'bad' : 'good'));
  return summary;
}

// ---------- Combat -------------------------------------------
/**
 * Résolution en une passe, avec une part d'aléatoire bornée : on veut de la
 * tension, pas des surprises absurdes. Un attaquant deux fois supérieur gagne
 * toujours ; à forces égales, le terrain tranche.
 */
export function resolveCombat(attack, defense, defPct, bonusPct, rng = Math.random) {
  const atk = Math.max(0, attack) * (1 + bonusPct / 100) * (0.85 + rng() * 0.3);
  const def = Math.max(0, defense) * (1 + defPct / 100) * (0.85 + rng() * 0.3);
  const win = atk > def;
  const ratio = def <= 0 ? 0 : Math.min(1, def / Math.max(atk, 0.001));
  if (win) {
    return { win: true, attackerLeft: Math.max(1, Math.round(attack * (1 - ratio * 0.8))), defenderLeft: 0 };
  }
  const inv = atk <= 0 ? 0 : Math.min(1, atk / Math.max(def, 0.001));
  return { win: false, attackerLeft: 0, defenderLeft: Math.max(1, Math.round(defense * (1 - inv * 0.8))) };
}

// ---------- Actions du joueur --------------------------------
// Chacune renvoie { ok, error } et ne modifie l'état que si ok. L'appelant peut
// donc afficher l'erreur sans avoir à annuler quoi que ce soit.
function canPay(state, cost) {
  return (state.or >= (cost.or || 0)) && (state.vivres >= (cost.vivres || 0));
}
function pay(state, cost) {
  state.or -= cost.or || 0;
  state.vivres -= cost.vivres || 0;
}

export function isAdjacentToPlayer(tiles, t) {
  return neighbors(t.q, t.r).some(([nq, nr]) => tiles[tileKey(nq, nr)]?.owner === 'joueur');
}

export const COLONISE_COST = { or: 60, vivres: 10 };

export function colonise(state, tiles, q, r) {
  const t = tiles[tileKey(q, r)];
  if (!t) return { ok: false, error: 'Territoire inconnu.' };
  if (t.owner) return { ok: false, error: 'Ce territoire appartient déjà à quelqu’un.' };
  if (t.neutralGarrison) return { ok: false, error: 'Un repaire hostile occupe ce territoire — il faut l’attaquer.' };
  if (!isAdjacentToPlayer(tiles, t)) return { ok: false, error: 'Trop loin : colonisez depuis un territoire voisin.' };
  if (!canPay(state, COLONISE_COST)) return { ok: false, error: 'Pas assez d’or ou de vivres.' };
  pay(state, COLONISE_COST);
  t.owner = 'joueur'; t.garrison = 1; t.revealed = true;
  revealAround(state, tiles, t);
  markChanged(state, t);
  pushLog(state, `${TERRAINS[t.terrain].label} colonisée.`, 'good');
  return { ok: true };
}

export function build(state, tiles, q, r, key) {
  const t = tiles[tileKey(q, r)];
  const b = BUILDINGS[key];
  if (!t || !b) return { ok: false, error: 'Construction inconnue.' };
  if (t.owner !== 'joueur') return { ok: false, error: 'Ce territoire n’est pas à vous.' };
  if (t.building) return { ok: false, error: 'Il y a déjà un bâtiment ici.' };
  if (b.terrains && !b.terrains.includes(t.terrain)) {
    return { ok: false, error: `${b.label} impossible sur ${TERRAINS[t.terrain].label.toLowerCase()}.` };
  }
  if (!canPay(state, b.cost)) return { ok: false, error: 'Pas assez d’or.' };
  pay(state, b.cost);
  t.building = key;
  markChanged(state, t);
  pushLog(state, `${b.label} construite.`, 'good');
  return { ok: true };
}

export const TROOP_COST = { or: 25, vivres: 8 };

export function recruit(state, tiles, q, r, count = 1) {
  const t = tiles[tileKey(q, r)];
  if (!t) return { ok: false, error: 'Territoire inconnu.' };
  if (t.owner !== 'joueur') return { ok: false, error: 'Ce territoire n’est pas à vous.' };
  if (t.building !== 'caserne') return { ok: false, error: 'Il faut une caserne pour recruter ici.' };
  const cost = { or: TROOP_COST.or * count, vivres: TROOP_COST.vivres * count };
  if (!canPay(state, cost)) return { ok: false, error: 'Pas assez d’or ou de vivres.' };
  pay(state, cost);
  t.garrison = (t.garrison || 0) + count;
  markChanged(state, t);
  pushLog(state, `${count} troupe${count > 1 ? 's' : ''} recrutée${count > 1 ? 's' : ''}.`, 'good');
  return { ok: true };
}

/** Dépense de Sceaux : une troupe d'élite, payée par le travail réellement encodé. */
export const SCEAUX_PAR_ELITE = 3;

export function recruitElite(state, tiles, q, r, hoursTotal) {
  const t = tiles[tileKey(q, r)];
  if (!t) return { ok: false, error: 'Territoire inconnu.' };
  if (t.owner !== 'joueur') return { ok: false, error: 'Ce territoire n’est pas à vous.' };
  if (sceauxAvailable(state, hoursTotal) < SCEAUX_PAR_ELITE) {
    return { ok: false, error: `Il faut ${SCEAUX_PAR_ELITE} sceaux — encodez des heures pour en gagner.` };
  }
  state.sceauxSpent = (state.sceauxSpent || 0) + SCEAUX_PAR_ELITE;
  t.garrison = (t.garrison || 0) + 3;
  markChanged(state, t);
  pushLog(state, 'Garde d’élite levée grâce aux heures facturées.', 'good');
  return { ok: true };
}

export function revealAround(state, tiles, t) {
  neighbors(t.q, t.r).forEach(([nq, nr]) => {
    const n = tiles[tileKey(nq, nr)];
    if (n && !n.revealed) { n.revealed = true; markChanged(state, n); }
  });
}

/** Attaque depuis une tuile possédée vers une tuile adjacente. */
export function attack(state, tiles, fromQ, fromR, toQ, toR, hoursMonth, rng = Math.random) {
  const from = tiles[tileKey(fromQ, fromR)];
  const to = tiles[tileKey(toQ, toR)];
  if (!from || !to) return { ok: false, error: 'Territoire inconnu.' };
  if (from.owner !== 'joueur') return { ok: false, error: 'Attaquez depuis un de vos territoires.' };
  if (to.owner === 'joueur') return { ok: false, error: 'Ce territoire est déjà à vous.' };
  if (hexDistance(fromQ, fromR, toQ, toR) !== 1) return { ok: false, error: 'Les territoires ne sont pas voisins.' };
  const troops = (from.garrison || 0) - 1;   // une troupe reste toujours en garnison
  if (troops < 1) return { ok: false, error: 'Il faut au moins 2 troupes pour lancer un assaut.' };

  const bonus = warBonus(hoursMonth);
  const defenders = to.owner ? (to.garrison || 0) : (to.neutralGarrison || 0);
  const res = resolveCombat(troops, defenders, tileDefense(to), bonus.pct, rng);

  from.garrison = 1 + res.attackerLeft;
  markChanged(state, from);

  if (res.win) {
    const wasClan = to.owner;
    to.owner = 'joueur';
    to.garrison = res.attackerLeft;
    to.neutralGarrison = null;
    to.building = to.building === 'rempart' ? null : to.building;
    to.revealed = true;
    revealAround(state, tiles, to);
    markChanged(state, to);
    pushLog(state, `Victoire ! ${TERRAINS[to.terrain].label} conquise.`, 'good');
    const remaining = Object.values(tiles).some((x) => x.owner === wasClan);
    if (wasClan && !remaining) {
      state.defeated = [...new Set([...(state.defeated || []), wasClan])];
      pushLog(state, `Le clan ${wasClan} est éliminé.`, 'good');
    }
    return { ok: true, win: true, result: res, bonus };
  }

  if (to.owner) to.garrison = res.defenderLeft; else to.neutralGarrison = res.defenderLeft;
  to.revealed = true;
  markChanged(state, to);
  pushLog(state, `Assaut repoussé sur ${TERRAINS[to.terrain].label}.`, 'bad');
  return { ok: true, win: false, result: res, bonus };
}

/** Les actions possibles sur une tuile, prêtes à être affichées telles quelles. */
export function actionsFor(state, tiles, t, hoursTotal) {
  if (!t) return [];
  const out = [];
  if (t.owner === 'joueur') {
    if (!t.building) {
      Object.entries(BUILDINGS).forEach(([key, b]) => {
        if (b.terrains && !b.terrains.includes(t.terrain)) return;
        out.push({ kind: 'build', key, label: b.label, cost: b.cost, enabled: canPay(state, b.cost) });
      });
    }
    if (t.building === 'caserne') {
      out.push({ kind: 'recruit', label: 'Recruter', cost: TROOP_COST, enabled: canPay(state, TROOP_COST) });
    }
    out.push({
      kind: 'elite', label: 'Garde d’élite', sceaux: SCEAUX_PAR_ELITE,
      enabled: sceauxAvailable(state, hoursTotal) >= SCEAUX_PAR_ELITE,
    });
  } else if (!t.owner && !t.neutralGarrison) {
    out.push({
      kind: 'colonise', label: 'Coloniser', cost: COLONISE_COST,
      enabled: isAdjacentToPlayer(tiles, t) && canPay(state, COLONISE_COST),
    });
  } else {
    const froms = neighbors(t.q, t.r)
      .map(([nq, nr]) => tiles[tileKey(nq, nr)])
      .filter((n) => n && n.owner === 'joueur' && (n.garrison || 0) >= 2);
    out.push({
      kind: 'attack', label: 'Attaquer', enabled: froms.length > 0,
      from: froms[0] ? { q: froms[0].q, r: froms[0].r } : null,
      defenders: t.owner ? (t.garrison || 0) : (t.neutralGarrison || 0),
    });
  }
  return out;
}
