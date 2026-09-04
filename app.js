import {
  auth,
  db,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  collection,
  doc,
  updateDoc,
  deleteDoc,
  query,
  where,
  Timestamp,
  serverTimestamp,
  setDoc,
  onSnapshot,
} from './firebase-config.js?v=2026-09-03-12';

// =============================================================
// 💰 RÈGLES MÉTIER · CONSTANTES
// =============================================================
// L'app ne fait plus que deux choses : compter les heures et dire ce qu'il y a
// à facturer. Plus de TVA, d'INASTI, d'IPP, de charges fixes ni d'avance de
// démarrage : ces provisions estimaient des montants qu'on ne peut de toute
// façon pas calculer correctement sans les frais professionnels réels.
const NESSY = {
  socleFlat: 2000,
  socleHours: 25,
  regieRate: 80,
  minGaranti: 3500,
  minHoursEq: 43.75,
};

// =============================================================
// 🗓️ ÉTAT GLOBAL
// =============================================================
const STATE = {
  user: null,
  clients: [],           // Projets · {id, name, default_rate, is_external}
  allLogs: [],           // TOUS les time_logs du user (cache local, sync temps réel)
  logs: [],              // time_logs filtrés sur le mois affiché (dérivé de allLogs)
  selectedMonth: new Date().getMonth(),
  selectedYear: new Date().getFullYear(),
  contractStart: firstDayOfMonth(new Date().getFullYear(), 0), // À override : ex. new Date('2025-01-01')
  editingClientId: null,
  clientsLoaded: false,   // les projets ont-ils été reçus au moins une fois ?
  dataTimeout: false,     // Firestore n'a jamais répondu · on débloque quand même l'interface
  lastPopulatedClientId: null,
};

// =============================================================
// 🧩 UTILITAIRES
// =============================================================
const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

function EUR(n, digits = 0) {
  const v = digits === 0 ? Math.round(n) : Number(n).toFixed(digits);
  return Number(v).toLocaleString('fr-BE', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }) + ' €';
}
function HH(totalMinutes, showMinSuffix = true) {
  // Affichage court : 1h15, 2h, 0h30
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  const out = `${h}h${String(m).padStart(2, '0')}`;
  return showMinSuffix ? out : out;
}
/** Nombre au format belge/français : virgule décimale. */
function FR(n, digits = 2) {
  return Number(n).toLocaleString('fr-BE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function HHdecimal(totalMinutes) {
  return FR(totalMinutes / 60);
}
function firstDayOfMonth(y, m) { return new Date(y, m, 1, 0, 0, 0, 0); }
function lastDayOfMonth(y, m)  { return new Date(y, m + 1, 0, 23, 59, 59, 999); }
/**
 * Convertit en Date tout ce que Firestore peut renvoyer.
 * On NE teste PAS `instanceof Timestamp` : selon la façon dont le SDK est chargé,
 * l'objet renvoyé peut ne pas être une instance de NOTRE classe importée, et le
 * test échouait silencieusement — la date devenait invalide et l'encodage
 * disparaissait de tous les mois, donnant l'impression d'avoir perdu les données.
 * On accepte donc aussi la forme `{seconds, nanoseconds}` et les chaînes ISO.
 */
function toDateSafe(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
  if (typeof v._seconds === 'number') return new Date(v._seconds * 1000);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function fmtDateBE(tsOrDate) {
  const d = toDateSafe(tsOrDate);
  return d ? d.toLocaleDateString('fr-BE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}
function fmtDateInput(tsOrDate) {
  const d = toDateSafe(tsOrDate) || new Date();
  // getFullYear/Month/Date (heure locale) : toISOString décale d'un jour selon le fuseau.
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// ★ Règle d'arrondi · 15 min SUPÉRIEURES
function billedMinutes(realMin) {
  if (!realMin || realMin <= 0) return 0;
  return Math.ceil(realMin / 15) * 15;
}
function toast(msg, icon = 'check-circle', variant = 'success') {
  const t = $('#toast');
  const iconCls = variant === 'danger' ? 'text-red-400' : variant === 'warn' ? 'text-amber-400' : 'text-emerald-400';
  t.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4 ${iconCls}"></i><span>${msg}</span>`;
  if (window.lucide) lucide.createIcons();
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), 2800);
}

// =============================================================
// 🚨 DIAGNOSTIC · erreurs Firestore visibles à l'écran
// Un toast de 3 secondes ne suffit pas quand rien ne s'enregistre : on affiche
// un bandeau persistant avec le code d'erreur exact et la marche à suivre.
// =============================================================
// Vérifié le 03/09/2026 par un appel direct à l'API Firestore REST sur le projet
// kopek-4ffe6 : « The database (default) does not exist for project kopek-4ffe6 ».
// Le projet Firebase existe et l'authentification fonctionne, mais aucune base
// Firestore n'y est provisionnée : toute lecture et toute écriture échouent.
// Règles minimales : chacun ne lit et n'écrit que ses propres documents.
const RULES_TEXT = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{col}/{doc} {
      allow read, delete: if request.auth != null
        && resource.data.userId == request.auth.uid;
      allow create, update: if request.auth != null
        && request.resource.data.userId == request.auth.uid;
    }
  }
}`;

const RULES_MSG =
  'Les règles de sécurité de Firestore refusent la lecture et l\'écriture — c\'est le '
  + 'réglage par défaut d\'une base créée en mode production. Console Firebase → '
  + 'Firestore Database → onglet Règles : remplacez tout par les règles ci-dessous, '
  + 'cliquez sur Publier, puis rechargez cette page.';

// Le chien de garde ne sait PAS pourquoi rien n'arrive : il ne doit donc rien
// affirmer. Une cause inventée (« la base n'existe pas » alors qu'elle existe)
// envoie chercher au mauvais endroit — c'est pire que pas de message du tout.
const NO_DATA_MSG =
  'Firestore n\'a renvoyé aucune donnée. Deux causes possibles, à vérifier dans '
  + 'la console Firebase du projet kopek-4ffe6 : les règles de sécurité (onglet '
  + 'Règles) refusent la lecture, ou aucune base Firestore n\'a encore été créée '
  + '(Firestore Database → Créer une base de données, région europe-west).';

const FIRESTORE_MISSING_MSG =
  "Aucune base Firestore n'existe dans le projet kopek-4ffe6. Ouvrez la console "
  + 'Firebase → Firestore Database → « Créer une base de données » (région europe-west, '
  + 'mode production), puis rechargez cette page. Tant que la base est absente, aucune '
  + "donnée ne peut être lue ni enregistrée.";

function explainFirebaseError(err) {
  const code = (err && err.code) || '';
  const map = {
    'permission-denied': RULES_MSG,
    'unauthenticated': 'Session expirée · reconnectez-vous.',
    'unavailable': 'Firestore est injoignable (réseau ou hors ligne).',
    'failed-precondition': "Firestore réclame un index. Normalement l'app n'en a plus besoin — signalez ce message.",
    'invalid-argument': 'Donnée refusée par Firestore (champ inattendu ou format invalide).',
    'resource-exhausted': 'Quota Firestore dépassé pour ce projet.',
    'not-found': FIRESTORE_MISSING_MSG,
  };
  const msg = (err && err.message) || String(err);
  if (/database .* does not exist|NOT_FOUND/i.test(msg)) return FIRESTORE_MISSING_MSG;
  return map[code] || msg;
}

function showErrorBanner(action, err) {
  const el = document.getElementById('error-banner');
  const code = (err && err.code) ? err.code : 'inconnu';
  console.error(`[kopek] ${action}`, err);
  if (!el) { toast(`${action} · ${code}`, 'alert-circle', 'danger'); return; }
  const detail = document.getElementById('error-banner-text');
  const codeEl = document.getElementById('error-banner-code');
  if (detail) detail.textContent = `${action} — ${explainFirebaseError(err)}`;
  if (codeEl) codeEl.textContent = `code : ${code}`;
  // Recopier des règles Firestore à la main depuis un téléphone est intenable :
  // on les met dans le presse-papier en un geste.
  const copyBtn = document.getElementById('error-banner-copy');
  if (copyBtn) copyBtn.classList.toggle('hidden', code !== 'permission-denied');
  el.classList.remove('hidden');
}

document.getElementById('error-banner-copy')?.addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText(RULES_TEXT);
    e.currentTarget.textContent = 'Règles copiées ✓';
  } catch {
    // Presse-papier refusé (contexte non sécurisé) : on affiche les règles en clair.
    const detail = document.getElementById('error-banner-text');
    if (detail) detail.textContent = RULES_TEXT;
  }
});

function hideErrorBanner() {
  const el = document.getElementById('error-banner');
  if (el) el.classList.add('hidden');
}

// =============================================================
// 🔐 AUTH
// =============================================================
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  const err = $('#login-error');
  err.classList.add('hidden');
  try {
    await signInWithEmailAndPassword(auth, email, password);
    toast('Connecté · Bienvenue dans kopek ✨', 'sparkles');
  } catch (ex) {
    let msg = 'Identifiants incorrects.';
    if (ex.code === 'auth/invalid-credential' || ex.code === 'auth/wrong-password' || ex.code === 'auth/user-not-found') msg = 'Identifiants incorrects.';
    else if (ex.code === 'auth/invalid-email') msg = 'Email invalide.';
    else if (ex.code === 'auth/too-many-requests') msg = 'Trop de tentatives — attendez quelques instants.';
    err.textContent = msg;
    err.classList.remove('hidden');
  }
});
$('#btn-logout').addEventListener('click', async () => {
  try { await signOut(auth); toast('Déconnecté', 'log-out', 'warn'); } catch { /* ignore */ }
});

let appBound = false;
onAuthStateChanged(auth, (user) => {
  STATE.user = user;
  if (user) {
    $('#login-screen').classList.add('hidden');
    $('#dashboard-screen').classList.remove('hidden');
    // NB : la visibilité de #auth-status est gérée par ses classes responsive
    // (masqué sous sm) — on ne force plus `flex` ici, sinon la barre du haut
    // déborde sur trois lignes au téléphone.
    $('#auth-email').textContent = user.email || '';
    initApp();
  } else {
    $('#dashboard-screen').classList.add('hidden');
    $('#login-screen').classList.remove('hidden');
    teardownData();
  }
  if (window.lucide) lucide.createIcons();
});

// =============================================================
// 🚀 INIT APP (après auth)
// =============================================================
function initApp() {
  if (!appBound) {
    buildPeriodSelectors();
    bindTopBar();
    bindHoursWizard();
    bindModals();
    appBound = true;
  }
  subscribeData();
  lucide.createIcons();
}

// =============================================================
// 🗓️ TOP BAR · MOIS / ANNÉE
// =============================================================
function buildPeriodSelectors() {
  const mSel = $('#month-select');
  const ySel = $('#year-select');
  const months = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  if (!mSel.options.length) months.forEach((n, i) => {
    const o = document.createElement('option'); o.value = String(i); o.textContent = n; mSel.appendChild(o);
  });
  const curY = new Date().getFullYear();
  if (!ySel.options.length) {
    for (let y = curY - 3; y <= curY + 2; y++) {
      const o = document.createElement('option'); o.value = String(y); o.textContent = y; ySel.appendChild(o);
    }
  }
  mSel.value = String(STATE.selectedMonth);
  ySel.value = String(STATE.selectedYear);
}
function bindTopBar() {
  $('#month-select').onchange = (e) => { STATE.selectedMonth = +e.target.value; refreshPeriod(); };
  $('#year-select').onchange  = (e) => { STATE.selectedYear  = +e.target.value; refreshPeriod(); };
  $('#prev-month').onclick = () => navigateMonth(-1);
  $('#next-month').onclick = () => navigateMonth(+1);
}
function navigateMonth(delta) {
  let m = STATE.selectedMonth + delta, y = STATE.selectedYear;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  STATE.selectedMonth = m; STATE.selectedYear = y;
  $('#month-select').value = String(m);
  $('#year-select').value  = String(y);
  refreshPeriod();
}

// =============================================================
// 🗃️ FIRESTORE CRUD
// =============================================================
const colClients   = () => collection(db, 'clients');
const colTimeLogs  = () => collection(db, 'time_logs');

// -------------------------------------------------------------------------
// ⚠️ Toutes les requêtes ci-dessous n'utilisent QU'UN SEUL filtre d'égalité
// (userId ==) et AUCUN orderBy Firestore. C'est volontaire : dès qu'on
// combine une égalité avec un orderBy sur un autre champ (ou un 2e where),
// Firestore exige un index composite créé manuellement dans la console.
// Sans cet index, la requête échoue silencieusement (catch avalé) et rien
// ne s'affiche. On trie/filtre donc côté JS, ce qui ne nécessite AUCUN
// index et fonctionne immédiatement sur un projet Firebase tout neuf.
// -------------------------------------------------------------------------

let unsubClients = null;
let unsubLogs = null;
let seedingDefaultProject = false;

function toMillisSafe(tsOrDate) {
  const d = toDateSafe(tsOrDate);
  return d ? d.getTime() : 0;
}

function teardownData() {
  if (unsubClients) { unsubClients(); unsubClients = null; }
  if (unsubLogs) { unsubLogs(); unsubLogs = null; }
  STATE.clients = []; STATE.allLogs = []; STATE.logs = [];
  STATE.clientsLoaded = false;
  STATE.dataTimeout = false;
  if (readWatchdog) { clearTimeout(readWatchdog); readWatchdog = null; }
}

// Firestore ne signale pas toujours une lecture impossible par le callback
// d'erreur : quand la base n'existe pas, le flux temps réel est relancé
// indéfiniment et l'interface resterait bloquée sur « chargement » sans le
// moindre message. On borne donc l'attente.
const READ_TIMEOUT_MS = 8000;
let readWatchdog = null;
let readReported = false;   // un écouteur a-t-il déjà remonté une vraie erreur ?

// Une lecture refusée est définitive : inutile de faire patienter 8 secondes de
// plus derrière un bouton inerte. On affiche la vraie cause et on rend la main.
function onReadError(action, err) {
  readReported = true;
  STATE.dataTimeout = true;
  if (readWatchdog) { clearTimeout(readWatchdog); readWatchdog = null; }
  showErrorBanner(action, err);
  renderAll();
}

function subscribeData() {
  teardownData();
  const uid = STATE.user.uid;

  readReported = false;
  readWatchdog = setTimeout(() => {
    if (STATE.clientsLoaded) return;
    STATE.dataTimeout = true;
    // Si un écouteur a déjà remonté son vrai code d'erreur, on le laisse en
    // place : on se contente de débloquer l'interface.
    if (!readReported) showErrorBanner('Aucune donnée reçue', { code: 'timeout', message: NO_DATA_MSG });
    renderAll();   // on débloque l'interface plutôt que de laisser un bouton mort
  }, READ_TIMEOUT_MS);

  const qClients = query(colClients(), where('userId', '==', uid));
  unsubClients = onSnapshot(qClients, (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    STATE.clients = list;
    STATE.clientsLoaded = true;
    STATE.dataTimeout = false;
    if (readWatchdog) { clearTimeout(readWatchdog); readWatchdog = null; }
    hideErrorBanner();
    if (list.length === 0 && !seedingDefaultProject) {
      seedingDefaultProject = true;
      ensureDefaultProject()
        .catch((ex) => showErrorBanner('Création du projet par défaut impossible', ex))
        .finally(() => { seedingDefaultProject = false; });
    }
    renderAll();
  }, (err) => onReadError('Lecture des projets impossible', err));

  const qLogs = query(colTimeLogs(), where('userId', '==', uid));
  unsubLogs = onSnapshot(qLogs, (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => toMillisSafe(a.date) - toMillisSafe(b.date));
    STATE.allLogs = list;
    renderAll();
  }, (err) => onReadError('Lecture des encodages impossible', err));
}

function ensureDefaultProject() {
  const ref = doc(colClients());
  return setDoc(ref, {
    userId: STATE.user.uid,
    name: 'Nessy · Général',
    default_rate: NESSY.regieRate,
    is_external: false,
    createdAt: serverTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// ⚠️ AUCUNE de ces fonctions n'attend l'accusé de réception du serveur.
// La promesse renvoyée par addDoc/setDoc ne se résout QUE lorsque Firestore a
// confirmé côté serveur : sur une connexion instable elle reste en attente
// indéfiniment — sans jamais échouer. Un `await` dessus fige donc l'interface
// (bouton désactivé, rien ne se passe, aucune erreur), ce qui est exactement le
// symptôme observé. Firestore écrit dans son cache local immédiatement et
// synchronise ensuite ; les écouteurs temps réel affichent la donnée aussitôt.
// On génère donc l'identifiant côté client et on surveille l'échec en arrière-plan.
// ---------------------------------------------------------------------------
function writeInBackground(promise, label) {
  promise.catch((ex) => showErrorBanner(label, ex));
}

// Les écouteurs temps réel ne rappellent qu'au tour de boucle suivant. Le code
// qui suit immédiatement une création — remplir une liste déroulante, y
// sélectionner le nouvel élément — travaillerait donc sur un état périmé : la
// sélection retombait dans le vide et le projet fraîchement créé n'apparaissait
// qu'après avoir refermé la fenêtre. On l'insère donc localement tout de suite ;
// l'instantané qui arrive ensuite porte le même identifiant et le remplace.
function upsertLocal(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = { ...list[i], ...item };
  else list.push(item);
  return item;
}

function createLog(payload) {
  if (!STATE.user) return null;
  const ref = doc(colTimeLogs());          // identifiant généré localement
  writeInBackground(setDoc(ref, {
    userId: STATE.user.uid,
    custom_price: null,
    project_name: '',
    createdAt: serverTimestamp(),
    ...payload,
    date: Timestamp.fromDate(toDateSafe(payload.date) || new Date()),
  }), "Enregistrement de l'encodage impossible");
  upsertLocal(STATE.allLogs, {
    id: ref.id, userId: STATE.user.uid, custom_price: null, ...payload,
    date: toDateSafe(payload.date) || new Date(),
  });
  STATE.allLogs.sort((a, b) => toMillisSafe(a.date) - toMillisSafe(b.date));
  renderAll();
  return ref.id;
}
function updateLog(id, patch) {
  if (!STATE.user) return;
  const norm = { ...patch };
  if (norm.date) norm.date = Timestamp.fromDate(toDateSafe(norm.date) || new Date());
  writeInBackground(updateDoc(doc(db, 'time_logs', id), norm), 'Mise à jour impossible');
}
function deleteLog(id) {
  if (!STATE.user) return;
  writeInBackground(deleteDoc(doc(db, 'time_logs', id)), 'Suppression impossible');
}
function createClient(data) {
  if (!STATE.user) return null;
  const ref = doc(colClients());
  writeInBackground(setDoc(ref, {
    userId: STATE.user.uid,
    createdAt: serverTimestamp(),
    ...data,
  }), 'Enregistrement du projet impossible');
  upsertLocal(STATE.clients, { id: ref.id, userId: STATE.user.uid, ...data });
  STATE.clients.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  renderAll();
  return ref.id;
}
function updateClient(id, patch) {
  if (!STATE.user) return;
  writeInBackground(updateDoc(doc(db, 'clients', id), patch), 'Mise à jour du projet impossible');
}
function deleteClient(id) {
  if (!STATE.user) return;
  // Vérifie qu'il ne reste pas que ce projet
  if (STATE.clients.length <= 1) {
    toast('Impossible de supprimer le dernier projet', 'alert-circle', 'danger');
    throw new Error('last_client');
  }
  writeInBackground(deleteDoc(doc(db, 'clients', id)), 'Suppression du projet impossible');
}
function getClient(id) {
  return STATE.clients.find((c) => c.id === id);
}

// =============================================================
// 🧮 MOTEUR CALCUL · FACTURATION NESSY + MULTI-CLIENTS
// =============================================================

/** Calcule tout le mois · objet agrégat
 * =========================================================================
 * 🔑 MODÈLE MÉTIER :
 *   Les "clients" créés dans l'app sont en réalité des PROJETS internes à
 *   Nessy (étiquettes pour savoir pour qui/quoi on a bossé). Quel que soit
 *   le projet sélectionné, les heures alimentent LA MÊME jauge Nessy
 *   (Socle → Régie Garantie → Bonus), car c'est Nessy qui facture au bout
 *   du compte. Un projet peut être marqué `is_external: true` pour un
 *   vrai client indépendant hors-Nessy : son CA s'ajoute au total mais ne
 *   touche pas la jauge/les paliers.
 *
 *   SOCLE 2 000 € (25 h) + MIN GARANTI 3 500 € (43,75 h) = ACQUIS PROMIS
 *   sur contrat, DÈS LE PREMIER JOUR DU MOIS, SANS ENCODAGE.
 *   Les heures encodées servent à REMBOURSER cet acquis (0 → 43,75 h),
 *   puis au-delà génèrent du SURPLUS BONUS facturé en plus du Min Garanti.
 * =========================================================================
 */
function aggregateMonth() {

  // Regroupements par projet
  const byClient = new Map(); // id -> { client, realMin, billedMin, eur, count }

  let nessyRealMin = 0, nessyBilledMin = 0;   // hourly, projets Nessy (non externes)
  let nessyHourlyEur = 0;                     // (minutes facturées/60) × rate appliqué, projets Nessy hourly
  let nessyFlatEur = 0;                       // somme des forfaits sur projets Nessy
  let nessyLogCount = 0;                      // nb d'encodages sur projets Nessy (active le contrat du mois)

  let externalEur = 0;                        // CA des vrais clients externes (hors jauge)

  let globalRealMin = 0;
  let globalBilledMin = 0;
  let globalRawEur = 0; // somme brute tous projets (avant application min garanti NESSY)

  for (const l of STATE.logs) {
    const realMin = l.real_minutes || 0;
    const billedMin = l.billed_minutes || 0;
    const rate = l.rate_applied || 0;
    const isFlat = l.custom_price != null && l.custom_price > 0;
    const eur = isFlat ? l.custom_price : (billedMin / 60) * rate;

    globalRealMin += realMin;
    globalBilledMin += billedMin;
    globalRawEur += eur;

    const client = getClient(l.client_id);
    const isExternal = !!client?.is_external;

    // bucket projet
    if (!byClient.has(l.client_id)) {
      byClient.set(l.client_id, {
        client: client || { name: 'Projet supprimé', id: l.client_id },
        realMin: 0, billedMin: 0, eur: 0, count: 0, flat: 0, hourly: 0,
      });
    }
    const b = byClient.get(l.client_id);
    b.realMin += realMin; b.billedMin += billedMin; b.eur += eur; b.count++;
    if (isFlat) b.flat += eur; else b.hourly += eur;

    if (isExternal) {
      externalEur += eur;
    } else {
      nessyLogCount++;
      if (isFlat) {
        nessyFlatEur += eur;
      } else {
        nessyRealMin += realMin;
        nessyBilledMin += billedMin;
        nessyHourlyEur += eur;
      }
    }
  }

  // ---- DÉCOMPOSITION PALIERS NESSY (tous projets non-externes confondus) ----
  const hoursHourlyNessy = nessyBilledMin / 60;
  const heuresDette = NESSY.minHoursEq;
  const refundedH = Math.min(hoursHourlyNessy, heuresDette);            // 0 → 43,75
  const debtRemainH = Math.max(0, heuresDette - hoursHourlyNessy);     // ce qu'il reste à faire
  const t3h = Math.max(hoursHourlyNessy - heuresDette, 0);             // SURPLUS BONUS au-dessus du Min Garanti

  const socleHours = NESSY.socleHours;
  const t1h = Math.min(refundedH, socleHours);                                         // Remboursement Socle
  const t2h = Math.min(Math.max(refundedH - socleHours, 0), heuresDette - socleHours); // Remboursement Régie Garantie

  // CA NESSY = MIN GARANTI (acquis) + SURPLUS RÉEL HORAIRE + FORFAITS
  const minG = NESSY.minGaranti;
  const hourlySurplusEur = Math.max(0, nessyHourlyEur - (heuresDette * NESSY.regieRate));
  const mainFlatEur = nessyFlatEur;
  const bonusEur = hourlySurplusEur + mainFlatEur;

  const t1eur = t1h * NESSY.regieRate;              // 0 → 2000
  const t2eur = t2h * NESSY.regieRate;              // 0 → 1500
  const t3eur = hourlySurplusEur;

  const mainRevenusAvantMin = (refundedH * NESSY.regieRate) + bonusEur;
  // Si on a ne serait-ce qu'1 log Nessy → on active le contrat pour le mois → Min Garanti
  const hasAnyNessy = nessyLogCount > 0;
  const mainFinalCA = hasAnyNessy
    ? Math.max(minG, mainRevenusAvantMin)
    : 0;
  const minApplied = hasAnyNessy && mainRevenusAvantMin < minG;

  const secondaryEur = externalEur;
  const globalCA = mainFinalCA + secondaryEur;

  // Pour jauge · base = heures DETTE (43,75 h). On clamp 0→120%
  //   0%   = 0h encodées (dette ENTIÈRE)
  //   100% = 43,75h remboursées (dette soldée)
  //   > 100% = surplus bonus
  const gaugeBaseHours = NESSY.minHoursEq;
  const gaugePct = Math.min(120, (hoursHourlyNessy / gaugeBaseHours) * 100);

  return {
    minG, minApplied,
    tiers: { t1: { h: t1h, eur: t1eur }, t2: { h: t2h, eur: t2eur }, t3: { h: t3h, eur: t3eur } },
    mainFlatEur,
    mainRevenusAvantMin,
    mainFinalCA,
    mainHoursHourly: hoursHourlyNessy,
    mainRealMinutes: nessyRealMin,
    mainBilledMinutes: nessyBilledMin,
    secondaryEur,
    globalCA,
    globalRealMin,
    globalBilledMin,
    globalRawEur,
    byClient,
    gaugePct,
    gaugeBaseHours,
    bonusEur,                      // = surplus facturable en euros
    refundedH,                     // heures de dette remboursées
    debtRemainH,                   // il reste X heures avant de déclencher le bonus
    hasAnyNessy,                   // contrat activé pour le mois ?
  };
}

// =============================================================
// 🎨 RENDU PRINCIPAL
// =============================================================
function recomputeMonthLogs() {
  const start = firstDayOfMonth(STATE.selectedYear, STATE.selectedMonth).getTime();
  const end = lastDayOfMonth(STATE.selectedYear, STATE.selectedMonth).getTime();
  STATE.logs = STATE.allLogs.filter((l) => {
    const t = toMillisSafe(l.date);
    return t >= start && t <= end;
  });
}

// Chaque bloc est rendu isolément : une erreur dans une section (un id absent du
// HTML, par ex.) ne doit plus faire tomber tout le tableau de bord comme avant.
function section(name, fn, agg) {
  try { fn(agg); } catch (ex) { console.error(`[kopek] rendu "${name}" en échec`, ex); }
}

/** Rendu complet du tableau de bord à partir de STATE (alimenté en temps réel par les listeners Firestore). */
function renderAll() {
  if (!STATE.user) return;
  recomputeMonthLogs();
  const agg = aggregateMonth();
  // Le bouton n'est inactif que pendant les toutes premières secondes, le temps
  // que la liste des projets arrive. Passé le délai de garde il redevient
  // cliquable même si Firestore n'a pas répondu : un bouton définitivement mort
  // est le pire des symptômes, il ne laisse aucune prise à l'utilisateur.
  const addBtn = document.getElementById('btn-add-hours');
  if (addBtn) addBtn.disabled = !(STATE.clientsLoaded || STATE.dataTimeout);
  section('projets', populateClientSelects, agg);
  section('entête', renderHeader, agg);
  section('jauge', renderNessyGauge, agg);
  section('ville', renderCity, agg);
  section('métriques', renderMetrics, agg);
  section('encodages', renderLogs, agg);
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
}
// Alias conservé pour tous les points d'appel existants (CRUD → re-rendu immédiat,
// même si le listener temps réel confirmera l'état juste après).
const refreshPeriod = renderAll;

function renderHeader(agg) {
  const months = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  $('#period-title').textContent = `${months[STATE.selectedMonth]} ${STATE.selectedYear}`;
  $('#period-sub').textContent = agg.hasAnyNessy
    ? `Minimum garanti ${EUR(NESSY.minGaranti)} · ${FR(NESSY.minHoursEq)} h à prester`
    : `Aucune heure encodée ce mois · minimum garanti ${EUR(NESSY.minGaranti)}`;
  const pb = $('#phase-badge');
  if (pb) {
    const surplus = agg.tiers.t3.h > 0.001;
    pb.textContent = surplus ? 'Surplus facturable' : (agg.hasAnyNessy ? 'En cours' : 'À démarrer');
    pb.className = surplus
      ? 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 text-[10px] font-semibold tracking-wider uppercase border border-emerald-500/30'
      : 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-zinc-800/80 text-zinc-400 text-[10px] font-semibold tracking-wider uppercase border border-zinc-700/70';
  }
  $('#nessy-ca').textContent = EUR(agg.mainFinalCA);
}

function renderNessyGauge(agg) {
  const hoursNessy = agg.mainHoursHourly;          // h facturées sur contrat principal
  const socleH = NESSY.socleHours;                 // 25 h
  const garantieH = NESSY.minHoursEq;              // 43,75 h

  // ============================================================
  // La piste HTML fait 100 % = 43,75 h (min garanti). On borne donc le
  // remplissage à 100 % : tout ce qui dépasse est raconté par le bandeau
  // surplus ci-dessous, plus jamais par un débordement de la piste.
  // ============================================================
  const pct = Math.min(100, agg.gaugePct);
  $('#gauge-fill').style.width   = `${pct}%`;
  $('#gauge-cursor').style.left  = `calc(${pct}% - 1.5px)`;

  // Bandeau surplus
  const surplusBox = $('#gauge-surplus');
  const surplusH = agg.tiers.t3.h;
  if (surplusH > 0.001) {
    surplusBox.classList.remove('hidden');
    $('#gauge-surplus-text').innerHTML =
      `Minimum garanti atteint · <b class="font-mono">+${FR(surplusH)} h</b> de surplus ` +
      `facturable en plus, soit <b class="font-mono text-emerald-300">+${EUR(agg.tiers.t3.eur)}</b>.`;
  } else {
    surplusBox.classList.add('hidden');
  }

  // ------------------------------------------------------------------
  // HEADER NESSY (à gauche du Hero)
  //   Titre "CONTRAT PRINCIPAL · NESSY"
  //   Sous-titre : on MET EN ÉVIDENCE l'ACQUIS CONTRACTUEL
  //   + le surplus en bonus en plus
  // ------------------------------------------------------------------
  const acquisShow = EUR(agg.hasAnyNessy ? agg.minG : 0);
  const bonusShow  = EUR(agg.bonusEur || 0);
  const hh = HHdecimal(hoursNessy * 60);           // heures decimal pour affichage
  $('#nessy-sub').innerHTML = (agg.hasAnyNessy)
    ? `<b>Acquis <span class="chip text-amber-300 font-bold">${acquisShow}</span> garanti</b> · ` +
      `Réalisé <span class="chip text-white font-bold">${hh} h / ${FR(garantieH)} h</span> · ` +
      `<span class="text-emerald-300 font-bold">+ ${bonusShow} bonus</span>`
    : `Aucun encodage Nessy ce mois · Acquis contractuel non activé — Encode tes premières heures pour activer <b class="text-amber-300">${EUR(agg.minG)}</b> de Min Garanti.`;

  // Cards tiers (3 sous-cartes sous la jauge)
  // Puisque l'argent est acquis : montrer REMBOURSEMENT (pas € gagnés)
  $('#tier1-h').textContent   = `${FR(agg.tiers.t1.h)} h`;
  $('#tier1-eur').textContent = `~ ${EUR(agg.tiers.t1.eur)} remboursés`;
  $('#tier2-h').textContent   = `${FR(agg.tiers.t2.h)} h`;
  $('#tier2-eur').textContent = `~ ${EUR(agg.tiers.t2.eur)} remboursés @ ${NESSY.regieRate} €/h`;
  $('#tier3-h').textContent   = `+ ${FR(agg.tiers.t3.h)} h`;
  $('#tier3-eur').textContent = `+ ${EUR(agg.tiers.t3.eur + agg.mainFlatEur)} bonus`;

  // ---- STATUS BAND : remplacements ACQUIS vs RÉALISÉ vs BONUS ----
  const st = $('#gauge-status');
  const refunded = agg.refundedH || 0;
  const debt = agg.debtRemainH || 0;

  // Cas 0 · Rien d'encodé (hasAnyNessy false → pas top-up)
  if (!agg.hasAnyNessy) {
    st.className = 'mt-6 rounded-xl p-4 flex items-start gap-3.5 border border-amber-500/30 bg-amber-500/[0.06]';
    st.innerHTML = `<i data-lucide="scale" class="w-5 h-5 text-amber-300 flex-none mt-0.5"></i>
      <div class="flex-1">
        <div class="flex flex-wrap items-center gap-2 mb-1.5">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-200 text-[11px] font-semibold tracking-wider uppercase">⚜️ Acquis Contractuel</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-zinc-800/80 border border-zinc-700 text-zinc-300 text-[11px] font-mono">💶 Min Garanti · ${EUR(agg.minG)}</span>
        </div>
        <strong class="text-zinc-100 block">0 h encodées Nessy · L'acquis <b class="text-amber-300">${EUR(agg.minG)}</b> est PROMIS par contrat, mais <b>pas encore activé</b> sur le mois.</strong>
        <div class="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 text-xs font-mono">
          <div class="rounded-lg p-2 bg-zinc-900/70 border border-zinc-800 text-indigo-300/90">
            <div class="text-[9px] uppercase tracking-wider text-zinc-500 font-sans">Socle 2 000 €</div>
            <b class="block mt-1 text-zinc-100">—</b>
            <div class="text-[10px] text-zinc-500 mt-0.5">0 / ${FR(socleH)} h · dette</div>
          </div>
          <div class="rounded-lg p-2 bg-zinc-900/70 border border-zinc-800 text-fuchsia-300/90">
            <div class="text-[9px] uppercase tracking-wider text-zinc-500 font-sans">Régie Garantie</div>
            <b class="block mt-1 text-zinc-100">—</b>
            <div class="text-[10px] text-zinc-500 mt-0.5">0 / ${FR(garantieH - socleH)} h · dette</div>
          </div>
          <div class="rounded-lg p-2 bg-zinc-900/70 border border-zinc-800 text-emerald-300/90">
            <div class="text-[9px] uppercase tracking-wider text-zinc-500 font-sans">Bonus Surplus</div>
            <b class="block mt-1 text-zinc-100">0,00 €</b>
            <div class="text-[10px] text-zinc-500 mt-0.5">seulement après ${FR(garantieH)} h</div>
          </div>
        </div>
        <div class="mt-3 text-[12px] text-zinc-400">
          Sélectionnez un <b>projet Nessy</b> dans la saisie rapide ci-dessus, puis encodez vos heures · Le top-up Min Garanti s'appliquera en fin de mois si nécessaire.
        </div>
      </div>`;
  }

  // Cas 1 · Dans le SOCLE (0 → 25h)
  else if (refunded < socleH) {
    const pctSocle = Math.min(100, (refunded / socleH) * 100);
    st.className = 'mt-6 rounded-xl p-4 flex items-start gap-3.5 border border-indigo-500/40 bg-indigo-500/[0.07]';
    st.innerHTML = `<i data-lucide="move-up-right" class="w-5 h-5 text-indigo-300 flex-none mt-0.5"></i>
      <div class="flex-1">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-200 text-[11px] font-semibold tracking-wider uppercase">⚜️ ACQUIS ${EUR(agg.minG)} GARANTI</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-indigo-500/20 border border-indigo-400/50 text-indigo-200 text-[11px] font-semibold tracking-wider uppercase">🧱 SOCLE EN COURS</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-400/40 text-emerald-200 text-[11px] font-mono">✨ BONUS <b class="ml-1">${EUR(agg.bonusEur || 0)}</b></span>
        </div>
        <strong class="text-indigo-100">Heures de dette · <span class="chip">${FR(refunded)} h / ${FR(socleH)} h</span> sur le Socle (25 h)</strong>
        <div class="mt-2 h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-indigo-500 to-indigo-300 rounded-full" style="width:${pctSocle}%"></div></div>
        <div class="flex justify-between flex-wrap gap-x-3 gap-y-1 text-[10px] sm:text-[11px] font-mono mt-1.5 text-indigo-300/80">
          <span>Remboursement Socle · ${pctSocle.toFixed(0)}%</span>
          <span>Il manque <b>${FR(debt)} h</b> avant déclenchement du surplus</span>
        </div>
        <div class="text-zinc-400 text-[12px] mt-2">
          Le contrat Nessy est activé · Tu gagnes <b class="text-amber-300">déjà ${EUR(agg.minG)}</b> d'office. Encode encore <b class="text-indigo-300">${FR(socleH - refunded)} h</b> pour solder le socle.
        </div>
      </div>`;
  }

  // Cas 2 · Dans la RÉGIE GARANTIE (25h → 43,75h)
  else if (refunded < garantieH) {
    const regieH = refunded - socleH;
    const regieMax = garantieH - socleH; // 18,75 h
    const pctRegie = Math.min(100, (regieH / regieMax) * 100);
    st.className = 'mt-6 rounded-xl p-4 flex items-start gap-3.5 border border-fuchsia-500/40 bg-fuchsia-500/[0.07]';
    st.innerHTML = `<i data-lucide="shield-check" class="w-5 h-5 text-fuchsia-300 flex-none mt-0.5"></i>
      <div class="flex-1">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-200 text-[11px] font-semibold tracking-wider uppercase">⚜️ ACQUIS ${EUR(agg.minG)} GARANTI</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-indigo-500/20 border border-indigo-400/50 text-indigo-200 text-[11px] font-semibold tracking-wider uppercase">🧱 SOCLE ✓</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-fuchsia-500/20 border border-fuchsia-400/50 text-fuchsia-200 text-[11px] font-semibold tracking-wider uppercase">🛡️ RÉGIE ${pctRegie.toFixed(0)}%</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-400/40 text-emerald-200 text-[11px] font-mono">✨ BONUS <b class="ml-1">${EUR(agg.bonusEur || 0)}</b></span>
        </div>
        <strong class="text-fuchsia-100">Dette Régie Garantie · <span class="chip">${FR(regieH)} h / ${FR(regieMax)} h</span> · il reste <b>${FR(debt)} h</b></strong>
        <div class="mt-2 grid grid-cols-2 gap-3">
          <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-indigo-500 to-indigo-300 rounded-full" style="width:100%"></div></div>
          <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-fuchsia-500 to-fuchsia-300 rounded-full" style="width:${pctRegie}%"></div></div>
        </div>
        <div class="flex justify-between flex-wrap gap-x-3 gap-y-1 text-[10px] sm:text-[11px] font-mono mt-1.5 text-zinc-400">
          <span class="text-indigo-300/80">Socle 100% · 25 h · dette remboursée</span>
          <span class="text-fuchsia-300/80">Régie Garantie · manque <b>${FR(garantieH - refunded)} h</b></span>
        </div>
        <div class="text-zinc-400 text-[12px] mt-2">
          <b class="text-amber-300">${EUR(agg.minG)}</b> d'office · Dès que tu atteindras <b class="text-fuchsia-300">${FR(garantieH)} h</b>, tu passeras en <b class="text-emerald-300">Surplus Bonus</b>.
        </div>
      </div>`;
  }

  // Cas 3 · SURPLUS (≥ 43,75h)  — 🏆 ENGAGEMENT VALIDÉ
  else {
      st.className = 'mt-6 rounded-xl p-4 flex items-start gap-3.5 border border-emerald-500/50 bg-emerald-500/[0.08] shadow-[0_30px_80px_-40px_rgba(16,185,129,0.55)]';
    st.innerHTML = `<i data-lucide="trophy" class="w-5 h-5 text-amber-300 flex-none mt-0.5"></i>
      <div class="flex-1">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-amber-500/20 border border-amber-400/50 text-amber-200 text-[11px] font-semibold tracking-wider uppercase">🏆 ENGAGEMENT VALIDÉ</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-indigo-500/20 border border-indigo-400/50 text-indigo-200 text-[11px] font-semibold tracking-wider uppercase">🧱 SOCLE ✓</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-fuchsia-500/20 border border-fuchsia-400/50 text-fuchsia-200 text-[11px] font-semibold tracking-wider uppercase">🛡️ GARANTIE ✓</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-400/50 text-emerald-200 text-[11px] font-mono">✨ BONUS +<b class="ml-1">${EUR(agg.bonusEur || 0)}</b></span>
        </div>
        <strong class="text-emerald-100">Tu as remboursé toutes tes heures · <span class="chip">+${FR(surplusH)} h</span> en bonus facturable en <b class="text-amber-300">plus de ${EUR(agg.minG)}</b></strong>
        <div class="mt-2 grid grid-cols-3 gap-3">
          <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-indigo-500 to-indigo-300 rounded-full" style="width:100%"></div></div>
          <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-fuchsia-500 to-fuchsia-300 rounded-full" style="width:100%"></div></div>
          <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-emerald-400 via-lime-400 to-amber-300 rounded-full" style="width:${Math.min(100,(surplusH/8.75)*100)}%"></div></div>
        </div>
        <div class="flex justify-between flex-wrap gap-x-3 gap-y-1 text-[10px] sm:text-[11px] font-mono mt-1.5 text-zinc-400">
          <span class="text-indigo-300/80">Socle 25 h · ${EUR(NESSY.socleFlat)}</span>
          <span class="text-fuchsia-300/80">Régie 18,75 h · ${EUR(1500)}</span>
          <span class="text-emerald-300/80">Surplus · +${FR(surplusH)} h × ${NESSY.regieRate} €</span>
        </div>
        <div class="text-zinc-400 text-[12px] mt-2">
          CA principal · <b class="text-white">${EUR(agg.mainFinalCA)}</b> dont acquis <b class="text-amber-300">${EUR(agg.minG)}</b> + bonus <b class="text-emerald-300">${EUR(agg.bonusEur || 0)}</b> · Chaque heure en plus = c'est <b class="text-emerald-300">directement dans la poche</b>.
        </div>
      </div>`;
  }
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
}

// =================================================================
// 🎮 KOPEK CITY · vraie 3D low-poly (Three.js) pilotée par la jauge
// =================================================================
// Le module 3D est chargé DYNAMIQUEMENT et son échec est non-fatal : si WebGL est
// indisponible ou si un fichier de vendor/three ne se sert pas (Jekyll, cache, réseau),
// le time-tracking doit continuer à fonctionner normalement.
let cityMod = null;
let cityStatus = 'idle';   // idle | loading | ready | failed
let cityInited = false;
let lastBonusHFlag = 0;
let lastAggForCity = null;

function showCityFallback(msg) {
  const el = document.getElementById('city-fallback');
  if (!el) return;
  el.classList.remove('hidden');
  const detail = document.getElementById('city-fallback-detail');
  if (detail && msg) detail.textContent = msg;
}

async function ensureCityLoaded() {
  if (cityStatus === 'ready' || cityStatus === 'loading' || cityStatus === 'failed') return;
  cityStatus = 'loading';
  try {
    cityMod = await import('./city3d.js?v=2026-09-03-12');
    const canvas = document.getElementById('city-canvas');
    if (!canvas) throw new Error('canvas #city-canvas introuvable');
    cityMod.initCity(canvas);
    cityInited = true;
    cityStatus = 'ready';
    if (lastAggForCity) renderCity3D(lastAggForCity);
  } catch (ex) {
    cityStatus = 'failed';
    console.error('Kopek City 3D indisponible', ex);
    showCityFallback(ex && ex.message ? ex.message : String(ex));
  }
}

function renderCity3D(agg) {
  if (cityStatus !== 'ready' || !cityMod) return;
  try {
    const caps = { socleH: NESSY.socleHours, garantieH: NESSY.minHoursEq };
    // Seed stable par mois calendaire (indépendant du contrat) → thème/agencement
    // différent chaque mois, mais identique si on revient sur le même mois.
    const seedKey = STATE.selectedYear * 12 + STATE.selectedMonth;
    cityMod.renderCityScene(agg, caps, seedKey);

    const bonusH = agg.tiers?.t3?.h || 0;
    if (bonusH > 0.01 && lastBonusHFlag <= 0.01) cityMod.celebrate();
    lastBonusHFlag = bonusH;
  } catch (ex) {
    cityStatus = 'failed';
    console.error('Kopek City 3D · erreur de rendu', ex);
    showCityFallback(ex && ex.message ? ex.message : String(ex));
  }
}

/** HUD = DOM pur : il doit toujours afficher les bons chiffres, même si la 3D échoue. */
function renderCity(agg) {
  lastAggForCity = agg;
  ensureCityLoaded();
  renderCity3D(agg);

  const bonusH = agg.tiers?.t3?.h || 0;
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const socleH = NESSY.socleHours, fullH = NESSY.minHoursEq;
  const refunded = agg.refundedH || 0;
  const soclePct = Math.min(100, (refunded / socleH) * 100);
  const garantiPct = refunded >= socleH ? Math.min(100, ((refunded - socleH) / (fullH - socleH)) * 100) : 0;
  const population = Math.round(150 + refunded * 28 + bonusH * 60 + agg.secondaryEur / 8);
  setText('hud-socle', `${soclePct.toFixed(0)} %`);
  setText('hud-garanti', `${garantiPct.toFixed(0)} %`);
  setText('hud-bonus', `+${FR(bonusH, 1)} h`);
  setText('hud-pop', population.toLocaleString('fr-BE') + ' hab.');
  setText('hud-acquis', EUR(agg.hasAnyNessy ? agg.minG : 0));
  setText('hud-ca-bonus', EUR(agg.bonusEur || 0));
  const bar = document.getElementById('hud-bar');
  const pctForBar = Math.min(120, (refunded / fullH) * 100 + Math.min(30, (bonusH / 24) * 30));
  if (bar) bar.style.width = `${pctForBar}%`;
  const label = document.getElementById('hud-label');
  if (label) {
    if (!agg.hasAnyNessy) label.textContent = 'Contrat principal non activé sur la période';
    else if (refunded < fullH) label.textContent = `Engagement ${FR(refunded)} / ${FR(fullH)} h · reste ${FR(agg.debtRemainH)} h`;
    else label.textContent = `Engagement validé · Bonus ${EUR(agg.bonusEur || 0)} · Surplus ${FR(bonusH, 1)} h`;
  }
}

function renderMetrics(agg) {
  const restH = Math.max(0, agg.debtRemainH);

  $('#m-ca').textContent = EUR(agg.globalCA);
  $('#m-ca-detail').textContent = agg.secondaryEur > 0
    ? `Nessy ${EUR(agg.mainFinalCA)} · Externes ${EUR(agg.secondaryEur)}`
    : `Minimum garanti ${EUR(agg.minG)}`;

  $('#m-hours').textContent = `${FR(agg.mainBilledMinutes / 60)} h`;
  $('#m-hours-detail').textContent = `sur ${FR(NESSY.minHoursEq)} h · ${HH(agg.mainRealMinutes)} réellement prestées`;

  $('#m-reste').textContent = restH > 0 ? `${FR(restH)} h` : 'Atteint';
  $('#m-reste-detail').textContent = restH > 0
    ? `avant d'atteindre ${EUR(agg.minG)}`
    : `minimum garanti couvert`;
}

// =============================================================
// 📋 LOGS TABLE · INLINE ACTIONS (edit / delete)
// =============================================================
function renderLogs(agg) {
  const tbody = $('#log-tbody');
  const tfoot = $('#log-tfoot');
  const empty = $('#log-empty');
  tbody.innerHTML = ''; tfoot.innerHTML = '';
  $('#log-count').textContent = STATE.logs.length ? `· ${STATE.logs.length} encodage${STATE.logs.length > 1 ? 's' : ''}` : '';
  if (!STATE.logs.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  let mainBilled = 0, mainEur = 0, otherEur = 0, realMin = 0;
  tbody.innerHTML = STATE.logs.map((l) => {
    const rm = l.real_minutes || 0, bm = l.billed_minutes || 0;
    realMin += rm;
    const isFlat = l.custom_price != null && l.custom_price > 0;
    let eur = isFlat ? l.custom_price : (bm / 60) * (l.rate_applied || 0);
    const client = getClient(l.client_id);
    const isMain = !client?.is_external;
    if (isMain) { mainBilled += bm; mainEur += eur; } else otherEur += eur;
    const diff = bm - rm;
    const roundedPct = diff > 0;
    const badge = roundedPct
      ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-semibold"><i data-lucide="arrow-up" class="w-2.5 h-2.5"></i>+${diff} min arrondi</span>`
      : `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-zinc-800/80 text-zinc-400 border border-zinc-700 text-[10px] font-semibold">sans arrondi</span>`;
    return `<tr data-id="${l.id}" class="hover:bg-zinc-900/40 transition group">
      <td class="px-4 sm:px-5 py-3 whitespace-nowrap text-zinc-300">${fmtDateBE(l.date)}</td>
      <td class="px-4 sm:px-5 py-3 min-w-[160px]">
        <div class="flex items-center gap-2">
          <div class="w-1 h-1.5 rounded-full ${isMain ? 'bg-fuchsia-400' : 'bg-zinc-600'}"></div>
          <span class="text-sm truncate ${isMain ? 'text-zinc-100 font-medium' : 'text-zinc-300'}">${client?.name || 'Projet supprimé'}</span>
        </div>
      </td>
      <td class="px-4 sm:px-5 py-3 min-w-[220px] text-sm text-zinc-200"><span class="truncate inline-block max-w-full">${l.description || ''}</span></td>
      <td class="px-4 sm:px-5 py-3 text-right whitespace-nowrap">
        <div class="inline-flex flex-col items-end gap-0.5">
          <div class="font-mono chip text-xs text-zinc-400">${HHdecimal(rm)} h · réel</div>
          <div class="font-mono chip text-sm text-white font-semibold">${HHdecimal(bm)} h · fact</div>
          ${badge}
        </div>
      </td>
      <td class="px-4 sm:px-5 py-3 text-right whitespace-nowrap text-sm">
        ${isFlat
          ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200 font-mono chip">Forfait · ${EUR(eur)}</span>`
          : `<span class="font-mono chip">${EUR(l.rate_applied || 0)}<span class="text-zinc-500 text-xs">/h</span></span>`}
      </td>
      <td class="px-4 sm:px-5 py-3 text-right hidden sm:table-cell whitespace-nowrap font-mono chip font-semibold">${EUR(eur)}</td>
      <td class="px-4 sm:px-5 py-3 text-right w-24">
        <div class="flex items-center justify-end gap-1 opacity-50 group-hover:opacity-100 transition">
          <button data-dup class="p-1.5 hover:bg-emerald-500/20 text-emerald-300 rounded" title="Dupliquer (répéter cette tâche)">
            <i data-lucide="copy-plus" class="w-4 h-4"></i>
          </button>
          <button data-edit class="p-1.5 hover:bg-indigo-500/20 text-indigo-300 rounded" title="Modifier">
            <i data-lucide="edit-3" class="w-4 h-4"></i>
          </button>
          <button data-del class="p-1.5 hover:bg-red-500/20 text-red-400 rounded" title="Supprimer">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');

  tfoot.innerHTML = `<tr>
    <td class="px-4 sm:px-5 py-3" colspan="3">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 text-[11px] font-semibold"><i data-lucide="crown" class="w-3 h-3"></i> Nessy · ${HHdecimal(mainBilled)} h · ${EUR(mainEur)}</span>
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800/80 text-zinc-300 border border-zinc-700 text-[11px] font-semibold">Clients externes · ${EUR(otherEur)}</span>
      </div>
    </td>
    <td class="px-4 sm:px-5 py-3 text-right whitespace-nowrap">
      <div class="inline-flex flex-col items-end gap-0.5">
        <div class="font-mono chip text-xs text-zinc-400">${HHdecimal(realMin)} h réel</div>
        <div class="font-mono chip text-sm font-bold">${HHdecimal(agg.globalBilledMin)} h fact</div>
      </div>
    </td>
    <td class="px-4 sm:px-5 py-3"></td>
    <td class="px-4 sm:px-5 py-3 text-right hidden sm:table-cell whitespace-nowrap font-mono chip font-bold text-lg">${EUR(agg.globalCA)}</td>
    <td></td>
  </tr>`;

  // Actions
  $$('#log-tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    const log = STATE.logs.find((l) => l.id === id);
    if (!log) return;
    tr.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm('Supprimer cet encodage ?')) return;
      try {
        deleteLog(id);
        toast('Encodage supprimé', 'trash-2', 'warn');
        refreshPeriod();
      } catch (ex) { showErrorBanner('Suppression impossible', ex); }
    });
    tr.querySelector('[data-edit]').addEventListener('click', () => openEditLog(log));
    tr.querySelector('[data-dup]').addEventListener('click', () => duplicateLogIntoQuickForm(log));
  });
}

// =============================================================
// ⚡ ASSISTANT « AJOUTER DES HEURES » (3 étapes)
// =============================================================
const LAST_CLIENT_KEY = 'kopek_last_client_id';

const WIZ = { step: 1, minutes: 0, type: 'hourly' };

function openHoursWizard(prefill) {
  // Avant, un clic pendant le chargement des projets ouvrait la modale « Nouveau
  // projet » à la place de l'assistant : la liste était vide simplement parce que
  // Firestore n'avait pas encore répondu. On attend, on ne détourne plus.
  if (!STATE.clientsLoaded && !STATE.dataTimeout) {
    toast('Chargement des projets…', 'loader', 'warn');
    return;
  }
  WIZ.step = 1;
  WIZ.minutes = prefill?.real_minutes || 0;
  const isFlat = prefill?.custom_price != null && prefill.custom_price > 0;
  WIZ.type = isFlat ? 'flat' : 'hourly';

  populateWizardClients();
  const last = localStorage.getItem(LAST_CLIENT_KEY);
  const wanted = prefill?.client_id || last;
  if (wanted && STATE.clients.some((c) => c.id === wanted)) $('#w-client').value = wanted;

  $('#w-desc').value = prefill?.description || '';
  $('#w-date').value = fmtDateInput(prefill?.date || new Date());
  $('#w-min').value = WIZ.minutes || '';
  $('#w-rate').value = isFlat ? prefill.custom_price : (prefill?.rate_applied || clientRate($('#w-client').value));
  $('#w-error').classList.add('hidden');
  $('#w-custom-wrap').classList.add('hidden');
  markDurationButtons();
  updateWizardDescList();
  applyWizardType();
  showWizardStep(1);
  $('#hours-modal').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function clientRate(id) {
  const c = getClient(id);
  return c ? (c.default_rate || NESSY.regieRate) : NESSY.regieRate;
}

function populateWizardClients() {
  const list = STATE.clients.slice().sort((a, b) => {
    if (!!a.is_external !== !!b.is_external) return a.is_external ? 1 : -1;
    return (a.name || '').localeCompare(b.name || '');
  });
  $('#w-client').innerHTML = list
    .map((c) => `<option value="${c.id}">${c.name}${c.is_external ? ' · Externe' : ''}</option>`)
    .join('') + '<option value="__new__">➕ Nouveau projet…</option>';
  syncNewClientField();
}

/** Affiche le champ « nom du nouveau projet » quand on choisit ➕ dans la liste. */
function syncNewClientField() {
  const isNew = $('#w-client').value === '__new__';
  $('#w-newclient-wrap').classList.toggle('hidden', !isNew);
  if (isNew) setTimeout(() => $('#w-newclient').focus(), 50);
}

function showWizardStep(n) {
  WIZ.step = n;
  $$('#hours-modal [data-step]').forEach((el) => {
    el.classList.toggle('hidden', Number(el.getAttribute('data-step')) !== n);
  });
  $$('#hours-modal [data-step-bar]').forEach((el) => {
    const i = Number(el.getAttribute('data-step-bar'));
    el.className = `h-1 flex-1 rounded-full ${i <= n ? 'bg-indigo-500' : 'bg-zinc-800'}`;
  });
  const labels = { 1: 'Étape 1 sur 3 · Projet et description', 2: 'Étape 2 sur 3 · Durée', 3: 'Étape 3 sur 3 · Prix' };
  $('#hours-step-label').textContent = labels[n];
  $('#w-back').classList.toggle('invisible', n === 1);
  $('#w-next-label').textContent = n === 3 ? 'Enregistrer' : 'Suivant';
  $('#w-error').classList.add('hidden');
  if (n === 3) renderWizardSummary();
}

function markDurationButtons() {
  $$('#hours-modal .w-dur').forEach((b) => {
    const m = Number(b.getAttribute('data-min'));
    const on = m !== 0 && m === WIZ.minutes;
    b.className = `w-dur px-3 py-3.5 rounded-xl text-sm font-mono font-semibold transition border ${
      on ? 'bg-indigo-500/20 border-indigo-500/60 text-indigo-100' : 'bg-zinc-900 border-zinc-800 hover:border-indigo-500/50'}`;
  });
  const info = $('#w-round');
  if (!WIZ.minutes) { info.innerHTML = '<span class="text-zinc-600">Choisissez une durée.</span>'; return; }
  const billed = billedMinutes(WIZ.minutes);
  const diff = billed - WIZ.minutes;
  info.innerHTML = diff > 0
    ? `<b class="text-zinc-200">${WIZ.minutes} min</b> réelles → <b class="text-amber-300">${billed} min (${FR(billed / 60)} h)</b> facturées <span class="text-amber-400/80">(+${diff} min)</span>`
    : `<b class="text-zinc-200">${WIZ.minutes} min</b> → <b class="text-emerald-300">${FR(billed / 60)} h</b> facturées`;
}

function applyWizardType() {
  const hourly = WIZ.type === 'hourly';
  $('#w-type-hourly').className = `px-3 py-3 rounded-xl text-sm font-semibold transition border ${
    hourly ? 'bg-indigo-500/15 border-indigo-500/50 text-indigo-200' : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-indigo-500/40'}`;
  $('#w-type-flat').className = `px-3 py-3 rounded-xl text-sm font-semibold transition border ${
    !hourly ? 'bg-indigo-500/15 border-indigo-500/50 text-indigo-200' : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-indigo-500/40'}`;
  $('#w-rate-label').textContent = hourly ? 'Taux horaire (€)' : 'Prix forfaitaire (€)';
  $$('#hours-modal .w-rate').forEach((b) => b.classList.toggle('hidden', !hourly));
  if (WIZ.step === 3) renderWizardSummary();
}

function renderWizardSummary() {
  const billed = billedMinutes(WIZ.minutes);
  const rate = parseFloat($('#w-rate').value || '0');
  const total = WIZ.type === 'flat' ? rate : (billed / 60) * rate;
  const client = getClient($('#w-client').value);
  $('#w-summary').innerHTML = `
    <div class="flex justify-between gap-3"><span class="text-zinc-500">Projet</span><span class="text-right font-medium truncate">${client?.name || '—'}</span></div>
    <div class="flex justify-between gap-3"><span class="text-zinc-500">Durée facturée</span><span class="font-mono chip">${FR(billed / 60)} h</span></div>
    <div class="flex justify-between gap-3 pt-1.5 border-t border-zinc-800">
      <span class="text-zinc-400 font-semibold">Total</span>
      <span class="font-mono chip font-bold text-emerald-300">${EUR(total, 2)}</span>
    </div>`;
}

function bindHoursWizard() {
  $('#btn-add-hours').addEventListener('click', () => openHoursWizard(null));
  $('#w-client').addEventListener('change', () => {
    syncNewClientField();
    if (WIZ.type === 'hourly' && $('#w-client').value !== '__new__') {
      $('#w-rate').value = clientRate($('#w-client').value);
    }
    updateWizardDescList();
  });

  $$('#hours-modal .w-dur').forEach((b) => b.addEventListener('click', () => {
    const m = Number(b.getAttribute('data-min'));
    if (m === 0) {
      $('#w-custom-wrap').classList.remove('hidden');
      $('#w-min').focus();
      WIZ.minutes = parseInt($('#w-min').value, 10) || 0;
    } else {
      $('#w-custom-wrap').classList.add('hidden');
      WIZ.minutes = m;
      $('#w-min').value = m;
    }
    markDurationButtons();
  }));
  $('#w-min').addEventListener('input', () => {
    WIZ.minutes = parseInt($('#w-min').value, 10) || 0;
    markDurationButtons();
  });

  $('#w-type-hourly').addEventListener('click', () => {
    WIZ.type = 'hourly';
    $('#w-rate').value = clientRate($('#w-client').value);
    applyWizardType();
  });
  $('#w-type-flat').addEventListener('click', () => { WIZ.type = 'flat'; applyWizardType(); });
  $$('#hours-modal .w-rate').forEach((b) => b.addEventListener('click', () => {
    $('#w-rate').value = b.getAttribute('data-rate');
    renderWizardSummary();
  }));
  $('#w-rate').addEventListener('input', renderWizardSummary);

  $('#w-back').addEventListener('click', () => showWizardStep(Math.max(1, WIZ.step - 1)));
  $('#w-next').addEventListener('click', onWizardNext);
}

function wizardError(msg) {
  const el = $('#w-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function onWizardNext() {
  if (WIZ.step === 1) {
    if (!$('#w-desc').value.trim()) return wizardError('Ajoutez une description.');

    // Nouveau projet demandé : on le crée ici même, sans changer de fenêtre.
    if ($('#w-client').value === '__new__') {
      const name = $('#w-newclient').value.trim();
      if (!name) return wizardError('Donnez un nom au nouveau projet.');
      const btn = $('#w-next');
      btn.disabled = true;
      try {
        const id = createClient({ name, default_rate: NESSY.regieRate, is_external: false });
        populateWizardClients();
        $('#w-client').value = id;
        syncNewClientField();
        $('#w-newclient').value = '';
        $('#w-rate').value = NESSY.regieRate;
        hideErrorBanner();
        toast(`Projet « ${name} » créé`, 'check-circle');
      } catch (ex) {
        showErrorBanner('Création du projet impossible', ex);
        return wizardError(explainFirebaseError(ex));
      } finally {
        btn.disabled = false;
      }
    }
    if (!$('#w-client').value || $('#w-client').value === '__new__') return wizardError('Choisissez un projet.');
    return showWizardStep(2);
  }
  if (WIZ.step === 2) {
    if (!WIZ.minutes || WIZ.minutes <= 0) return wizardError('Choisissez une durée.');
    return showWizardStep(3);
  }

  const rate = parseFloat($('#w-rate').value || '0');
  if (!rate || rate <= 0) return wizardError(WIZ.type === 'flat' ? 'Indiquez le prix du forfait.' : 'Indiquez le taux horaire.');

  const btn = $('#w-next');
  const label = $('#w-next-label');
  const previous = label.textContent;
  btn.disabled = true;
  label.textContent = 'Enregistrement…';
  try {
    createLog({
      client_id: $('#w-client').value,
      description: $('#w-desc').value.trim(),
      real_minutes: WIZ.minutes,
      billed_minutes: billedMinutes(WIZ.minutes),
      rate_applied: WIZ.type === 'hourly' ? rate : 0,
      custom_price: WIZ.type === 'flat' ? rate : null,
      date: new Date($('#w-date').value + 'T12:00:00'),
    });
    localStorage.setItem(LAST_CLIENT_KEY, $('#w-client').value);
    hideErrorBanner();
    $('#hours-modal').classList.add('hidden');
    toast('Heures ajoutées', 'check-circle');
  } catch (ex) {
    showErrorBanner("Enregistrement de l'encodage impossible", ex);
    wizardError(explainFirebaseError(ex));
  } finally {
    btn.disabled = false;
    label.textContent = previous;
  }
}

/** Suggestions de description : dernières descriptions distinctes du projet choisi. */
function updateWizardDescList() {
  const dl = $('#w-desc-list');
  if (!dl) return;
  const cid = $('#w-client').value;
  const seen = new Set();
  const recent = [];
  for (let i = STATE.allLogs.length - 1; i >= 0 && recent.length < 12; i--) {
    const l = STATE.allLogs[i];
    if (cid && l.client_id !== cid) continue;
    const d = (l.description || '').trim();
    if (!d || seen.has(d)) continue;
    seen.add(d);
    recent.push(d);
  }
  dl.innerHTML = recent.map((d) => `<option value="${d.replace(/"/g, '&quot;')}"></option>`).join('');
}

/** Le bouton « dupliquer » d'une ligne rouvre l'assistant pré-rempli. */
function duplicateLogIntoQuickForm(log) {
  openHoursWizard(log);
}

// Le sélecteur de la modale d'édition suit la liste des projets.
function populateClientSelects() {
  const list = STATE.clients.slice().sort((a, b) => {
    if (!!a.is_external !== !!b.is_external) return a.is_external ? 1 : -1;
    return (a.name || '').localeCompare(b.name || '');
  });
  const eSel = $('#e-client');
  const prevEVal = eSel.value;
  eSel.innerHTML = list.map((c) => `<option value="${c.id}">${c.name}${c.is_external ? ' · Externe' : ''}</option>`).join('');
  if (list.some((c) => c.id === prevEVal)) eSel.value = prevEVal;
}

// =============================================================
// 💬 MODALS (Client · Manage · Edit Log)
// =============================================================
function bindModals() {
  // Generic close
  $$('[data-close-modal]').forEach((b) => b.addEventListener('click', (e) => {
    const modal = e.currentTarget.closest('.fixed');
    if (modal) modal.classList.add('hidden');
  }));
  document.addEventListener('keydown', (e) => {
    // Cible les vraies fenêtres : `.fixed` tout court attrapait aussi les halos
    // décoratifs du fond, qui disparaissaient définitivement au premier Échap.
    if (e.key === 'Escape') $$('#hours-modal, #client-modal, #manage-modal, #edit-modal').forEach((m) => m.classList.add('hidden'));
  });
  // New client
  $('#btn-new-client').addEventListener('click', () => openClientModal(null));
  $('#client-form').addEventListener('submit', handleClientFormSubmit);
  // Manage clients
  $('#btn-manage-clients').addEventListener('click', openManageClients);
  // Edit log
  $('#e-min').addEventListener('input', () => {
    const rm = parseInt($('#e-min').value, 10) || 0;
    $('#e-billed').value = billedMinutes(rm);
  });
  $('#edit-form').addEventListener('submit', handleEditLogSubmit);
  // Export CSV
  $('#btn-export').addEventListener('click', exportCSV);
}

function openClientModal(client) {
  STATE.editingClientId = client ? client.id : null;
  const err = $('#client-error'); err.classList.add('hidden');
  $('#client-modal-title').textContent = client ? 'Modifier le Projet' : 'Nouveau Projet';
  $('#c-name').value = client ? client.name : '';
  $('#c-rate').value = client ? (client.default_rate ?? NESSY.regieRate) : NESSY.regieRate;
  $('#c-main').checked = client ? !!client.is_external : false;
  $('#client-modal').classList.remove('hidden');
  setTimeout(() => $('#c-name').focus(), 50);
}
async function handleClientFormSubmit(e) {
  e.preventDefault();
  const err = $('#client-error'); err.classList.add('hidden');
  const name = $('#c-name').value.trim();
  const rate = parseFloat($('#c-rate').value || '0');
  const isExternal = $('#c-main').checked;
  if (!name) { err.textContent = 'Nom requis'; err.classList.remove('hidden'); return; }
  if (isNaN(rate) || rate < 0) { err.textContent = 'Taux invalide'; err.classList.remove('hidden'); return; }
  const submitBtn = $('#client-form button[type=submit]');
  const submitLabel = submitBtn ? submitBtn.querySelector('span:last-child') : null;
  const previousLabel = submitLabel ? submitLabel.innerHTML : null;
  if (submitBtn) submitBtn.disabled = true;
  if (submitLabel) submitLabel.textContent = 'Enregistrement…';
  try {
    if (STATE.editingClientId) {
      updateClient(STATE.editingClientId, { name, default_rate: rate, is_external: isExternal });
      toast('Projet mis à jour', 'check');
    } else {
      createClient({ name, default_rate: rate, is_external: isExternal });
      toast('Projet créé', 'check');
    }
    $('#client-modal').classList.add('hidden');
  } catch (ex) {
    err.textContent = explainFirebaseError(ex) + ` (code : ${ex.code || 'inconnu'})`;
    err.classList.remove('hidden');
    showErrorBanner('Enregistrement du projet impossible', ex);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitLabel && previousLabel !== null) submitLabel.innerHTML = previousLabel;
  }
}

function openManageClients() {
  const body = $('#manage-body');
  if (STATE.clients.length === 0) {
    body.innerHTML = `<div class="text-sm text-zinc-500 text-center py-8">Aucun projet.</div>`;
  } else {
    body.innerHTML = STATE.clients.map((c) => `
      <div class="rounded-xl p-4 border border-zinc-800 bg-zinc-900/40 flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-3 flex-1 min-w-0">
          <div class="w-10 h-10 rounded-lg flex items-center justify-center flex-none ${!c.is_external ? 'bg-gradient-to-br from-indigo-500/20 via-fuchsia-500/20 to-emerald-500/20 border border-fuchsia-500/30' : 'bg-zinc-800 border border-zinc-700'}">
            ${!c.is_external ? '<i data-lucide="crown" class="w-5 h-5 text-fuchsia-300"></i>' : '<i data-lucide="building" class="w-5 h-5 text-zinc-400"></i>'}
          </div>
          <div class="min-w-0 flex-1">
            <div class="font-semibold truncate">${c.name}</div>
            <div class="text-[11px] text-zinc-500 font-mono chip">Taux ${c.default_rate || 0} €/h${c.is_external ? ' · Client externe (hors jauge)' : ' · Projet Nessy (jauge)'}</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <button data-toggleext="${c.id}" class="px-3 py-1.5 text-xs rounded-md ${c.is_external ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700' : 'bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/30'}">
            ${c.is_external ? 'Marquer Nessy' : 'Marquer Externe'}
          </button>
          <button data-editc="${c.id}" class="px-3 py-1.5 text-xs rounded-md bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
            <i data-lucide="pencil" class="w-3 h-3 inline mr-1"></i>Modifier
          </button>
          <button data-delc="${c.id}" class="px-3 py-1.5 text-xs rounded-md bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30">
            <i data-lucide="trash" class="w-3 h-3 inline mr-1"></i>Supprimer
          </button>
        </div>
      </div>
    `).join('');
  }
  $('#manage-modal').classList.remove('hidden');
  lucide.createIcons();
  // events
  $$('#manage-body [data-editc]').forEach((b) => b.addEventListener('click', () => {
    const id = b.getAttribute('data-editc');
    const c = STATE.clients.find((x) => x.id === id);
    if (c) openClientModal(c);
  }));
  $$('#manage-body [data-delc]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-delc');
    if (!confirm('Supprimer ce projet ? Les encodages liés deviendront orphelins.')) return;
    try { deleteClient(id); toast('Projet supprimé', 'trash', 'warn'); openManageClients(); }
    catch { /* handled toast */ }
  }));
  $$('#manage-body [data-toggleext]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-toggleext');
    const c = STATE.clients.find((x) => x.id === id);
    if (!c) return;
    try {
      updateClient(id, { is_external: !c.is_external });
      toast(c.name + (c.is_external ? ' · Projet Nessy' : ' · Client externe'), 'check');
      openManageClients();
    } catch (ex) { showErrorBanner('Mise à jour impossible', ex); }
  }));
}

// =============================================================
// ✏️ EDIT LOG MODAL
// =============================================================
function openEditLog(log) {
  $('#e-id').value = log.id;
  $('#e-date').value = fmtDateInput(log.date);
  $('#e-client').value = log.client_id;
  $('#e-desc').value = log.description || '';
  $('#e-min').value = log.real_minutes || 0;
  $('#e-billed').value = log.billed_minutes || billedMinutes(log.real_minutes || 0);
  const isFlat = log.custom_price != null && log.custom_price > 0;
  $('#e-type').value = isFlat ? 'flat' : 'hourly';
  $('#e-rate').value = isFlat ? log.custom_price : (log.rate_applied || 0);
  $('#edit-error').classList.add('hidden');
  $('#edit-modal').classList.remove('hidden');
  lucide.createIcons();
}
async function handleEditLogSubmit(e) {
  e.preventDefault();
  const id = $('#e-id').value;
  const date = new Date($('#e-date').value + 'T12:00:00');
  const client_id = $('#e-client').value;
  const description = $('#e-desc').value.trim();
  const rm = parseInt($('#e-min').value, 10);
  const bm = billedMinutes(rm);
  const type = $('#e-type').value;
  const rateVal = parseFloat($('#e-rate').value || '0');
  const err = $('#edit-error'); err.classList.add('hidden');
  if (!rm || rm <= 0 || !client_id || !description) { err.textContent = 'Champs invalides'; err.classList.remove('hidden'); return; }
  if (type === 'hourly' && (!rateVal || rateVal <= 0)) { err.textContent = 'Taux horaire invalide'; err.classList.remove('hidden'); return; }
  if (type === 'flat' && (!rateVal || rateVal <= 0)) { err.textContent = 'Prix forfait invalide'; err.classList.remove('hidden'); return; }
  const patch = {
    date, client_id, description,
    real_minutes: rm, billed_minutes: bm,
    rate_applied: type === 'hourly' ? rateVal : 0,
    custom_price: type === 'flat' ? rateVal : null,
  };
  const editBtn = $('#edit-form button[type=submit]');
  if (editBtn) editBtn.disabled = true;
  try {
    updateLog(id, patch);
    toast('Encodage mis à jour', 'check');
    $('#edit-modal').classList.add('hidden');
    refreshPeriod();
  } catch (ex) { showErrorBanner('Mise à jour impossible', ex); }
  finally { if (editBtn) editBtn.disabled = false; }
}

// =============================================================
// 📤 EXPORT CSV
// =============================================================
function exportCSV() {
  const agg = aggregateMonth();
  const months = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const headers = ['Date', 'Projet', 'Description', 'Min Réelles', 'Min Facturées', 'Durée (h)', 'Type', 'Tarif appliqué (€/h ou forfait)', '€ HTVA'];
  const rows = [headers];
  for (const l of STATE.logs) {
    const client = getClient(l.client_id);
    const isFlat = l.custom_price != null && l.custom_price > 0;
    const eur = isFlat ? l.custom_price : ((l.billed_minutes || 0) / 60) * (l.rate_applied || 0);
    rows.push([
      fmtDateBE(l.date),
      client?.name || 'Projet supprimé',
      (l.description || '').replace(/"/g, '""'),
      String(l.real_minutes || 0),
      String(l.billed_minutes || 0),
      HHdecimal(l.billed_minutes || 0),
      isFlat ? 'Forfait' : 'Horaire',
      String(isFlat ? l.custom_price : (l.rate_applied || 0)),
      eur.toFixed(2),
    ]);
  }
  rows.push([]);
  rows.push(['TOTAL MOIS · ' + months[STATE.selectedMonth] + ' ' + STATE.selectedYear]);
  rows.push(['Heures réelles', '', '', agg.globalRealMin, agg.globalBilledMin, HHdecimal(agg.globalBilledMin), '', '', '']);
  rows.push(['', '', '', '', '', '', '', 'CA HTVA Facturé (brut)', agg.globalRawEur.toFixed(2)]);
  rows.push(['', '', '', '', '', '', '', 'Minimum garanti appliqué', agg.minApplied ? 'OUI · ' + EUR(agg.minG) : 'NON']);
  rows.push(['', '', '', '', '', '', '', 'CA HTVA FINAL (Tous clients)', agg.globalCA.toFixed(2)]);

  const csv = rows.map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[,";\n]/.test(s) ? `"${s}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const mm = String(STATE.selectedMonth + 1).padStart(2, '0');
  a.download = `kopek_releve_${STATE.selectedYear}-${mm}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('CSV téléchargé', 'download');
}

// =============================================================
// LUCIDE INIT INITIAL (login screen)
// =============================================================
if (window.lucide) lucide.createIcons();
