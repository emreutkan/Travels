import * as THREE from 'three';
import { geoEquirectangular, geoPath, geoGraticule10 } from 'd3-geo';
import { feature } from 'topojson-client';
import landTopo from './land-110m.json';

const BG = 0x050505;
const R = 1;

// ---------- rasterize land to an offscreen mask for cheap point sampling ----------
const MASK_W = 2048;
const MASK_H = 1024;
const maskCanvas = document.createElement('canvas');
maskCanvas.width = MASK_W;
maskCanvas.height = MASK_H;
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

const land = feature(landTopo, landTopo.objects.land);
const projection = geoEquirectangular().fitExtent(
  [
    [0, 0],
    [MASK_W, MASK_H],
  ],
  { type: 'Sphere' }
);
const path = geoPath(projection, maskCtx);
maskCtx.fillStyle = '#fff';
maskCtx.beginPath();
path(land);
maskCtx.fill();
const mask = maskCtx.getImageData(0, 0, MASK_W, MASK_H).data;

function isLand(lon, lat) {
  const x = Math.floor(((lon + 180) / 360) * MASK_W);
  const y = Math.floor(((90 - lat) / 180) * MASK_H);
  return mask[(y * MASK_W + x) * 4 + 3] > 100;
}

// ---------- sample a fibonacci sphere, keep points over land ----------
const SAMPLES = 90000;
const positions = [];
const golden = Math.PI * (3 - Math.sqrt(5));
for (let i = 0; i < SAMPLES; i++) {
  const y = 1 - (i / (SAMPLES - 1)) * 2;
  const rad = Math.sqrt(1 - y * y);
  const theta = golden * i;
  const x = Math.cos(theta) * rad;
  const z = Math.sin(theta) * rad;
  const lat = (Math.asin(y) * 180) / Math.PI;
  const lon = (Math.atan2(z, x) * 180) / Math.PI;
  if (isLand(lon, lat)) {
    positions.push(x * (R + 0.004), y * (R + 0.004), z * (R + 0.004));
  }
}
const dotGeo = new THREE.BufferGeometry();
dotGeo.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(positions, 3)
);
// shader-drawn round dots — no texture dependency, stays crisp at any DPR
const dotMat = new THREE.ShaderMaterial({
  uniforms: {
    uSize: { value: 0.0072 },
    uHeight: { value: 1 },
  },
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
      if (length(gl_PointCoord - 0.5) > 0.5) discard;
      gl_FragColor = vec4(1.0);
    }
  `,
});
const dots = new THREE.Points(dotGeo, dotMat);

// ---------- occluder sphere so back-side dots are hidden ----------
const occluder = new THREE.Mesh(
  new THREE.SphereGeometry(R - 0.004, 64, 64),
  new THREE.MeshBasicMaterial({ color: 0x0b0b0b })
);


// ---------- faint graticule ----------
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
    opacity: 0.055,
  })
);

// ---------- subtle fresnel rim so the sphere reads against the dark ----------
const rim = new THREE.Mesh(
  new THREE.SphereGeometry(R, 64, 64),
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
        float f = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 4.0);
        gl_FragColor = vec4(vec3(1.0), f * 0.32);
      }
    `,
  })
);

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({
  canvas: document.getElementById('scene'),
  antialias: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(BG);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
camera.position.z = 3.9;

const tilt = new THREE.Group();
tilt.rotation.z = -0.22;
const globe = new THREE.Group();
// open facing Europe / North Africa rather than open ocean
// (local lon 0 sits on +X, so world-facing +Z is local lon 90°E — offset by -90°)
globe.quaternion
  .setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(15 - 90))
  .premultiply(
    new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      THREE.MathUtils.degToRad(25)
    )
  );
globe.add(occluder, graticule, dots, rim);
tilt.add(globe);
scene.add(tilt);

// ---------- interaction: drag with inertia, idle auto-rotation ----------
const canvas = renderer.domElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const AUTO_SPEED = 0.055; // rad/s
const DRAG_K = 0.0052;
let dragging = false;
let lastX = 0;
let lastY = 0;
let lastT = 0;
let velX = 0; // angular velocity about world +Y (horizontal drags)
let velY = 0; // angular velocity about world +X (vertical drags)
let idleTime = 0;

const qTmp = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function applyWorldRotation(axis, angle) {
  qTmp.setFromAxisAngle(axis, angle);
  globe.quaternion.premultiply(qTmp);
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
  invQ.copy(globe.quaternion).invert();
  faceDir.set(0, 0, 1).applyQuaternion(invQ);
  const lat = (Math.asin(faceDir.y) * 180) / Math.PI;
  const lon = (Math.atan2(faceDir.z, faceDir.x) * 180) / Math.PI;
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  const text = `${Math.abs(lat).toFixed(2)}°${ns}  ${Math.abs(lon).toFixed(2)}°${ew}`;
  if (text !== coordText) {
    coordText = text;
    coordsEl.textContent = text;
  }
}

// ---------- resize / loop ----------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  dotMat.uniforms.uHeight.value = renderer.getDrawingBufferSize(
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
    velY *= decay;
    if (Math.abs(velX) > 1e-4) applyWorldRotation(Y_AXIS, velX * dt);
    if (Math.abs(velY) > 1e-4) applyWorldRotation(X_AXIS, velY * dt);

    // ease auto-rotation back in after the user lets go
    idleTime += dt;
    if (!reducedMotion.matches && !new URLSearchParams(location.search).has('still')) {
      const ease = Math.min(Math.max((idleTime - 0.8) / 1.6, 0), 1);
      qTmp.setFromAxisAngle(Y_AXIS, AUTO_SPEED * ease * ease * dt);
      globe.quaternion.multiply(qTmp); // local Y = tilted pole axis
    }
  }

  updateCoords();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
