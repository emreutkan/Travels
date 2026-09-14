import * as THREE from 'three';
import { geoEquirectangular, geoPath, geoGraticule10 } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import countriesTopo from './countries-110m.json';

const BG = 0x050505;
const R = 1;

// visited countries: ISO numeric id -> flag file in /public/flags
const VISITED = {
  840: 'us', // United States
  724: 'es', // Spain
  250: 'fr', // France
  380: 'it', // Italy
  348: 'hu', // Hungary
  '040': 'at', // Austria
  203: 'cz', // Czechia
  '070': 'ba', // Bosnia and Herzegovina
  300: 'gr', // Greece
  792: 'tr', // Turkey
  196: 'cy', // Cyprus
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

const flagImgs = {};
for (const code of new Set(Object.values(VISITED))) {
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
    if (!img || !img.complete || !img.naturalWidth) continue;
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
camera.position.z = parseFloat(view.get('zoom') ?? '3.3');

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
const spin = new THREE.Group();
spin.add(globe, graticule, rim);
tilt.add(spin);
scene.add(tilt);

// open on the Mediterranean like the reference (override with ?lon=&lat=)
// (texture lon 0 sits on +X and world-facing +Z shows lon 90°W, so the
//  Y-rotation that brings lon L to the front is -90 - L)
const faceLon = parseFloat(view.get('lon') ?? '-22');
const faceLat = parseFloat(view.get('lat') ?? '36');
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
let velY = 0;
let idleTime = 0;

const qTmp = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);
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
  velX = velY = 0;
  idleTime = 0;
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const now = performance.now();
  const dt = Math.max(now - lastT, 1) / 1000;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  applyWorldRotation(Y_AXIS, dx * DRAG_K);
  applyWorldRotation(X_AXIS, dy * DRAG_K);
  velX = (dx * DRAG_K) / dt;
  velY = (dy * DRAG_K) / dt;
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

// ---------- coordinates readout: lat/lon of the point facing the camera ----------
const coordsEl = document.getElementById('coords');
const invQ = new THREE.Quaternion();
const faceDir = new THREE.Vector3();
let coordText = '';
function updateCoords() {
  invQ.copy(spin.quaternion).invert();
  faceDir.set(0, 0, 1).applyQuaternion(invQ);
  const lat = (Math.asin(faceDir.y) * 180) / Math.PI;
  let lon = (Math.atan2(faceDir.z, -faceDir.x) * 180) / Math.PI - 180;
  if (lon < -180) lon += 360;
  const text = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}<br>${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
  if (text !== coordText) {
    coordText = text;
    coordsEl.innerHTML = text;
  }
}

// ---------- resize / loop ----------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
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
    velY *= decay;
    if (Math.abs(velX) > 1e-4) applyWorldRotation(Y_AXIS, velX * dt);
    if (Math.abs(velY) > 1e-4) applyWorldRotation(X_AXIS, velY * dt);

    // ease auto-rotation back in after the user lets go
    idleTime += dt;
    if (!reducedMotion.matches && !view.has('still')) {
      const ease = Math.min(Math.max((idleTime - 0.8) / 1.6, 0), 1);
      qTmp.setFromAxisAngle(Y_AXIS, AUTO_SPEED * ease * ease * dt);
      spin.quaternion.multiply(qTmp); // local Y = tilted pole axis
    }
  }

  updateCoords();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
