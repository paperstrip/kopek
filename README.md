# kopek · Cockpit financier & time-tracking

Application statique (HTML + JS vanilla + Firebase) hébergée sur GitHub Pages.
Aucune étape de build n'est nécessaire pour la faire tourner : `index.html` peut
être servi tel quel.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page (login + tableau de bord bento) |
| `app.js` | Logique métier : paliers Nessy, CRUD Firestore, assistant d'encodage |
| `game.js` | Règles du jeu — carte, ressources, combat, tours hors ligne. Aucun DOM, aucun Firestore : testable dans node |
| `world3d.js` | Rendu 3D de l'archipel (Three.js) — géométries sculptées et textures procédurales |
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
OLD=2026-09-03-13; NEW=2026-09-04-1
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

Depuis `2026-09-03-13`, l'app diagnostique elle-même les deux situations :
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
`catchUp()` rattrape les tours écoulés au chargement. Le rattrapage est plafonné
à 24 h — au-delà, le nombre de tours ignorés est renvoyé plutôt que passé sous
silence. Les clans adverses renforcent leurs garnisons et lancent des incursions
pendant ces tours : revenir a un enjeu.

⚠️ `lastTick` peut valoir 0. Le test `D` existe parce qu'un `||` au lieu d'un `??`
traitait cette valeur comme absente et gelait toute production.

**3. La carte n'est pas stockée.** Les 61 tuiles de terrain sont régénérées à
l'identique depuis une graine (`generateWorld`), et seules les tuiles modifiées
partent en base (`state.changes`). Un document de partie pèse quelques
centaines d'octets, pas des dizaines de kilo-octets.

### Direction artistique

Ni low-poly ni photoréaliste : des volumes sculptés et des textures calculées au
chargement. Aucun fichier d'assets — le CDN est inaccessible depuis cette page et
un binaire dans le dépôt serait à retélécharger à chaque visite.

- `sculpt()` déforme un icosaèdre par du bruit fractal : c'est ce qui donne des
  houppiers et des rochers organiques plutôt que des sphères.
- `lathe()` tourne un profil pour les troncs, tentes et cheminées.
- Les toits sont des prismes à deux pans, jamais des cônes.
- `grainTexture()` / `bumpTexture()` / `strataTexture()` peignent les matières
  dans un canvas 2D et fournissent la carte de relief qui accroche la lumière.

`debugMeshesAt(x, z)` renvoie les dimensions monde des volumes posés autour d'un
point. Écrit après une séance à supposer pourquoi le bâti paraissait plat : la
géométrie était juste, seules les proportions étaient trop basses. Mesurer a
tranché en un appel.

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
