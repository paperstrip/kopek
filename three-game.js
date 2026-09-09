import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let scene;
let camera;
let renderer;
let controls;
let canvasElement;
let containerElement;
let worldRoot;
let raycaster;
let mouse;
let hoveredObject = null;
let selectedObject = null;
let isInitialized = false;
let assetsReady = false;
let pendingWorldData = null;

const textureLoader = new THREE.TextureLoader();
const textures = {};
const interactiveObjects = [];
const dynamicActors = [];
const focusTargets = new Map();

function loaderEl() { return document.getElementById('empire-loader'); }
function loaderTextEl() { return document.getElementById('empire-loader-text'); }

function setLoader(visible, text = '') {
  const el = loaderEl();
  if (!el) return;
  el.classList.toggle('hidden', !visible);
  if (text && loaderTextEl()) loaderTextEl().textContent = text;
}

async function loadTexture(url, repeatX = 1, repeatY = 1) {
  const tex = await textureLoader.loadAsync(url);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

async function ensureAssets() {
  if (assetsReady) return;
  setLoader(true, 'Chargement des textures de terrain, de pierre et des surfaces maritimes…');

  [
    textures.grass,
    textures.stoneColor,
    textures.stoneNormal,
    textures.stoneRough,
    textures.woodColor,
    textures.waterNormal,
  ] = await Promise.all([
    loadTexture('./assets/textures/sol_herbe.jpg', 6, 6),
    loadTexture('./assets/textures/mur_couleur.jpg', 2, 2),
    loadTexture('./assets/textures/mur_relief.jpg', 2, 2),
    loadTexture('./assets/textures/mur_rugosite.jpg', 2, 2),
    loadTexture('./assets/textures/bois_couleur.jpg', 2, 2),
    loadTexture('./assets/textures/eau_normales.jpg', 8, 8),
  ]);

  assetsReady = true;
  if (pendingWorldData) {
    rebuildWorld(pendingWorldData);
    pendingWorldData = null;
  }
  setLoader(false);
}

function clearWorld() {
  if (!worldRoot) return;
  while (worldRoot.children.length) worldRoot.remove(worldRoot.children[0]);
  interactiveObjects.length = 0;
  dynamicActors.length = 0;
  focusTargets.clear();
}

function stoneMaterial(tint = 0xffffff) {
  return new THREE.MeshStandardMaterial({
    color: tint,
    map: textures.stoneColor,
    normalMap: textures.stoneNormal,
    roughnessMap: textures.stoneRough,
    roughness: 1,
    metalness: 0.04,
  });
}

function roofMaterial(tint = 0x8b5e3c) {
  return new THREE.MeshStandardMaterial({
    color: tint,
    map: textures.woodColor,
    roughness: 0.95,
    metalness: 0.03,
  });
}

function grassMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xa8c57e,
    map: textures.grass,
    roughness: 1,
    metalness: 0,
  });
}

function waterMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: 0x2d5f89,
    metalness: 0.1,
    roughness: 0.15,
    transmission: 0.02,
    thickness: 1,
    clearcoat: 0.9,
    clearcoatRoughness: 0.12,
    normalMap: textures.waterNormal,
    normalScale: new THREE.Vector2(0.5, 0.5),
  });
}

function setMaterialHighlight(object, active) {
  if (!object || !object.material) return;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  materials.forEach((mat) => {
    if (!('emissive' in mat)) return;
    mat.emissive = new THREE.Color(active ? 0x6d28d9 : 0x000000);
    mat.emissiveIntensity = active ? 0.22 : 0;
  });
}

function attachInspectable(mesh, data, focusKey = null) {
  mesh.userData = { ...data, inspectable: true, focusKey };
  interactiveObjects.push(mesh);
}

function createSkyDome() {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#2b1e38');
  grad.addColorStop(0.28, '#4b6587');
  grad.addColorStop(0.54, '#9dbad2');
  grad.addColorStop(1, '#e5d6b8');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 16, 512);
  const tex = new THREE.CanvasTexture(canvas);
  const geo = new THREE.SphereGeometry(720, 36, 18);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide });
  const sky = new THREE.Mesh(geo, mat);
  scene.add(sky);
}

function createSunGlow() {
  const spriteCanvas = document.createElement('canvas');
  spriteCanvas.width = 256;
  spriteCanvas.height = 256;
  const ctx = spriteCanvas.getContext('2d');
  const grad = ctx.createRadialGradient(128, 128, 10, 128, 128, 120);
  grad.addColorStop(0, 'rgba(255,242,204,1)');
  grad.addColorStop(0.2, 'rgba(255,217,102,0.65)');
  grad.addColorStop(0.55, 'rgba(245,158,11,0.16)');
  grad.addColorStop(1, 'rgba(245,158,11,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(spriteCanvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.position.set(-220, 155, -180);
  sprite.scale.set(130, 130, 1);
  scene.add(sprite);
}

function setupLighting() {
  scene.add(new THREE.AmbientLight(0xd6d0c7, 0.52));

  const hemi = new THREE.HemisphereLight(0xc7dbef, 0x6b5b3f, 0.9);
  hemi.position.set(0, 140, 0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1cf, 2.65);
  sun.position.set(-120, 150, -70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 480;
  sun.shadow.camera.left = -180;
  sun.shadow.camera.right = 180;
  sun.shadow.camera.top = 180;
  sun.shadow.camera.bottom = -180;
  sun.shadow.bias = -0.0002;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0xb8d3f0, 0.55);
  fill.position.set(100, 60, 120);
  scene.add(fill);

  createSunGlow();
}

function createMountainRing() {
  const group = new THREE.Group();
  const mat = stoneMaterial(0xcdbfae);
  for (let i = 0; i < 18; i++) {
    const angle = (i / 18) * Math.PI * 2;
    const radius = 240 + ((i % 3) * 16);
    const height = 42 + ((i % 4) * 16);
    const geo = new THREE.ConeGeometry(16 + (i % 5) * 6, height, 8);
    const mesh = new THREE.Mesh(geo, mat.clone());
    mesh.position.set(Math.cos(angle) * radius, height / 2 - 8, Math.sin(angle) * radius);
    mesh.rotation.y = angle;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  worldRoot.add(group);
}

function createOcean() {
  const oceanGeo = new THREE.CircleGeometry(320, 64);
  const oceanMat = waterMaterial();
  const ocean = new THREE.Mesh(oceanGeo, oceanMat);
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = -2;
  ocean.receiveShadow = true;
  worldRoot.add(ocean);

  dynamicActors.push({
    update(time) {
      oceanMat.normalMap.offset.x = (time * 0.01) % 1;
      oceanMat.normalMap.offset.y = (time * 0.008) % 1;
    },
  });
}

function createIsland(radius = 20, height = 5, position = new THREE.Vector3(), topTint = 0xffffff) {
  const group = new THREE.Group();
  group.position.copy(position);

  const sideMat = stoneMaterial(0xb79f83);
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 1.08, height, 28),
    sideMat,
  );
  body.position.y = height / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const top = new THREE.Mesh(
    new THREE.CircleGeometry(radius - 0.25, 28),
    grassMaterial(),
  );
  top.rotation.x = -Math.PI / 2;
  top.position.y = height + 0.02;
  top.receiveShadow = true;
  top.material.color.multiply(new THREE.Color(topTint));
  group.add(top);

  return { group, topY: height };
}

function createRoad(points, width = 2.8, tint = 0xc4a66e) {
  const curve = new THREE.CatmullRomCurve3(points);
  const geo = new THREE.TubeGeometry(curve, 64, width, 8, false);
  const mat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function createTree(scale = 1) {
  const group = new THREE.Group();

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18 * scale, 0.24 * scale, 1.8 * scale, 8),
    new THREE.MeshStandardMaterial({ color: 0x6d4c32, roughness: 1 }),
  );
  trunk.position.y = 0.9 * scale;
  trunk.castShadow = true;
  group.add(trunk);

  const leafMat = new THREE.MeshStandardMaterial({ color: 0x517e35, roughness: 1 });
  const leaves = new THREE.Mesh(new THREE.SphereGeometry(1.1 * scale, 8, 8), leafMat);
  leaves.position.y = 2.35 * scale;
  leaves.castShadow = true;
  group.add(leaves);

  return group;
}

function scatterTrees(group, radius, count, y = 0) {
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.35;
    const dist = radius * (0.45 + Math.random() * 0.42);
    const tree = createTree(0.72 + Math.random() * 0.35);
    tree.position.set(Math.cos(angle) * dist, y, Math.sin(angle) * dist);
    group.add(tree);
  }
}

function createColumnHall(width, depth, levels = 1) {
  const group = new THREE.Group();
  const stone = stoneMaterial(0xf0e1c4);
  const roof = roofMaterial(0x8f5d44);

  const podium = new THREE.Mesh(new THREE.BoxGeometry(width, 2.2, depth), stone);
  podium.position.y = 1.1;
  podium.castShadow = true;
  podium.receiveShadow = true;
  group.add(podium);

  const colCount = Math.max(4, Math.round(width / 2.4));
  const spacing = width / (colCount - 1);
  for (let row = 0; row < 2; row++) {
    const z = row === 0 ? -depth * 0.32 : depth * 0.32;
    for (let i = 0; i < colCount; i++) {
      const x = -width / 2 + (i * spacing);
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.46, 5.8, 10), stone);
      col.position.set(x, 4.7, z);
      col.castShadow = true;
      group.add(col);
    }
  }

  const body = new THREE.Mesh(new THREE.BoxGeometry(width * 0.84, 5.4 + levels, depth * 0.62), stoneMaterial(0xe0cfb0));
  body.position.y = 5.3 + (levels * 0.5);
  body.castShadow = true;
  group.add(body);

  const roofBase = new THREE.Mesh(new THREE.BoxGeometry(width + 1.2, 1.1, depth + 1.2), stoneMaterial(0xd7c1a2));
  roofBase.position.y = 8.6 + levels;
  roofBase.castShadow = true;
  group.add(roofBase);

  const roofMesh = new THREE.Mesh(new THREE.ConeGeometry(width * 0.62, 4 + levels * 0.6, 4), roof);
  roofMesh.position.y = 11.2 + levels;
  roofMesh.rotation.y = Math.PI / 4;
  roofMesh.castShadow = true;
  group.add(roofMesh);

  return group;
}

function createTemple(label = 'Temple', scale = 1) {
  const temple = createColumnHall(10 * scale, 14 * scale, 1);
  temple.userData.label = label;
  return temple;
}

function createForum(scale = 1) {
  const group = new THREE.Group();
  const stone = stoneMaterial(0xe8dcc2);
  const plaza = new THREE.Mesh(new THREE.BoxGeometry(18 * scale, 0.7, 18 * scale), stoneMaterial(0xe0d4bf));
  plaza.position.y = 0.35;
  plaza.receiveShadow = true;
  group.add(plaza);

  const statueBase = new THREE.Mesh(new THREE.CylinderGeometry(1.6 * scale, 1.9 * scale, 2.4 * scale, 12), stone);
  statueBase.position.y = 1.2 * scale;
  statueBase.castShadow = true;
  group.add(statueBase);

  const statue = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * scale, 0.8 * scale, 4.2 * scale, 6), stoneMaterial(0xf8f4e8));
  statue.position.y = 4.2 * scale;
  statue.castShadow = true;
  group.add(statue);

  return group;
}

function createTower(height = 14, tint = 0xcfb596) {
  const group = new THREE.Group();
  const mat = stoneMaterial(tint);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 3.2, height, 10), mat);
  body.position.y = height / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const crown = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 1.8, 10), stoneMaterial(0xe6dbc4));
  crown.position.y = height + 0.9;
  crown.castShadow = true;
  group.add(crown);

  return group;
}

function createWallRing(radius, height = 3.4) {
  const group = new THREE.Group();
  const segments = 18;
  const stone = stoneMaterial(0xd3c2a5);
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const segment = new THREE.Mesh(new THREE.BoxGeometry(4.6, height, 1.2), stone);
    segment.position.set(Math.cos(angle) * radius, height / 2, Math.sin(angle) * radius);
    segment.lookAt(0, height / 2, 0);
    segment.castShadow = true;
    segment.receiveShadow = true;
    group.add(segment);
  }
  return group;
}

function createHarbor(scale = 1) {
  const group = new THREE.Group();
  const dockMat = roofMaterial(0x6a4b35);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8 * scale, 0.8, 18 * scale), dockMat);
  deck.position.set(0, 0.4, 0);
  deck.castShadow = true;
  deck.receiveShadow = true;
  group.add(deck);

  for (let i = -1; i <= 1; i++) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 3.2, 8), roofMaterial(0x4b3426));
    post.position.set(i * 2.2 * scale, 1.6, 8 * scale);
    post.castShadow = true;
    group.add(post);
  }
  return group;
}

function createShip(color = 0xaa5a35, scale = 1) {
  const group = new THREE.Group();
  const hull = new THREE.Mesh(
    new THREE.BoxGeometry(2.4 * scale, 1.1 * scale, 8.2 * scale),
    roofMaterial(color),
  );
  hull.position.y = 0.55 * scale;
  hull.castShadow = true;
  group.add(hull);

  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12 * scale, 0.12 * scale, 6 * scale, 8),
    new THREE.MeshStandardMaterial({ color: 0x5e4630, roughness: 1 }),
  );
  mast.position.y = 3.5 * scale;
  mast.castShadow = true;
  group.add(mast);

  const sail = new THREE.Mesh(
    new THREE.PlaneGeometry(2.8 * scale, 3.4 * scale),
    new THREE.MeshStandardMaterial({ color: 0xf7f0dd, side: THREE.DoubleSide, roughness: 1 }),
  );
  sail.position.set(0, 3.7 * scale, -0.1);
  group.add(sail);

  return group;
}

function createBanner(color = '#8b5cf6', height = 10) {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.1, height, 8),
    new THREE.MeshStandardMaterial({ color: 0x4d3524, roughness: 1 }),
  );
  pole.position.y = height / 2;
  pole.castShadow = true;
  group.add(pole);

  const cloth = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 2.2),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(color), side: THREE.DoubleSide, roughness: 0.8 }),
  );
  cloth.position.set(1.6, height - 1.1, 0);
  group.add(cloth);

  dynamicActors.push({
    update(time) {
      cloth.rotation.y = Math.sin(time * 1.3 + height) * 0.18;
      cloth.position.z = Math.sin(time * 1.6 + height) * 0.55;
    },
  });

  return group;
}

function addProvinceLabel(group, title, subtitle, color = '#f59e0b') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');

  const roundedRect = (x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  ctx.fillStyle = 'rgba(7,11,18,0.86)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  roundedRect(10, 10, 492, 140, 28);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font = '700 20px Inter, sans-serif';
  ctx.fillText(title, 26, 54);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 34px Inter, sans-serif';
  ctx.fillText(subtitle, 26, 106);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(18, 5.6, 1);
  group.add(sprite);
  return sprite;
}

function createProvinceIsland(province, index, total, empireView) {
  const angle = (index / Math.max(1, total)) * Math.PI * 2 + Math.PI / 6;
  const radius = 92 + ((index % 2) * 12);
  const position = new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
  const island = createIsland(province.controlled ? 16 : 14, province.controlled ? 5 : 4, position, province.controlled ? 0xffffff : 0xdcd3bd);
  const group = island.group;

  const harborDir = new THREE.Vector3().copy(position).normalize();
  const harborPoint = new THREE.Vector3(-harborDir.x * 10, island.topY, -harborDir.z * 10);

  if (province.controlled) {
    const fort = createTemple(province.name, province.isMain ? 1.32 : 0.92);
    fort.position.y = island.topY;
    group.add(fort);

    const wall = createWallRing(province.isMain ? 18 : 8.5, province.isMain ? 4 : 2.6);
    wall.position.y = island.topY;
    group.add(wall);

    if (province.isMain) {
      const forum = createForum(1.1);
      forum.position.set(-10, island.topY, 2);
      group.add(forum);

      const towerA = createTower(18 + Math.min(10, empireView.state.provinces * 2), 0xd7cab2);
      towerA.position.set(11, island.topY, -3);
      group.add(towerA);

      const towerB = createTower(14 + Math.min(8, empireView.state.legions), 0xc7b18f);
      towerB.position.set(14, island.topY, 9);
      group.add(towerB);

      const monument = createTower(22 + empireView.state.wonders * 6, 0xf0e1c0);
      monument.position.set(1, island.topY, -13);
      group.add(monument);

      if (empireView.state.wonders > 0) {
        const wonder = createColumnHall(16, 18, 2);
        wonder.position.set(-4, island.topY, 13);
        group.add(wonder);
        attachInspectable(wonder.children[1], {
          clan: province.name,
          name: 'Merveille impériale',
          district: 'Acropole monumentale',
          status: `${empireView.state.wonders} merveille(s) érigée(s)`,
          hours: `${empireView.state.prestige} prestige · ${empireView.state.stability}% stabilité`,
        }, province.key);
      }
    } else {
      const tower = createTower(10 + Math.min(10, province.hours * 0.45), 0xd6c2a0);
      tower.position.set(5, island.topY, 0);
      group.add(tower);

      const farms = new THREE.Group();
      for (let f = 0; f < 4; f++) {
        const field = new THREE.Mesh(
          new THREE.BoxGeometry(4.2, 0.2, 2.8),
          new THREE.MeshStandardMaterial({ color: f % 2 === 0 ? 0xb99845 : 0x93a850, roughness: 1 }),
        );
        field.position.set(-5 + (f % 2) * 5, island.topY + 0.15, -5 + Math.floor(f / 2) * 5);
        field.receiveShadow = true;
        farms.add(field);
      }
      group.add(farms);
    }

    if (province.hasHarbor) {
      const harbor = createHarbor(province.isMain ? 1.15 : 0.82);
      harbor.position.copy(harborPoint);
      harbor.lookAt(0, island.topY, 0);
      group.add(harbor);
    }
  } else {
    const ruin = createColumnHall(7.5, 8.5, 0);
    ruin.position.y = island.topY;
    ruin.rotation.y = angle + Math.PI / 3;
    ruin.scale.setScalar(0.7);
    group.add(ruin);
  }

  scatterTrees(group, province.controlled ? 12 : 10, province.controlled ? 14 : 9, island.topY);
  const banner = createBanner(province.color, province.controlled ? 9 : 7.5);
  banner.position.set(1, island.topY, province.controlled ? 9 : 6);
  group.add(banner);

  const labelAnchor = new THREE.Group();
  labelAnchor.position.set(0, island.topY + (province.controlled ? 16 : 10), 0);
  const label = addProvinceLabel(
    labelAnchor,
    province.controlled ? (province.isMain ? 'CAPITALE IMPÉRIALE' : 'PROVINCE CONTRÔLÉE') : 'PROVINCE RÉVÉLÉE',
    province.name,
    province.color,
  );
  label.position.y = 0;
  group.add(labelAnchor);

  const inward = new THREE.Vector3(-Math.cos(angle), 0, -Math.sin(angle));
  const route = createRoad([
    inward.clone().multiplyScalar(2).setY(island.topY + 0.3),
    inward.clone().multiplyScalar(8).setY(island.topY + 0.1),
    inward.clone().multiplyScalar(12).setY(island.topY + 0.3),
  ], 0.55, 0xd3b17a);
  group.add(route);

  const focusPoint = group.localToWorld(new THREE.Vector3(0, island.topY + 3, 0));
  focusTargets.set(province.key, focusPoint);
  if (province.isMain) focusTargets.set('main', focusPoint.clone());

  const focusMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(2.5, 2.5, 0.6, 16),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(province.color), transparent: true, opacity: 0.55 }),
  );
  focusMesh.position.set(0, island.topY + 0.3, 0);
  group.add(focusMesh);
  attachInspectable(focusMesh, {
    clan: province.controlled ? province.name : 'Territoire neutre',
    name: province.controlled ? province.title : 'Province non colonisée',
    district: province.controlled ? 'Administration provinciale' : 'Frontière à conquérir',
    status: province.controlled ? `Production ${province.resource}` : 'Exploration requise',
    hours: province.controlled
      ? `${province.hours.toFixed(1)} h · ${province.eur.toLocaleString('fr-BE')} € · ${province.resource}`
      : 'Aucune administration en place',
  }, province.key);

  return group;
}

function buildWorld(data) {
  clearWorld();
  createOcean();
  createMountainRing();

  const provinces = [];
  const mainClan = data.clansData.find((c) => c.is_main) || data.clansData[0] || { key: 'main', name: 'Imperium', color: '#8b5cf6', hours: 0, eur: 0, is_main: true };
  provinces.push({
    ...mainClan,
    key: mainClan.key || 'main',
    title: 'Cité de commandement',
    resource: 'Forum, arsenaux, acropole',
    controlled: true,
    isMain: true,
    hasHarbor: true,
  });

  const rivalClans = data.clansData.filter((c) => !c.is_main);
  const controlledCount = Math.max(1, data.empireView.state.provinces);
  const revealedCount = Math.max(controlledCount, data.empireView.state.scouted);

  for (let i = 1; i < revealedCount; i++) {
    const clan = rivalClans[(i - 1) % Math.max(1, rivalClans.length)] || {
      key: `neutral_${i}`,
      name: `Province ${i + 1}`,
      color: ['#f59e0b', '#14b8a6', '#ec4899', '#f97316'][i % 4],
      hours: 0,
      eur: 0,
    };
    provinces.push({
      ...clan,
      title: i < controlledCount ? 'Province alliée' : 'Province révélée',
      resource: i % 3 === 0 ? 'Pierre et carrières' : i % 3 === 1 ? 'Vivres et vergers' : 'Fer et arsenaux',
      controlled: i < controlledCount,
      isMain: false,
      hasHarbor: i < data.empireView.state.ports + 1,
    });
  }

  provinces.forEach((province, index) => {
    worldRoot.add(createProvinceIsland(province, index, provinces.length, data.empireView));
  });

  for (let i = 0; i < data.empireView.state.fleets; i++) {
    const ship = createShip(i % 2 === 0 ? 0x925c35 : 0x6f4a2e, 0.92 + (i % 2) * 0.08);
    const radius = 38 + ((i % 3) * 18);
    const speed = 0.12 + (i * 0.018);
    ship.position.y = -0.8;
    worldRoot.add(ship);
    dynamicActors.push({
      update(time) {
        const a = time * speed + (i * 0.9);
        ship.position.set(Math.cos(a) * radius, -0.8, Math.sin(a) * (radius * 0.78));
        ship.rotation.y = -a + Math.PI / 2;
        ship.position.y = -0.8 + Math.sin((time * 2.4) + i) * 0.12;
      },
    });
  }

  for (let i = 0; i < data.empireView.state.legions; i++) {
    const banner = createBanner(i % 2 === 0 ? '#ef4444' : '#f59e0b', 7.8);
    const angle = (i / Math.max(1, data.empireView.state.legions)) * Math.PI * 2;
    banner.position.set(Math.cos(angle) * 12, 5.2, Math.sin(angle) * 12);
    worldRoot.add(banner);
  }
}

function rebuildWorld(data) {
  if (!assetsReady || !worldRoot) {
    pendingWorldData = data;
    return;
  }
  setLoader(true, 'Assemblage des provinces, des murailles, des ports et de la flotte impériale…');
  buildWorld(data);
  setLoader(false);
}

function updateInspector(data) {
  const panel = document.getElementById('empire-inspector');
  if (!panel || !data) return;
  document.getElementById('empire-inspector-clan').textContent = data.clan || 'Province';
  document.getElementById('empire-inspector-name').textContent = data.name || 'Point stratégique';
  document.getElementById('empire-inspector-district').textContent = data.district || 'Secteur';
  document.getElementById('empire-inspector-status').textContent = data.status || 'Actif';
  document.getElementById('empire-inspector-hours').textContent = data.hours || '—';
  panel.classList.remove('hidden');
}

function onPointerMove(event) {
  if (!canvasElement || !camera || !raycaster) return;
  const rect = canvasElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(interactiveObjects, false);
  const nextHovered = hits[0]?.object || null;

  if (hoveredObject !== nextHovered) {
    setMaterialHighlight(hoveredObject, false);
    hoveredObject = nextHovered;
    setMaterialHighlight(hoveredObject, true);
  }
  canvasElement.style.cursor = hoveredObject ? 'pointer' : 'default';
}

function onPointerClick() {
  if (!camera || !raycaster) return;
  raycaster.setFromCamera(mouse, camera);
  const hit = raycaster.intersectObjects(interactiveObjects, false)[0];
  if (!hit?.object?.userData?.inspectable) return;

  setMaterialHighlight(selectedObject, false);
  selectedObject = hit.object;
  setMaterialHighlight(selectedObject, true);
  updateInspector(hit.object.userData);

  const focusKey = hit.object.userData.focusKey;
  const focus = focusTargets.get(focusKey) || hit.object.getWorldPosition(new THREE.Vector3());
  controls.target.lerp(focus, 0.9);
  camera.position.lerp(focus.clone().add(new THREE.Vector3(28, 22, 28)), 0.9);
}

function onResize() {
  if (!camera || !renderer || !containerElement) return;
  const width = containerElement.clientWidth || 800;
  const height = containerElement.clientHeight || 600;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

function animate(timeMs) {
  requestAnimationFrame(animate);
  const time = timeMs * 0.001;
  dynamicActors.forEach((actor) => actor.update(time));
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}

export function initThreeGame() {
  if (isInitialized) return;
  canvasElement = document.getElementById('three-canvas');
  if (!canvasElement) return;
  containerElement = canvasElement.parentElement;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x7f92aa);
  scene.fog = new THREE.FogExp2(0x8ea0b2, 0.0028);

  camera = new THREE.PerspectiveCamera(43, 1, 0.1, 1000);
  camera.position.set(115, 88, 118);

  renderer = new THREE.WebGLRenderer({
    canvas: canvasElement,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 42;
  controls.maxDistance = 220;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(72);
  controls.target.set(0, 8, 0);

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2(-1, -1);
  worldRoot = new THREE.Group();
  scene.add(worldRoot);

  createSkyDome();
  setupLighting();

  window.addEventListener('resize', onResize);
  canvasElement.addEventListener('mousemove', onPointerMove);
  canvasElement.addEventListener('click', onPointerClick);
  onResize();
  isInitialized = true;
  animate(0);
  ensureAssets().catch((err) => {
    console.error('[kopek] textures empire 3D indisponibles', err);
    setLoader(false);
  });
}

export function updateCity(clansData, fullAgg, empireView) {
  const data = { clansData: clansData || [], fullAgg, empireView };
  if (!isInitialized) {
    pendingWorldData = data;
    return;
  }
  if (!assetsReady) {
    pendingWorldData = data;
    setLoader(true, 'Les matières impériales se préparent…');
    return;
  }
  rebuildWorld(data);
}

export function triggerLogEffect(clientId) {
  if (!scene) return;
  const focus = focusTargets.get(clientId) || focusTargets.get('main') || new THREE.Vector3(0, 8, 0);
  controls.target.lerp(focus, 0.75);
  camera.position.lerp(focus.clone().add(new THREE.Vector3(26, 22, 26)), 0.75);

  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
  for (let i = 0; i < 22; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), material);
    p.position.set(
      (Math.random() - 0.5) * 6,
      Math.random() * 6,
      (Math.random() - 0.5) * 6,
    );
    group.add(p);
  }
  group.position.copy(focus);
  scene.add(group);

  let age = 0;
  const actor = {
    update() {
      age += 0.016;
      group.children.forEach((child, idx) => {
        child.position.y += 0.12 + (idx % 3) * 0.01;
        child.position.x += Math.sin(age * 4 + idx) * 0.012;
        child.position.z += Math.cos(age * 4 + idx) * 0.012;
        child.scale.multiplyScalar(0.985);
      });
      if (age > 1.35) {
        scene.remove(group);
        const i = dynamicActors.indexOf(actor);
        if (i !== -1) dynamicActors.splice(i, 1);
      }
    },
  };
  dynamicActors.push(actor);
}
