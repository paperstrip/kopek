# kopek · Cockpit financier & time-tracking

Application statique (HTML + JS vanilla + Firebase) hébergée sur GitHub Pages.
Aucune étape de build n'est nécessaire pour la faire tourner : `index.html` peut
être servi tel quel.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page (login + tableau de bord bento) |
| `app.js` | Logique métier : paliers Nessy, CRUD Firestore, assistant d'encodage |
| `game.js` | Règles du jeu — carte, armées, ressources, combat, objectifs, tours hors ligne. Aucun DOM, aucun Firestore : testable dans node |
| `world3d.js` | Rendu 3D de l'archipel (Three.js) — matières réelles et éclairage par image |
| `assets/` | Textures et carte HDR embarquées — provenance et licences dans `assets/LICENCES.md` |
| `firebase-config.js` | Initialisation Firebase Auth + Firestore |
| `styles.css` | **Généré** — feuille Tailwind compilée (voir ci-dessous) |
| `vendor/three/` | Three.js + OrbitControls vendorés (pas de CDN) |
| `.nojekyll` | Empêche GitHub Pages de filtrer des dossiers comme `vendor/` |

## Vider le cache après un déploiement

Les navigateurs (surtout Safari iOS) gardent longtemps les anciens fichiers.
Deux protections :

1. Chaque ressource est appelée avec un numéro de version (`styles.css?v=…`).
2. `index.html` lui-même peut être périmé — un `?v=` n'y change rien. La page
   compare donc au chargement sa version embarquée à celle de `version.json`
   (jamais mis en cache) et se recharge une fois sur une URL différente si elles
   diffèrent.

**À chaque déploiement, incrémentez la version dans `version.json` ET dans les
fichiers** (une simple date suffit) :

```bash
OLD=2026-09-03-15; NEW=2026-09-04-1
grep -rl "$OLD" index.html app.js city3d.js vendor/ version.json \
  | xargs sed -i "s/$OLD/$NEW/g"
```

Sans ça, un téléphone peut continuer à exécuter l'ancien JavaScript avec le
nouveau HTML.

## Régénérer `styles.css`

`styles.css` est compilé depuis les classes réellement utilisées dans
`index.html` et `app.js`. **Après avoir ajouté de nouvelles classes Tailwind,
il faut le régénérer**, sinon elles n'auront aucun effet :

```bash
npm install -D tailwindcss@3.4.17
npx tailwindcss -i tailwind-input.css -o styles.css --minify
```

Le projet utilise volontairement une feuille compilée plutôt que
`cdn.tailwindcss.com` : ce CDN est un outil de développement qui recompile tout
le CSS dans le navigateur à chaque chargement.

## Structure des données Firestore

Deux collections, filtrées par `userId` :

- **`clients`** — en réalité des *projets* : `{ name, default_rate, is_external }`.
  Les heures de tous les projets alimentent la même jauge Nessy. Un projet
  marqué `is_external: true` représente un vrai client indépendant : son chiffre
  d'affaires s'ajoute au total mais ne compte pas dans les paliers.
- **`time_logs`** — `{ client_id, description, real_minutes, billed_minutes,
  rate_applied, custom_price, date }`.
- **`game_state`** — un document par utilisateur, dont l'identifiant EST l'`uid` :
  `{ seed, lastTick, or, vivres, sceauxSpent, changes, log }`. Séparé des deux
  autres à dessein : une partie corrompue ne peut rien casser côté facturation.

⚠️ Les requêtes n'utilisent **qu'un seul filtre d'égalité** (`userId ==`) et
aucun `orderBy` Firestore : le tri et le filtrage par mois se font en JavaScript.
C'est délibéré — toute requête combinant plusieurs champs exigerait un index
composite créé à la main dans la console Firebase, faute de quoi elle échoue
silencieusement.

## ⚠️ Prérequis : base Firestore créée **et** règles publiées

Deux vérifications faites en direct sur le projet `kopek-4ffe6` via l'API
Firestore REST, jeton d'authentification valide à l'appui :

| Date | Appel | Réponse | Diagnostic |
|---|---|---|---|
| 03/09/2026 | `documents:runQuery` | `404 NOT_FOUND` · *The database (default) does not exist* | aucune base provisionnée |
| 03/09/2026 (après création) | `documents:runQuery` | `403 PERMISSION_DENIED` | base créée, mais règles par défaut du mode production = tout refusé |

Une base créée « en mode production » démarre avec `allow read, write: if false;` :
tant que les règles ci-dessous ne sont pas **publiées**, l'app ne peut ni lire ni
écrire. Un projet Firebase inexistant, lui, renvoie un `403` d'une forme
différente (`CONSUMER_INVALID`) — c'est ce qui permet de distinguer les cas.

Depuis `2026-09-03-15`, l'app diagnostique elle-même les deux situations :
elle affiche le code d'erreur réel dès qu'un écouteur le remonte, propose un
bouton « Copier les règles Firestore », et débloque le bouton « Ajouter des
heures » au lieu de le laisser définitivement inerte. Le chien de garde de
8 secondes n'écrase jamais une erreur réellement remontée et n'invente pas de
cause quand il n'en connaît aucune.

## Règles Firestore attendues

L'utilisateur connecté doit pouvoir lire/écrire ses propres documents :

```
match /{col}/{doc} {
  allow read, write: if request.auth != null
                     && request.resource.data.userId == request.auth.uid;
  allow read, delete: if request.auth != null
                     && resource.data.userId == request.auth.uid;
}
```

## Le jeu · « Les Marches de Nessy »

Un 4X asynchrone greffé sur le time-tracking, dans son propre document Firestore
(`game_state/{uid}`). Trois principes tiennent l'ensemble :

**1. Le lien avec les heures est à sens unique.** Le jeu lit les prestations,
il n'en écrit jamais. Aucune action de jeu ne peut modifier une prestation, un
projet ou la facturation — un test le vérifie explicitement. Ce que les heures
apportent :

| Heures | Effet en jeu |
|---|---|
| 1 h facturée | 1 Sceau (monnaie de guerre, sert à lever une garde d'élite) |
| 25 h · socle | +12 % d'assaut |
| 43,75 h · garantie | +25 % d'assaut, et le donjon doré apparaît sur la capitale |
| toutes périodes | comptent pour le rang du domaine, avec le nombre de territoires |

**2. Le temps passe même application fermée.** On ne stocke aucun compteur qui
« tourne » : seule la date du dernier tour résolu (`lastTick`) est persistée, et
`catchUp()` rattrape les tours écoulés au chargement. Un tour dure trois
minutes. Le rattrapage est plafonné
à 24 h — au-delà, le nombre de tours ignorés est renvoyé plutôt que passé sous
silence. Les clans adverses renforcent leurs garnisons et lancent des incursions
pendant ces tours : revenir a un enjeu.

⚠️ `lastTick` peut valoir 0. Le test `D` existe parce qu'un `||` au lieu d'un `??`
traitait cette valeur comme absente et gelait toute production.

**3. La carte n'est pas stockée.** Les 217 tuiles de terrain sont régénérées à
l'identique depuis une graine (`generateWorld`), et seules les tuiles modifiées
partent en base (`state.changes`). Un document de partie pèse quelques
centaines d'octets, pas des dizaines de kilo-octets. C'est ce qui permet une
carte vaste sans faire grossir la sauvegarde.

Le rendu dessine **les 217 tuiles**. Ce qui n'est pas exploré garde son relief
mais passe en sourdine (`fogMaterial()`), un cran plus bas, avec la bannière des
sièges de clan repérés. N'afficher que les tuiles révélées et leur lisière —
une quarantaine — donnait un monde minuscule dont on ne comprenait ni l'échelle
ni où se trouvaient les adversaires. Les socles partent en `InstancedMesh` par
couple (modèle, brume) : tout dessiner coûte moins que ne dessiner qu'un tiers
sans regroupement.

### Armées · le cœur du jeu

Sans unité qu'on déplace soi-même, il n'y a pas de jeu : on touche un hexagone,
on appuie sur un bouton, rien ne bouge. Une armée est une entité posée sur la
carte (`state.armies`), avec des points de mouvement, qu'on sélectionne, dont on
voit la portée en surbrillance, et qu'on déplace tuile par tuile.

La boucle tient en une phrase : **recruter → lever une armée → la déplacer →
entrer chez l'adversaire, c'est l'attaquer.**

- `reachable()` fait un parcours en largeur borné par les points de mouvement.
  Les cases hostiles sont marquées `attack` : on peut toujours frapper un
  voisin, mais l'assaut consomme tout le mouvement restant — pas de raid en
  chaîne dans le même tour.
- Le rendu colore la portée : **bleu** pour un déplacement, **rouge** pour un
  assaut. La couleur dit ce qui va se passer avant qu'on touche.
- Lever une armée laisse toujours une troupe en garnison. Un territoire vidé
  tomberait à la première incursion sans que le joueur comprenne pourquoi.
- `clanTurn()` fait marcher les clans : ils lèvent des colonnes depuis leurs
  places fortes et avancent d'un pas par tour vers le territoire joueur le plus
  proche. Sans adversaire qui bouge, la carte est un décor.

⚠️ Il n'y a **qu'un seul** système d'attaque. L'ancienne attaque de tuile à tuile
depuis le panneau a été retirée : deux mécaniques concurrentes rendaient le jeu
illisible.

### Objectifs · ce qui rend le jeu compréhensible

Un jeu sans but affiché n'est qu'une carte d'hexagones. `OBJECTIVES` enchaîne
six étapes — coloniser, produire, lever une armée, prendre un repaire, toucher
un clan, prendre son siège — chacune avec une **consigne concrète** et une
récompense. `nextStepHint()` calcule à tout moment la phrase « que faire
maintenant » à partir de l'état réel : elle change quand l'or manque.

⚠️ Un objectif doit être hors de portée au premier chargement. Le seuil de
garnison est à 9 parce que la capitale en démarre avec 6 : à 5, l'objectif se
validait tout seul avant le premier clic, ce qui apprend au joueur que les
objectifs ne veulent rien dire.

Les combats renvoient leur rapport de force chiffré (`attack()` expose
`result` et `bonus`). « Assaut repoussé » sans chiffres ne dit pas au joueur ce
qu'il a raté.

### Direction artistique · modèles réels

**Le décor n'est plus généré par du code.** Trois tentatives successives —
géométrie procédurale, textures PBR réelles, matcaps — ont buté sur la même
limite : on peut habiller une forme, on ne peut pas lui inventer une silhouette.
Or c'est la silhouette qui se lit de loin.

Les modèles viennent du **KayKit Medieval Hexagon Pack** (CC0), embarqué dans
`assets/models/` — voir `assets/LICENCES.md` pour le détail et la façon d'en
changer.

- `loadModels()` charge les 31 `.gltf` au démarrage du jeu et force un redessin
  à leur arrivée : sans ça la carte resterait vide jusqu'au prochain coup joué.
- ⚠️ Montagnes et collines du pack **embarquent leur propre socle hexagonal**.
  Les poser sur une tuile d'herbe donnait des dalles grises flottantes : elles
  remplacent la tuile (`tileModel()`), elles ne s'y ajoutent pas.
- ⚠️ Le château est modélisé pour occuper plusieurs tuiles. À l'échelle 1 il
  écrase ses voisines ; `SCALE_CASTLE` le ramène à un hexagone.
- La sélection tape sur un hexagone plat invisible (`GEO.pick`), pas sur les
  maillages du décor : viser un arbre ou un toit rendait le toucher imprévisible.
- L'atlas du pack doit être déclaré en sRGB à l'import, sinon tout ressort
  délavé.

Les tuiles inconnues utilisent le modèle d'eau : le brouillard de guerre devient
une mer qu'on n'a pas encore franchie, au lieu d'un tapis d'hexagones gris.

### Voir ce qui se passe · le reproche le plus juste

« On ne voit pas d'activité, comment on attaque, comment on se fait attaquer ? »
Le moteur faisait déjà tout cela ; rien n'en arrivait à l'écran. Quatre causes,
toutes corrigées :

- **Le tour durait dix minutes.** Une partie ouverte dix minutes ne montrait
  donc rien. `TICK_MS` est passé à trois minutes.
- **Les clans ne sortaient presque jamais de chez eux** : levée à 25 % depuis
  les seules places à cinq troupes. Désormais la première colonne part
  systématiquement, puis une chance sur deux, dès quatre troupes.
- **Les colonnes ennemies étaient invisibles dans la brume** (`drawArmies()`
  écartait les tuiles non révélées). On perdait un territoire sans avoir rien
  vu venir. Elles sont maintenant dessinées, posées plus bas et sans jetons :
  on voit qu'une colonne approche, pas encore sa force exacte.
- **Aucune trace des combats.** `pushMark()` pose une marque datée sur la case ;
  `recentMarks()` renvoie celles de la dernière demi-heure, que le rendu affiche
  en deux lames croisées, vertes ou rouges.

S'y ajoutent `menaces(state, tiles)` — les colonnes adverses triées par distance
à vos terres — affichée dans le bandeau rouge `#g-menace`, qui sélectionne la
colonne quand on le touche, et le journal des Chroniques désormais ouvert par
défaut : replié, il ne racontait rien à personne.

### Diagnostics du rendu

`debugMeshesAt(x, z)` renvoie les dimensions monde des volumes posés autour d'un
point ; `debugArmyMeshesAt(x, z)` compte les maillages d'armée. Écrits après une
séance à supposer pourquoi le bâti paraissait plat : la géométrie était juste,
seules les proportions étaient trop basses. Mesurer a tranché en un appel.

⚠️ **Le banc d'essai rend à moins d'une image par seconde** (GL logiciel
swiftshader). Les aides de Playwright qui attendent deux images stables —
`scrollIntoViewIfNeeded` en tête — expirent donc sans que l'application n'ait
rien à se reprocher. Les suites scrollent au niveau du DOM. Ce plancher ne dit
rien des performances sur un vrai GPU.

### Le banc d'essai se régénère

`_app_test.js`, `_index_test.html` et `_mock-firebase-config.js` sont
**produits** par `gen.mjs` (dans le dossier de travail, hors dépôt) à partir de
`app.js`, `index.html` et d'une doublure Firebase qui vit elle aussi hors dépôt.
Les recopier à la main revient tôt ou tard à tester une version périmée de
l'application — et supprimer la doublure avant un commit, sans copie ailleurs,
revient à la perdre. C'est arrivé une fois ; le générateur est la réponse.

⚠️ Un test qui fait `import('./world3d.js?v=autre-chose')` obtient une **seconde
instance** du module, avec ses groupes vides : il mesurerait une scène qui
n'existe pas. Les suites passent par `window.__world`, l'instance réellement
utilisée par l'application.

### Lire la carte · à qui est ce territoire

Une case sans bâtiment n'avait aucune couleur de camp : rien, en regardant la
carte, ne disait ce qui était à soi et ce qui était à l'adversaire.
`drawFrontieres()` pose sur chaque case possédée un anneau hexagonal à la
couleur du camp — doré pour le joueur, la couleur du clan sinon, en sourdine
dans la brume. Les anneaux partent en `InstancedMesh` par couleur, et
`debugFrontieres()` permet de les vérifier depuis un test.

Le bouton « Attaquer » n'apparaît plus que là où l'assaut est réellement sur la
table : une armée à portée, ou une case qui touche vos terres. Le proposer,
grisé, sur les deux cents cases de la carte n'offrait pas un choix, seulement du
bruit. Ailleurs, `situation()` dit en une phrase ce qu'est la case et à quelle
distance elle se trouve — un panneau qui annonce « aucune action possible ici »
sans dire pourquoi laisse croire que le jeu est cassé.

⚠️ Conséquence voulue : sur une carte neuve, **aucun** repaire ne touche la
capitale (ils commencent à deux cases), donc aucun bouton d'attaque tant qu'on
n'a pas colonisé. C'est l'ordre que les objectifs demandent déjà.

## Écritures optimistes · pourquoi le mock de test est asynchrone

Les écouteurs `onSnapshot` ne rappellent **jamais** de façon synchrone, même
pour une écriture servie par le cache local : le rappel arrive au tour de boucle
suivant. Tout code qui enchaîne « je crée, puis je relis `STATE` » travaille donc
sur un état périmé. C'est ce qui cassait la création d'un projet depuis
l'assistant : la liste déroulante était repeuplée avant l'arrivée de
l'instantané, le projet neuf n'y figurait pas, la sélection retombait dans le
vide et l'assistant restait bloqué à l'étape 1.

`createClient` et `createLog` insèrent donc l'objet dans `STATE` immédiatement
(`upsertLocal`, dédoublonné par identifiant) avant de rendre la main.
L'instantané qui suit porte le même identifiant et remplace simplement l'entrée.

⚠️ Le mock utilisé par les tests notifie ses écouteurs via `setTimeout(…, 0)`,
**délibérément**. Une notification synchrone masquait entièrement ce bug : la
suite A→Z passait au vert alors que l'application réelle était inutilisable.

## Périmètre volontairement restreint

L'app ne calcule **que** la facturation : heures prestées, minimum garanti de
3 500 € (25 h de socle puis régie à 80 €/h jusqu'à 43,75 h), et surplus
facturable au-delà. Il n'y a volontairement ni TVA, ni INASTI, ni provision
d'impôt, ni charges fixes : ces estimations demandaient des frais
professionnels réels que l'app n'a pas, et donnaient un « reste net » trompeur.
