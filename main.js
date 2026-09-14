import * as THREE from 'three';
import { geoEquirectangular, geoPath, geoGraticule10 } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import countriesTopo from './countries-50m.json';

const BG = 0x050505;
const R = 1;

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
for (const code of new Set(Object.values(VISITED))) {
  if (code === 'nc') continue;
  const img = new Image();
  img.src = `/flags/${code}.png`;
  img.onload = paint;
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
const renderer = new THREE.WebGLRenderer({
  canvas: document.getElementById('scene'),
  antialias: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(BG);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);

const view = new URLSearchParams(location.search);
if (view.has('still')) {
  // deterministic screenshots: skip the intro fade too
  document.getElementById('scene').style.animation = 'none';
  document
    .querySelectorAll('.hud')
    .forEach((el) => (el.style.animation = 'none'));
}
camera.position.z = parseFloat(view.get('zoom') ?? '2.05');

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
tilt.position.y = -parseFloat(view.get('yoff') ?? '0.65');
const spin = new THREE.Group();
spin.add(globe, graticule, rim);
tilt.add(spin);
scene.add(tilt);

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
// [label, lat, lon, years] — one line pulled out per year
const ENTRIES = [
  ['Türkiye, İzmir', 38.42, 27.14, ['born 2001']],
  ['Greece, Chios', 38.37, 26.06, ['2015']],
  ['KKTC', 35.2, 33.35, ['2019']],
  ['Bosnia and Herz., Sarajevo', 43.86, 18.41, ['2024']],
  ['United States, New Jersey', 40.06, -74.41, ['2024']],
  ['United States, New York City', 40.71, -74.01, ['2024']],
  ['United States, Miami', 25.76, -80.19, ['2024']],
  ['United States, California', 36.78, -119.42, ['2024']],
  ['Austria, Vienna', 48.21, 16.37, ['2025']],
  ['Czech Republic, Prague', 50.08, 14.44, ['2025']],
  ['Italy, Naples', 40.85, 14.27, ['2024', '2025']],
  ['Italy, Florence', 43.77, 11.25, ['2024', '2025']],
  ['Italy, Pisa', 43.72, 10.4, ['2025']],
  ['Italy, Siena', 43.32, 11.33, ['2025']],
  ['Italy, Rome', 41.9, 12.5, ['2024', '2025']],
  ['Italy, Venice', 45.44, 12.34, ['2024', '2025']],
  ['Italy, Verona', 45.44, 10.99, ['2024', '2025']],
  ['Italy, Lake Garda', 45.6, 10.55, ['2024', '2025']],
  ['Italy, Milan', 45.46, 9.19, ['2023', '2024', '2025']],
  ['Italy, Genova', 44.41, 8.93, ['2023']],
  ['Monaco, Monte-Carlo', 43.74, 7.42, ['2023']],
  ['Spain, Barcelona', 41.39, 2.17, ['2025']],
  ['Hungary, Budapest', 47.5, 19.04, ['2024', '2025']],
  ['Greece, Samos', 37.75, 26.9, ['2023']],
];

const labelLayer = document.createElement('div');
labelLayer.id = 'labels';
document.body.appendChild(labelLayer);

const lineVerts = [];
const anchors = []; // {dir, tip, el}
let slot = 0;
for (const [name, lat, lon, years] of ENTRIES) {
  const dir = dirFromLatLon(lat, lon);
  years.forEach((year, j) => {
    // stagger line lengths so nearby labels fan out instead of stacking
    const len = 0.1 + (slot % 6) * 0.06 + j * 0.07;
    const base = dir.clone().multiplyScalar(R + 0.005);
    const tip = dir.clone().multiplyScalar(R + 0.005 + len);
    lineVerts.push(base.x, base.y, base.z, tip.x, tip.y, tip.z);
    const el = document.createElement('div');
    el.className = 'city-label';
    el.innerHTML = `${name}<span class="cl-year">${year}</span>`;
    labelLayer.appendChild(el);
    anchors.push({ dir, tip, el, x: 0, y: 0, fade: 0 });
    slot++;
  });
}
const leaderGeo = new THREE.BufferGeometry();
leaderGeo.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(lineVerts, 3)
);
spin.add(
  new THREE.LineSegments(
    leaderGeo,
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.45,
    })
  )
);

// marker dot at each entry location — same shader trick as before
const cityGeo = new THREE.BufferGeometry();
cityGeo.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(
    ENTRIES.flatMap(([, lat, lon]) => {
      const d = dirFromLatLon(lat, lon);
      return [d.x * (R + 0.005), d.y * (R + 0.005), d.z * (R + 0.005)];
    }),
    3
  )
);
const cityMat = new THREE.ShaderMaterial({
  uniforms: { uSize: { value: 0.0105 }, uHeight: { value: 1 } },
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
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float d = length(c);
      if (d > 0.5) discard;
      gl_FragColor = vec4(1.0);
    }
  `,
});
spin.add(new THREE.Points(cityGeo, cityMat));

// open on the Mediterranean like the reference (override with ?lon=&lat=)
// (texture lon 0 sits on +X and world-facing +Z shows lon 90°W, so the
//  Y-rotation that brings lon L to the front is -90 - L)
const faceLon = parseFloat(view.get('lon') ?? '-30');
const faceLat = parseFloat(view.get('lat') ?? '8');
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
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function applyWorldRotation(axis, angle) {
  qTmp.setFromAxisAngle(axis, angle);
  spin.quaternion.premultiply(qTmp);
}

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.classList.add('dragging');
  canvas.setPointerCapture(e.pointerId);
  lastX = e.clientX;
  lastY = e.clientY;
  lastT = performance.now();
  velX = 0;
  idleTime = 0;
});

canvas.addEventListener('pointermove', (e) => {
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

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  canvas.classList.remove('dragging');
  if (e.pointerId !== undefined && canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---------- labels: project line tips to screen, de-overlap, hide when behind ----------
const tipW = new THREE.Vector3();
const dirW = new THREE.Vector3();
function updateLabels() {
  spin.updateMatrixWorld();
  const w = window.innerWidth;
  const h = window.innerHeight;
  const shown = [];
  for (const a of anchors) {
    dirW.copy(a.dir).transformDirection(spin.matrixWorld);
    if (dirW.z < 0.12) {
      a.el.style.opacity = '0';
      continue;
    }
    tipW.copy(a.tip).applyMatrix4(spin.matrixWorld).project(camera);
    a.x = ((tipW.x + 1) / 2) * w;
    a.y = ((1 - tipW.y) / 2) * h;
    a.fade = Math.min(1, (dirW.z - 0.12) * 4);
    // keep the whole label inside the viewport
    const halfW = a.el.offsetWidth / 2 + 10;
    a.x = Math.min(Math.max(a.x, halfW), w - halfW);
    a.y = Math.min(Math.max(a.y, 24), h - 12);
    shown.push(a);
  }
  // dense clusters stack deep — split each side into two lanes:
  // even labels float at their line tip, odd ones pin to the edge column
  const GAP = 15;
  for (const side of ['left', 'right']) {
    const isRight = side === 'right';
    const group = shown
      .filter((a) => (a.x < w / 2) !== isRight)
      .sort((p, q) => p.y - q.y);
    if (!group.length) continue;
    // edge column width = widest label, so the floating lane can clear it
    const maxW = Math.max(...group.map((a) => a.el.offsetWidth));
    for (const lane of [0, 1]) {
      const items = group.filter((_, i) => i % 2 === lane);
      for (let i = 0; i < items.length; i++) {
        const a = items[i];
        const halfW = a.el.offsetWidth / 2;
        if (isRight) {
          a.x =
            lane === 1 ? w - 10 - halfW : Math.min(a.x, w - 25 - maxW - halfW);
        } else {
          a.x =
            lane === 1 ? 10 + halfW : Math.max(a.x, 25 + maxW + halfW);
        }
        if (i > 0 && a.y < items[i - 1].y + GAP) {
          a.y = Math.min(items[i - 1].y + GAP, h - 12);
        }
      }
    }
  }
  for (const a of shown) {
    a.el.style.opacity = (a.fade * 0.9).toFixed(2);
    a.el.style.transform = `translate(${a.x.toFixed(1)}px, ${a.y.toFixed(
      1
    )}px) translate(-50%, -130%)`;
  }
}

// ---------- resize / loop ----------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  cityMat.uniforms.uHeight.value = renderer.getDrawingBufferSize(
    new THREE.Vector2()
  ).y;
}
window.addEventListener('resize', resize);
resize();

let prev = performance.now();
function tick(now) {
  const dt = Math.min((now - prev) / 1000, 0.05);
  prev = now;

  if (!dragging) {
    // inertia decays exponentially after release
    const decay = Math.exp(-3.2 * dt);
    velX *= decay;
    if (Math.abs(velX) > 1e-4) applyWorldRotation(Y_AXIS, velX * dt);

    // ease auto-rotation back in after the user lets go
    idleTime += dt;
    if (!reducedMotion.matches && !view.has('still')) {
      const ease = Math.min(Math.max((idleTime - 0.8) / 1.6, 0), 1);
      qTmp.setFromAxisAngle(Y_AXIS, AUTO_SPEED * ease * ease * dt);
      spin.quaternion.multiply(qTmp); // local Y = tilted pole axis
    }
  }

  renderer.render(scene, camera);
  updateLabels();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
