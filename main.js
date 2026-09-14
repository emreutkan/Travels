import * as THREE from 'three';
import { geoEquirectangular, geoPath, geoGraticule10, geoContains } from 'd3-geo';
import { feature, mesh } from 'topojson-client';

const BG = 0x050505;
const R = 1;

// ---------- real loading progress (0-55: country data, 55-95: flags, 100: first frame) ----------
const P = window.__tp;
P.target = 2;

let countriesTopo;
try {
  const resp = await fetch('/countries-50m.json');
  const total = +resp.headers.get('content-length') || 1;
  const reader = resp.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    P.target = 2 + (got / total) * 53;
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  countriesTopo = JSON.parse(new TextDecoder().decode(buf));
} catch (e) {
  // surface the failure on the loader instead of hanging at 30%
  const num = document.getElementById('loader-num');
  if (num) num.textContent = 'ERR';
  throw e;
}

// visited countries: ISO numeric id -> flag file in /public/flags
const VISITED = {
  840: 'us', // United States
  724: 'es', // Spain
  250: 'fr', // France
  756: 'ch', // Switzerland
  492: 'mc', // Monaco
  380: 'it', // Italy
  348: 'hu', // Hungary
  '040': 'at', // Austria
  203: 'cz', // Czechia
  '070': 'ba', // Bosnia and Herzegovina
  300: 'gr', // Greece
  792: 'tr', // Turkey
  196: 'nc', // Cyprus -> painted as KKTC (north of the Green Line)
};

// ---------- equirectangular texture: dark world, flags clipped to countries ----------
const TEX_W = 8192;
const TEX_H = 4096;
const texCanvas = document.createElement('canvas');
texCanvas.width = TEX_W;
texCanvas.height = TEX_H;
const texCtx = texCanvas.getContext('2d');

const projection = geoEquirectangular().fitExtent(
  [
    [0, 0],
    [TEX_W, TEX_H],
  ],
  { type: 'Sphere' }
);
const path = geoPath(projection, texCtx);
const countries = feature(countriesTopo, countriesTopo.objects.countries);
const borders = mesh(countriesTopo, countriesTopo.objects.countries);

const texture = new THREE.CanvasTexture(texCanvas);
texture.colorSpace = THREE.SRGBColorSpace;
texture.anisotropy = 8;

// currently selected country (ISO id string) — null = show everything
let selectedId = null;

// KKTC flag — not an ISO country, drawn procedurally:
// white field, two red horizontal bands, red crescent + star centred
function makeKktcFlag() {
  const c = document.createElement('canvas');
  c.width = 300;
  c.height = 200;
  const x = c.getContext('2d');
  const G = 200;
  x.fillStyle = '#fff';
  x.fillRect(0, 0, 300, 200);
  x.fillStyle = '#E30A17';
  x.fillRect(0, G * 0.05, 300, G * 0.15);
  x.fillRect(0, G * 0.8, 300, G * 0.15);
  const cx = 0.75 * G;
  const cy = 0.5 * G;
  x.beginPath();
  x.arc(cx, cy, 0.24 * G, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = '#fff';
  x.beginPath();
  x.arc(cx + 0.055 * G, cy, 0.2 * G, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = '#E30A17';
  x.beginPath();
  const sr = 0.115 * G;
  const sx0 = cx + 0.31 * G;
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? sr : sr * 0.382;
    const a = Math.PI + (Math.PI / 5) * i;
    const px = sx0 + r * Math.cos(a);
    const py = cy - r * Math.sin(a);
    if (i === 0) x.moveTo(px, py);
    else x.lineTo(px, py);
  }
  x.closePath();
  x.fill();
  return c;
}

const flagImgs = { nc: makeKktcFlag() };
const flagCodes = [...new Set(Object.values(VISITED))].filter(
  (c) => c !== 'nc'
);
let flagsDone = 0;
for (const code of flagCodes) {
  const img = new Image();
  img.src = `/flags/${code}.png`;
  const done = () => {
    flagsDone++;
    P.target = 55 + (flagsDone / flagCodes.length) * 40;
  };
  img.onload = () => {
    done();
    // repaint once when all flags are in — repainting per flag re-uploads
    // the 8K texture to the GPU every load and stutters the reveal
    if (flagsDone === flagCodes.length) paint();
  };
  img.onerror = done;
  flagImgs[code] = img;
}

function paint() {
  // ocean
  texCtx.fillStyle = '#060606';
  texCtx.fillRect(0, 0, TEX_W, TEX_H);
  // land, barely lifted from the ocean — borders carry the shape
  texCtx.fillStyle = '#0b0b0b';
  texCtx.beginPath();
  path(countries);
  texCtx.fill();
  // flags clipped to their country's shape — painted per polygon so
  // far-flung territories (e.g. French Guiana) don't stretch the flag bbox
  for (const f of countries.features) {
    const code = VISITED[f.id];
    const img = code && flagImgs[code];
    if (!img) continue;
    if (!(img instanceof HTMLCanvasElement) && !(img.complete && img.naturalWidth))
      continue;
    // KKTC only — clip Cyprus to north of the Green Line (~35.16°N)
    const greenLinePy = ((90 - 35.16) / 180) * TEX_H;
    const polys =
      f.geometry.type === 'MultiPolygon'
        ? f.geometry.coordinates
        : [f.geometry.coordinates];
    const polysWithBounds = polys.map((coords) => {
      const poly = {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: coords },
      };
      const [[x0, y0], [x1, y1]] = path.bounds(poly);
      return { poly, bounds: [x0, y0, x1, y1], area: (x1 - x0) * (y1 - y0) };
    });
    const maxArea = Math.max(...polysWithBounds.map((p) => p.area));
    for (const { poly, bounds, area } of polysWithBounds) {
      // skip far-flung specks (French Guiana et al.) — flag stays on the homeland
      if (area < maxArea * 0.2) continue;
      const [x0, y0, x1, y1] = bounds;
      texCtx.save();
      texCtx.beginPath();
      path(poly);
      texCtx.clip();
      if (f.id === '196') {
        texCtx.beginPath();
        texCtx.rect(x0, y0, x1 - x0, Math.max(0, greenLinePy - y0));
        texCtx.clip();
      }
      texCtx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
      // a selected country keeps its flag — the rest dim to the background
      if (selectedId && String(f.id) !== selectedId) {
        texCtx.fillStyle = 'rgba(0,0,0,0.62)';
        texCtx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
      texCtx.restore();
    }
  }
  // country borders over everything
  texCtx.strokeStyle = 'rgba(255,255,255,0.85)';
  texCtx.lineWidth = 2.4;
  texCtx.beginPath();
  path(borders);
  texCtx.stroke();
  texture.needsUpdate = true;
}
paint();

// ---------- scene ----------
// transparent canvas so the giant TRAVELS headline behind stays occluded
// only by the sphere itself
const renderer = new THREE.WebGLRenderer({
  canvas: document.getElementById('scene'),
  antialias: true,
  alpha: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(BG, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);

const view = new URLSearchParams(location.search);
if (view.has('still')) {
  // deterministic screenshots: skip the intro fade too
  document.getElementById('scene').style.transition = 'none';
  document
    .querySelectorAll('.bleed-title')
    .forEach((el) => {
      el.style.transition = 'none';
      el.style.opacity = '1';
    });
  document.body.classList.add('ready');
}
// viewport size — ?w=&h= overrides let screenshots emulate real devices
const viewW = () =>
  parseFloat(view.get('w')) ||
  Math.min(innerWidth, document.documentElement.clientWidth);
const viewH = () =>
  parseFloat(view.get('h')) ||
  Math.min(innerHeight, document.documentElement.clientHeight);

// portrait phones: pull back so the disc still overflows the frame width
const portrait = viewW() < viewH() && viewW() < 760;
camera.position.z = parseFloat(
  view.get('zoom') ?? (portrait ? '3.2' : '2.05')
);

const globe = new THREE.Mesh(
  new THREE.SphereGeometry(R, 128, 128),
  new THREE.MeshBasicMaterial({ map: texture })
);

// faint graticule over the ocean
const gratGeo = new THREE.BufferGeometry();
const gratVerts = [];
for (const line of geoGraticule10().coordinates) {
  for (let i = 0; i < line.length - 1; i++) {
    for (const [lon, lat] of [line[i], line[i + 1]]) {
      const phi = ((90 - lat) * Math.PI) / 180;
      const theta = ((lon + 180) * Math.PI) / 180;
      gratVerts.push(
        -(R + 0.002) * Math.sin(phi) * Math.cos(theta),
        (R + 0.002) * Math.cos(phi),
        (R + 0.002) * Math.sin(phi) * Math.sin(theta)
      );
    }
  }
}
gratGeo.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(gratVerts, 3)
);
const graticule = new THREE.LineSegments(
  gratGeo,
  new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.045,
  })
);

// subtle fresnel rim so the sphere reads against the dark
const rim = new THREE.Mesh(
  new THREE.SphereGeometry(R, 128, 128),
  new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float f = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 5.0);
        gl_FragColor = vec4(vec3(1.0), f * 0.4);
      }
    `,
  })
);

const tilt = new THREE.Group();
tilt.rotation.z = -0.07;
// drop the disc below frame centre so the bottom edge sits around the equator
tilt.position.y = -parseFloat(
  view.get('yoff') ?? (portrait ? '0.8' : '0.65')
);
const spin = new THREE.Group();
spin.add(globe, graticule, rim);
tilt.add(spin);
scene.add(tilt);

const baseTiltY = tilt.position.y;
// sink the disc further while a country is selected — its lines get headroom
const selTiltY = baseTiltY + (portrait ? 0.45 : 0.28);

// ---------- route arcs between visited cities ----------
// texture-space: direction for lat/lon on the equirect sphere
function dirFromLatLon(lat, lon) {
  const theta = ((90 - lat) * Math.PI) / 180;
  const phi = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -Math.cos(phi) * Math.sin(theta),
    Math.cos(theta),
    Math.sin(phi) * Math.sin(theta)
  );
}

// ---------- leader lines pulled out from each visited city ----------
// [label, lat, lon, years, countryId] — one line pulled out per year
const ENTRIES = [
  ['Türkiye, İzmir', 38.42, 27.14, ['born 2001'], '792'],
  ['Greece, Chios', 38.37, 26.06, ['2015'], '300'],
  ['KKTC', 35.2, 33.35, ['2019'], '196'],
  ['Bosnia and Herz., Sarajevo', 43.86, 18.41, ['2024'], '070'],
  ['United States, New Jersey', 40.06, -74.41, ['2024'], '840'],
  ['United States, New York City', 40.71, -74.01, ['2024'], '840'],
  ['United States, Miami', 25.76, -80.19, ['2024'], '840'],
  ['United States, California', 36.78, -119.42, ['2024'], '840'],
  ['Austria, Vienna', 48.21, 16.37, ['2025'], '040'],
  ['Czech Republic, Prague', 50.08, 14.44, ['2025'], '203'],
  ['Italy, Naples', 40.85, 14.27, ['2024', '2025'], '380'],
  ['Italy, Florence', 43.77, 11.25, ['2024', '2025'], '380'],
  ['Italy, Pisa', 43.72, 10.4, ['2025'], '380'],
  ['Italy, Siena', 43.32, 11.33, ['2025'], '380'],
  ['Italy, Rome', 41.9, 12.5, ['2024', '2025'], '380'],
  ['Italy, Venice', 45.44, 12.34, ['2024', '2025'], '380'],
  ['Italy, Verona', 45.44, 10.99, ['2024', '2025'], '380'],
  ['Italy, Lake Garda', 45.6, 10.55, ['2024', '2025'], '380'],
  ['Italy, Milan', 45.46, 9.19, ['2023', '2024', '2025'], '380'],
  ['Italy, Genova', 44.41, 8.93, ['2023'], '380'],
  ['Monaco, Monte-Carlo', 43.74, 7.42, ['2023'], '492'],
  ['Spain, Barcelona', 41.39, 2.17, ['2025'], '724'],
  ['Hungary, Budapest', 47.5, 19.04, ['2024', '2025'], '348'],
  ['Greece, Samos', 37.75, 26.9, ['2023'], '300'],
];

const labelLayer = document.createElement('div');
labelLayer.id = 'labels';
document.body.appendChild(labelLayer);

const anchors = []; // {dir, tip, el, cid}
const byCid = new Map(); // cid -> {lineVerts, pts}
let slot = 0;
for (const [name, lat, lon, years, cid] of ENTRIES) {
  const dir = dirFromLatLon(lat, lon);
  if (!byCid.has(cid)) byCid.set(cid, { lineVerts: [], pts: [] });
  const g = byCid.get(cid);
  g.pts.push(dir.x * (R + 0.005), dir.y * (R + 0.005), dir.z * (R + 0.005));
  years.forEach((year, j) => {
    // stagger line lengths so nearby labels fan out instead of stacking
    const len = 0.1 + (slot % 6) * 0.06 + j * 0.07;
    const base = dir.clone().multiplyScalar(R + 0.005);
    const tip = dir.clone().multiplyScalar(R + 0.005 + len);
    g.lineVerts.push(base.x, base.y, base.z, tip.x, tip.y, tip.z);
    const el = document.createElement('div');
    el.className = 'city-label';
    el.innerHTML = `${name}<span class="cl-year">${year}</span>`;
    labelLayer.appendChild(el);
    anchors.push({ dir, tip, el, cid, x: 0, y: 0, fade: 0, w: 0 });
    slot++;
  });
}

// marker: solid core + faint ring — reads as a pin over busy flags
const markerProto = new THREE.ShaderMaterial({
  uniforms: {
    uSize: { value: 0.016 },
    uHeight: { value: 1 },
    uAlpha: { value: 1 },
  },
  transparent: true,
  depthWrite: false,
  vertexShader: /* glsl */ `
    uniform float uSize;
    uniform float uHeight;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = uSize * uHeight * projectionMatrix[1][1] * 0.5 / -mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uAlpha;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float d = length(c);
      if (d > 0.5) discard;
      gl_FragColor = vec4(vec3(1.0), (d < 0.30 ? 1.0 : 0.55) * uAlpha);
    }
  `,
});

// one line/point object per country so a selection can dim the rest
const countryGroups = []; // {cid, lineMat, pointMat}
for (const [cid, g] of byCid) {
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(g.lineVerts, 3)
  );
  const lineMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.45,
  });
  const pointGeo = new THREE.BufferGeometry();
  pointGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(g.pts, 3)
  );
  const pointMat = markerProto.clone();
  spin.add(new THREE.LineSegments(lineGeo, lineMat));
  spin.add(new THREE.Points(pointGeo, pointMat));
  countryGroups.push({ cid, lineMat, pointMat });
}

// open on the Mediterranean like the reference (override with ?lon=&lat=)
// (texture lon 0 sits on +X and world-facing +Z shows lon 90°W, so the
//  Y-rotation that brings lon L to the front is -90 - L)
const faceLon = parseFloat(view.get('lon') ?? (portrait ? '14' : '-30'));
const faceLat = parseFloat(view.get('lat') ?? (portrait ? '14' : '8'));
spin.quaternion
  .setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    THREE.MathUtils.degToRad(-90 - faceLon)
  )
  .premultiply(
    new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      THREE.MathUtils.degToRad(faceLat)
    )
  );

// ---------- interaction: drag with inertia, idle auto-rotation ----------
const canvas = renderer.domElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const AUTO_SPEED = 0.055; // rad/s
const DRAG_K = 0.0052;
let dragging = false;
let lastX = 0;
let lastY = 0;
let lastT = 0;
let velX = 0;
let idleTime = 0;

const qTmp = new THREE.Quaternion();
const qTmp2 = new THREE.Quaternion();
const selQuat = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function applyWorldRotation(axis, angle) {
  qTmp.setFromAxisAngle(axis, angle);
  spin.quaternion.premultiply(qTmp);
}

// pick which visited country is under a client point (null = none)
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pickCountry(clientX, clientY) {
  // camera isn't in the scene graph — its matrixWorld only refreshes on render,
  // so a pick before/without a render casts from inside the sphere and misses
  camera.updateMatrixWorld();
  scene.updateMatrixWorld(true);
  ndc.set((clientX / viewW()) * 2 - 1, -((clientY / viewH()) * 2 - 1));
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(globe, false)[0];
  if (!hit) return null;
  const v = globe.worldToLocal(hit.point.clone()).normalize();
  const lat = 90 - (Math.acos(Math.min(1, Math.max(-1, v.y))) * 180) / Math.PI;
  let lon = (Math.atan2(v.z, -v.x) * 180) / Math.PI - 180;
  if (lon < -180) lon += 360;
  for (const f of countries.features) {
    if (VISITED[f.id] && geoContains(f, [lon, lat])) return String(f.id);
  }
  return null;
}

function applySelection() {
  for (const g of countryGroups) {
    const dim = selectedId && g.cid !== selectedId;
    g.lineMat.opacity = dim ? 0.05 : 0.45;
    g.pointMat.uniforms.uAlpha.value = dim ? 0.15 : 1;
  }
  paint(); // re-render the texture with unselected flags dimmed
  if (selectedId) {
    // aim a yaw at the selected country's city cluster so it ends up on top.
    // yaw-only (about the pole axis) — the no-vertical-flip rule still holds
    const d = new THREE.Vector3();
    for (const e of ENTRIES) if (e[4] === selectedId) d.add(dirFromLatLon(e[1], e[2]));
    d.normalize().applyQuaternion(spin.quaternion); // country dir, tilt space
    qTmp2.copy(tilt.quaternion).invert();
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(qTmp2); // camera dir, tilt space
    const delta = Math.atan2(facing.x, facing.z) - Math.atan2(d.x, d.z);
    selQuat.setFromAxisAngle(Y_AXIS, delta).multiply(spin.quaternion);
  }
  idleTime = 0; // auto-rotation eases back in smoothly on deselect
}

const clampZ = (z) => Math.min(Math.max(z, 1.55), 7);

const pointers = new Map(); // active pointerId -> [x, y]
let pinched = false;
let lastPinchD = 0;
let downX = 0;
let downY = 0;

canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  dragging = true;
  canvas.classList.add('dragging');
  canvas.setPointerCapture(e.pointerId);
  downX = lastX = e.clientX;
  downY = lastY = e.clientY;
  lastT = performance.now();
  velX = 0;
  idleTime = 0;
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) {
    // hover: afford a pointer cursor over clickable (painted) countries
    const now = performance.now();
    if (now - (pickT || 0) > 90) {
      pickT = now;
      canvas.style.cursor = pickCountry(e.clientX, e.clientY)
        ? 'pointer'
        : 'grab';
    }
    return;
  }
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  // two fingers down = pinch zoom, not rotation
  if (pointers.size === 2) {
    pinched = true;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (lastPinchD) camera.position.z = clampZ((camera.position.z * lastPinchD) / d);
    lastPinchD = d;
    return;
  }
  if (!dragging) return;
  const now = performance.now();
  const dt = Math.max(now - lastT, 1) / 1000;
  const dx = e.clientX - lastX;
  applyWorldRotation(Y_AXIS, dx * DRAG_K);
  velX = (dx * DRAG_K) / dt;
  lastX = e.clientX;
  lastY = e.clientY;
  lastT = now;
});

let pickT = 0;

function endDrag(e) {
  const wasPinched = pinched;
  pointers.delete(e.pointerId);
  lastPinchD = 0;
  if (!pointers.size) pinched = false;
  // a tap that didn't drag or pinch toggles the country under it
  if (
    e.type === 'pointerup' &&
    !wasPinched &&
    Math.hypot(e.clientX - downX, e.clientY - downY) < 6
  ) {
    const id = pickCountry(e.clientX, e.clientY);
    selectedId = id === selectedId ? null : id;
    applySelection();
  }
  if (!dragging) return;
  dragging = false;
  canvas.classList.remove('dragging');
  if (e.pointerId !== undefined && canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// wheel zoom (desktop counterpart of pinch)
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camera.position.z = clampZ(camera.position.z * (1 + e.deltaY * 0.0012));
  },
  { passive: false }
);

// ---------- labels: project line tips to screen, de-overlap, hide when behind ----------
const tipW = new THREE.Vector3();
const dirW = new THREE.Vector3();
function updateLabels() {
  spin.updateMatrixWorld();
  const w = viewW();
  const h = viewH();
  const shown = [];
  for (const a of anchors) {
    // a selected country keeps only its own labels
    if (selectedId && a.cid !== selectedId) {
      a.el.style.opacity = '0';
      continue;
    }
    dirW.copy(a.dir).transformDirection(spin.matrixWorld);
    if (dirW.z < 0.12) {
      a.el.style.opacity = '0';
      continue;
    }
    tipW.copy(a.tip).applyMatrix4(spin.matrixWorld).project(camera);
    a.x = ((tipW.x + 1) / 2) * w;
    a.y = ((1 - tipW.y) / 2) * h;
    a.fade = Math.min(1, (dirW.z - 0.12) * 4);
    if (!a.w) a.w = a.el.offsetWidth; // cache — offsetWidth forces layout every read
    // keep the whole label inside the viewport
    const halfW = a.w / 2 + 10;
    a.x = Math.min(Math.max(a.x, halfW), w - halfW);
    a.y = Math.min(Math.max(a.y, 24), h - 12);
    shown.push(a);
  }
  // dense clusters stack deep — split each side into two lanes:
  // even labels float at their line tip, odd ones pin to the edge column
  const GAP = w < 560 ? 11 : 15;
  for (const side of ['left', 'right']) {
    const isRight = side === 'right';
    const group = shown
      .filter((a) => (a.x < w / 2) !== isRight)
      .sort((p, q) => p.y - q.y);
    if (!group.length) continue;
    // narrow screens can't fit two columns — everything pins to the edge;
    // a selected country instead floats every label at its own line tip
    const singleLane = w < 560;
    const maxW = Math.max(...group.map((a) => a.w));
    const lanes = selectedId ? [0] : singleLane ? [1] : [0, 1];
    for (const lane of lanes) {
      const items =
        singleLane || selectedId ? group : group.filter((_, i) => i % 2 === lane);
      for (let i = 0; i < items.length; i++) {
        const a = items[i];
        const halfW = a.w / 2;
        if (isRight) {
          a.x =
            lane === 1
              ? w - 10 - halfW
              : selectedId
                ? a.x
                : Math.min(a.x, w - 25 - maxW - halfW);
        } else {
          a.x =
            lane === 1
              ? 10 + halfW
              : selectedId
                ? a.x
                : Math.max(a.x, 25 + maxW + halfW);
        }
        if (i > 0 && a.y < items[i - 1].y + GAP) {
          a.y = Math.min(items[i - 1].y + GAP, h - 12);
        }
      }
    }
  }
  for (const a of shown) {
    const op = (a.fade * 0.9).toFixed(2);
    const tx = `translate(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px) translate(-50%, -130%)`;
    // only touch the DOM when something actually changed
    if (op !== a.op) a.el.style.opacity = op;
    if (tx !== a.tx) a.el.style.transform = tx;
    a.op = op;
    a.tx = tx;
  }
}

// ---------- resize / loop ----------
function resize() {
  const w = viewW();
  const h = viewH();
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const dbh = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  for (const g of countryGroups) g.pointMat.uniforms.uHeight.value = dbh;
  for (const a of anchors) a.w = 0; // re-measure label widths on next frame
}
window.addEventListener('resize', resize);
resize();

// debug: ?sel=ID selects a country directly (bypasses the click raycast)
if (view.has('sel')) {
  selectedId = view.get('sel');
  applySelection();
  // snap to the aimed pose — screenshots don't wait for the slerp
  spin.quaternion.copy(selQuat);
  tilt.position.y = selTiltY;
}
// debug: ?pick=x,y synthesizes a click at those client coords
if (view.has('pick')) {
  const [px, py] = view.get('pick').split(',').map(Number);
  selectedId = pickCountry(px, py);
  applySelection();
  if (view.has('pickdebug')) {
    ndc.set((px / viewW()) * 2 - 1, -((py / viewH()) * 2 - 1));
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(globe, false)[0];
    let dbg = `pick ${px},${py} -> id=${selectedId}`;
    if (hit) {
      const v = globe.worldToLocal(hit.point.clone()).normalize();
      const lat = 90 - (Math.acos(Math.min(1, Math.max(-1, v.y))) * 180) / Math.PI;
      let lon = (Math.atan2(v.z, -v.x) * 180) / Math.PI - 180;
      if (lon < -180) lon += 360;
      dbg += ` lat=${lat.toFixed(1)} lon=${lon.toFixed(1)}`;
    } else dbg += ' nohit';
    const div = document.createElement('div');
    div.style.cssText =
      'position:fixed;top:8px;left:8px;color:#0f0;font:14px monospace;z-index:99;background:#000';
    div.textContent = dbg;
    document.body.appendChild(div);
  }
}

let prev = performance.now();
let firstFrame = false;
function tick(now) {
  const dt = Math.min((now - prev) / 1000, 0.05);
  prev = now;

  if (!dragging) {
    // inertia decays exponentially after release
    const decay = Math.exp(-3.2 * dt);
    velX *= decay;
    if (!selectedId && Math.abs(velX) > 1e-4)
      applyWorldRotation(Y_AXIS, velX * dt);

    idleTime += dt;
    if (selectedId) {
      // hold the selected country on top — no auto-rotation while selected
      spin.quaternion.slerp(selQuat, 1 - Math.exp(-3.5 * dt));
    } else if (!reducedMotion.matches && !view.has('still')) {
      // ease auto-rotation back in after the user lets go
      const ease = Math.min(Math.max((idleTime - 0.8) / 1.6, 0), 1);
      qTmp.setFromAxisAngle(Y_AXIS, AUTO_SPEED * ease * ease * dt);
      spin.quaternion.multiply(qTmp); // local Y = tilted pole axis
    }
  }

  // sink the disc while a country is selected so its lines fan up top
  const tiltTarget = selectedId ? selTiltY : baseTiltY;
  tilt.position.y +=
    (tiltTarget - tilt.position.y) * (1 - Math.exp(-3.5 * dt));

  renderer.render(scene, camera);
  updateLabels();
  if (!firstFrame) {
    firstFrame = true;
    P.target = 100; // loader finishes counting, curtain reveals
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
