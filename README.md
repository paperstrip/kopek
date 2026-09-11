# kopek · Cockpit financier & time-tracking

Application statique (HTML + JS vanilla + Firebase) hébergée sur GitHub Pages.
Aucune étape de build n'est nécessaire pour la faire tourner : `index.html` peut
être servi tel quel.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page (login + tableau de bord bento) |
| `app.js` | Logique métier : paliers Nessy, CRUD Firestore, assistant d'encodage |
| `empire.js` | Règles du jeu — carte, villes, unités, technologies, combat, IA, tours. N'importe rien : testable dans node |
| `carte3d.js` | Rendu 3D de la carte (Three.js) — modèles KayKit, éclairage HDR, animation |
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

## Le jeu · « L'Empire de Nessy »

Un jeu de conquête au tour par tour dans la lignée de Civilization, greffé sur
le suivi du temps, dans son propre document Firestore (`game_state/{uid}`).

**Le lien avec les heures est à sens unique et il est étroit.** Le jeu lit les
prestations, il n'en écrit jamais :

| Heures | Effet en jeu |
|---|---|
| 1 h facturée | 3 tours de jeu |
| 25 h · socle | +10 % à l'assaut |
| 43,75 h · garantie | +20 % à l'assaut |

`empire.js` **n'importe rien** : ni Firestore, ni le DOM, ni three.js. Un test
lit le fichier source pour le vérifier, parce qu'une règle qu'on ne peut pas
enfreindre vaut mieux qu'une règle qu'on promet de respecter.

### « Je fais quoi, là, maintenant ? »

C'est la question qui tue un jeu de stratégie quand elle reste sans réponse — et
elle est restée sans réponse : une partie réelle a atteint le **tour 33 avec une
seule ville et zéro tour en réserve**. L'objectif disait « fondez une deuxième
ville » sans dire ni où était le colon, ni sur quoi appuyer. Sur un téléphone,
retrouver un pion de trois millimètres parmi 271 hexagones est un jeu en soi, et
ce n'est pas celui-là qu'on voulait faire jouer.

Trois réponses, toutes visibles à l'écran :

- `prochaineAction()` renvoie **un seul geste**, avec la case concernée : fonder
  ici, éloigner ce colon, mettre cette ville en chantier, déplacer cette unité,
  ou finir le tour. Le bandeau de consigne ne se cache jamais, même quand un
  panneau s'ouvre — le masquer, c'est le retirer au moment où il sert.
- Le bouton **Montrer** cadre la caméra sur la case, la sélectionne et ouvre le
  bon panneau.
- `enSuspens()` alimente un avertissement au premier appui sur « Tour suivant »
  quand des villes ne construisent rien ou que des unités n'ont pas bougé. On ne
  bloque pas ; on prévient une fois.

Et une **légende des camps** en permanence sur la carte, parce que sans elle le
joueur en est réduit à « des zones jaunes, moi j'imagine, et des zones rouges ».

### Une partie sans fin

Il n'y a **ni victoire ni défaite**. Le jeu se joue pendant des mois à côté des
heures encodées : un écran de fin l'arrêterait net, et une partie terminée est
une partie qu'on ne rouvre plus. Soumettre un peuple est un jalon, pas une
conclusion.

Quatre mécanismes entretiennent le monde :

- **L'horizon recule.** Les 817 tuiles sont engendrées d'un coup jusqu'à
  `RAYON_MONDE`, mais seul un disque de rayon `etat.rayon` fait partie du monde ;
  il grandit quand l'empire s'en approche. Engendrer au fur et à mesure aurait
  cassé le déterminisme : les terrains sont attribués par quantiles sur
  l'ensemble des terres, donc ajouter une couronne changerait rétroactivement le
  terrain des cases déjà découvertes.
- **Des peuples sans fin.** Six en réserve, puis `peupleEngendre(n)` compose nom
  et couleur — il y en a toujours un de plus.
- **Les empires se fissurent.** Au-delà de six villes, une province entière peut
  faire sécession sous une nouvelle bannière, et la région qui se détache grandit
  avec l'empire.
- **L'exil plutôt que la mort.** Perdre sa dernière ville fait repartir vos
  derniers fidèles avec un colon ; perdre sa capitale déplace la cour.

⚠️ **Une capitale prise cesse d'en être une.** Sans cette règle, un conquérant
accumulait les capitales — cinquante pour un seul peuple — plus aucune ville ne
pouvait faire sécession, et le monde se figeait définitivement autour de lui.
C'est le bug qui gelait les parties longues au tour 232.

La simulation le vérifie sur 220 tours : le plus gros empire plafonne sous
trente villes là où il montait à cinquante, il reste toujours des adversaires, et
le journal vit encore au dernier tour.

La recherche non plus ne s'arrête pas : après l'arbre, les **édits** se
repromulguent indéfiniment, chacun plus cher que le précédent. Les jalons
continuent de la même façon (`jalonEngendre`), et le titre du domaine passe de
Hameau à « Empire · 18ᵉ couronne » sans plafond.

### Des tours, pas une horloge

Rien ne bouge sans le joueur : le monde n'avance que lorsqu'il termine un tour.
La réserve se recharge d'un tour toutes les quatre minutes, plafonnée à 40, et
démarre à 20. Elle a d'abord été bien plus avare — huit tours au départ, un
toutes les douze minutes — et c'est ce qui a enfermé une vraie partie au tour 33
sans plus aucun coup jouable. C'est ce qui règle d'un coup le reproche « il
ne se passe rien » : il y a toujours un coup à jouer, et c'est le joueur qui
fait avancer le monde.

⚠️ Les heures déjà converties en tours sont mémorisées dans `toursAccordes` :
sans ça, le même total en redonnerait à chaque ouverture de la page.

### Les villes font tout

Une ville exploite sa case centrale plus une case par habitant, choisies parmi
les meilleures de son territoire. Nourriture pour grandir, production pour la
file de chantier, or pour l'entretien. Les frontières s'étendent avec la
culture, et sept bâtiments changent ces équilibres.

⚠️ La case centrale a un **plancher** de rendement. Sans lui, une capitale
tombée sur des collines aurifères affichait un surplus nul : le joueur voyait
de l'or s'entasser sans que rien ne grandisse jamais.

### Le combat

Des points de vie des deux côtés, pas un tirage en tout ou rien : `degats()`
donne 30 à forces égales, 79 au double, 11 à la moitié. Le terrain, la
fortification et les murailles entrent dans la défense. Une ville se défend même
sans garnison et répare ses murs chaque tour — il faut un siège pour la prendre,
et c'est vrai pour le joueur comme pour les rivaux.

**La victoire est aux capitales**, pas à chaque hameau : prendre la capitale
d'un peuple le fait capituler, et ses villes rejoignent votre bannière. Avec
trois rivaux à trois villes, la conquête exhaustive demandait une dizaine de
sièges et la partie n'avait plus de fin lisible.

### L'équilibre vient de la simulation, pas du goût

`equilibre.mjs` fait jouer un joueur volontairement médiocre et compte les
survivants. Trois verdicts successifs :

- **balayé au tour 10** : les villes tombaient en trois coups d'épée ;
- **balayé au tour 51** : les trois rivaux montaient à treize villes contre une ;
- **survit** : villes qui valent un siège, rivaux plafonnés à trois villes,
  joueur qui démarre avec deux colons, paix garantie jusqu'au tour 14.

### La carte

817 tuiles régénérées depuis une graine, dont 271 dans le monde connu au premier
tour ; seules les cases modifiées partent en base, donc une partie pèse 7 Ko. Les terrains sont attribués **par quantiles**
sur deux champs continus (altitude, humidité) : comparer à des seuils absolus
dépendait de l'échelle du bruit et donnait cent quarante-cinq montagnes sur deux
cent soixante-et-onze.

⚠️ Les rivaux sont posés sur un **anneau hexagonal**, pas sur un cercle
trigonométrique : `cos/sin` sur des coordonnées axiales donne des distances qui
vont du simple au double selon l'angle.

### Le rendu · `carte3d.js`

⚠️ **Le socle du pack mesure 2,0 de plat à plat**, soit un hexagone de rayon
2/√3 ≈ 1,1547. En espaçant les tuiles de 1,0, elles se chevauchaient de 13 % :
les falaises d'une tuile ressortaient à travers sa voisine et le relief semblait
empilé plutôt que continu. `HEX` vaut donc `2 / Math.sqrt(3)`, et les socles se
touchent — il ne reste que la falaise du littoral.

Sur du plat, des socles parfaitement uniformes font ressortir chaque couture
d'hexagone : la carte ressemble alors à un carrelage. Chaque case reçoit une
des six nuances de sa teinte de terrain (±9 %), et le décor est trois fois plus
dense sur prairie et plaine. C'est ce qui brouille la grille.

### Plein écran

Sur téléphone, le même glissement fait défiler la page **et** tourner la carte,
et c'est la page qui gagne. Le bouton plein écran règle cela. iOS refuse
`requestFullscreen` sur autre chose qu'une vidéo : on se rabat alors sur la
classe `.jeu-plein` (`position: fixed`, `100dvh`), qui résout le vrai problème
même sans API native.

### Commander ses unités

Un bouton « unité suivante » fait le tour des unités qui ont encore du
mouvement, cadre dessus et les sélectionne. Sans lui, commander une armée
revient à retrouver chaque pion à l'œil sur 271 hexagones.



Modèles KayKit (CC0, voir `assets/LICENCES.md`), éclairage d'ambiance HDR,
ombres douces, socles en `InstancedMesh`. Ce qui sépare un prototype d'un jeu
tient surtout à quatre choses, et c'est là qu'est l'effort : la lumière, la
caméra, l'animation, et le fait que chaque chose affichée réponde à une question
du joueur.

Trois pièges payés comptant :

- **Prairie, plaine et désert partagent le même modèle d'hexagone.** Sans teinte
  par terrain, la carte est un aplat où rien ne se distingue.
- **La teinte du bâti doit suivre la couleur du peuple.** Le joueur avait des
  bâtiments bleus et une frontière dorée, un rival l'inverse : illisible.
- **Les unités empilées sur la capitale étaient invisibles** sous le château, et
  contredisaient la règle « une unité par case » que le déplacement applique
  déjà. Elles se répartissent au départ.

La caméra vise **votre capitale**, pas le centre géométrique de la carte : elle
n'y est pas, et le jeu s'ouvrait sur un coin de prairie vide.

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
