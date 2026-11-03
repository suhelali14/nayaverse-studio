import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedMesh,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * The hero's scene: a reel standing over its own timeline.
 *
 * It is the sample reel from the product captures, not an illustration of
 * one. The five frames were rendered by Studio's compositor; the clip
 * lengths are that cut's scene lengths; the overlay sits where the capture
 * put the B-roll; the colours are the editor's clip-kind tokens, read from
 * the stylesheet so the scene cannot drift from the app. A red playhead
 * crosses the timeline at real speed and each scene's frame comes forward
 * while it plays -- the one idea of the product, in one picture: lines on
 * a timeline become frames of a reel.
 *
 * Coordinates: x is time, y is up, z runs from the ruler (far) to the music
 * track (near), the way the timeline reads top to bottom in the editor.
 */

const SCENES = [
  { label: 'Hook', seconds: 2.9 },
  { label: 'Scene 1', seconds: 2.9 },
  { label: 'Scene 2', seconds: 3.3 },
  { label: 'Scene 3', seconds: 3.6 },
  { label: 'Call to action', seconds: 3.3 },
] as const;
const TOTAL = SCENES.reduce((t, s) => t + s.seconds, 0);
const UNIT = 0.42; // scene units per second
const WIDTH = TOTAL * UNIT;
const X0 = -WIDTH / 2;
const GAP = 0.035;
const OVERLAY = { start: 6.1, seconds: 3.0 };

const Z = { frames: -2.05, ruler: -1.3, overlay: -0.95, video: -0.42, captions: 0.08, music: 0.46 } as const;
const FRAME_H = 1.86;
const FRAME_W = (FRAME_H * 9) / 16;

/** A token from src/index.css ("R G B" channels) as a three.js colour. */
function token(name: string, fallback: string): Color {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const [r, g, b] = raw.split(/\s+/).map(Number);
  return new Color().setRGB((r ?? 0) / 255, (g ?? 0) / 255, (b ?? 0) / 255, SRGBColorSpace);
}

const FRAME_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Rounded corners from a signed distance, antialiased with fwidth, and a
// hairline edge so a dark frame still reads against a dark neighbour.
const FRAME_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform float brightness;
  uniform vec2 size;
  uniform float radius;
  varying vec2 vUv;
  float box(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  void main() {
    vec2 p = (vUv - 0.5) * size;
    float d = box(p, size * 0.5, radius);
    float aa = fwidth(d);
    float alpha = 1.0 - smoothstep(-aa, aa, d);
    vec3 col = texture2D(map, vUv).rgb * brightness;
    float edge = 1.0 - smoothstep(0.0, aa * 1.5, abs(d + aa * 1.5));
    col = mix(col, vec3(1.0), edge * 0.16);
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;

/** A soft contact shadow, drawn once. */
function shadowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.42)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.14)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new CanvasTexture(c);
}

/** A clip's name, as the editor prints it on the clip. */
function labelTexture(text: string, seconds: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d')!;
  const draw = () => {
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff';
    g.globalAlpha = 1;
    g.font = '600 60px "Archivo Variable", system-ui, sans-serif';
    g.fillText(text, 8, 66);
    g.globalAlpha = 0.72;
    g.font = '500 46px "Archivo Variable", system-ui, sans-serif';
    g.fillText(`${seconds.toFixed(1)}s`, 8, 132);
  };
  draw();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  // A canvas draws in whatever face is loaded at the time; once Archivo
  // has arrived, draw again so the label is set in the app's own type.
  void document.fonts.ready.then(() => {
    draw();
    t.needsUpdate = true;
  });
  return t;
}

export interface ReelScene {
  setPlaying(playing: boolean): void;
  setVisible(visible: boolean): void;
  /** 0 while the hero fills the screen, 1 once it has scrolled away. */
  setScroll(progress: number): void;
  dispose(): void;
}

export function createReelScene(
  host: HTMLElement,
  options: {
    frames: readonly string[];
    playing: boolean;
    /** Reduced motion: one still picture, no loop, no pointer parallax. */
    still: boolean;
    onReady: () => void;
  },
): ReelScene {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  renderer.domElement.style.display = 'block';
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(28, 1, 0.1, 60);
  const root = new Group();
  scene.add(root);

  scene.add(new HemisphereLight(0xffffff, 0xd6d6d2, 1.9));
  const sun = new DirectionalLight(0xffffff, 1.5);
  sun.position.set(3, 7, 5);
  scene.add(sun);

  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const shadow = keep(shadowTexture());
  shadow.colorSpace = SRGBColorSpace;
  const shadowMat = keep(new MeshBasicMaterial({ map: shadow, transparent: true, depthWrite: false, color: 0x000000 }));
  const flat = keep(new PlaneGeometry(1, 1));
  const addShadow = (x: number, z: number, w: number, d: number, opacity = 1) => {
    const m = new Mesh(flat, opacity === 1 ? shadowMat : keep(shadowMat.clone()));
    if (opacity !== 1) (m.material as MeshBasicMaterial).opacity = opacity;
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.001, z);
    m.scale.set(w, d, 1);
    root.add(m);
    return m;
  };

  const ink = token('--ink', '20 20 20');
  const kindPhoto = token('--kind-photo', '34 112 101');
  const kindAsset = token('--kind-asset', '98 78 160');
  const cue = token('--cue', '214 160 40');
  const accent = token('--accent', '214 39 24');
  const line = token('--line-strong', '212 212 209');

  // ── The timeline ──────────────────────────────────────────────────────
  const clip = (start: number, seconds: number, z: number, depth: number, colour: Color, height = 0.07) => {
    const w = seconds * UNIT - GAP;
    const geo = keep(new RoundedBoxGeometry(w, height, depth, 3, Math.min(0.03, depth / 4)));
    const mat = keep(new MeshStandardMaterial({ color: colour, roughness: 0.55, metalness: 0 }));
    const m = new Mesh(geo, mat);
    m.position.set(X0 + start * UNIT + GAP / 2 + w / 2, height / 2, z);
    root.add(m);
    return { mesh: m, w, top: height };
  };

  // Track beds, so empty lengths of a track still read as a track.
  const bedMat = keep(new MeshBasicMaterial({ color: line, transparent: true, opacity: 0.35 }));
  for (const [z, d] of [[Z.overlay, 0.34], [Z.video, 0.5], [Z.captions, 0.24], [Z.music, 0.34]] as const) {
    const bed = new Mesh(flat, bedMat);
    bed.rotation.x = -Math.PI / 2;
    bed.position.set(0, 0.0005, z);
    bed.scale.set(WIDTH + 0.12, d + 0.06, 1);
    root.add(bed);
  }
  addShadow(0, -0.25, WIDTH * 1.25, 2.6, 0.55);

  const loader = new TextureLoader();
  const textures: Texture[] = [];
  // Clones share the image but keep their own version, so a clone made
  // before its image arrived must be told to upload once it has.
  const clones: Texture[][] = options.frames.map(() => []);
  let pending = options.frames.length;
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  options.frames.forEach((src, i) => {
    const done = () => {
      for (const c of clones[i]!) c.needsUpdate = true;
      pending -= 1;
      if (pending === 0) {
        render();
        options.onReady();
      }
    };
    const t = loader.load(src, done, undefined, done);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = anisotropy;
    t.minFilter = LinearMipmapLinearFilter;
    textures.push(keep(t));
  });

  let at = 0;
  const frames: { mesh: Mesh; mat: ShaderMaterial; home: Vector3; lift: number; start: number; end: number }[] = [];
  SCENES.forEach((s, i) => {
    const c = clip(at, s.seconds, Z.video, 0.5, kindPhoto);
    const left = c.mesh.position.x - c.w / 2;

    // The clip's thumbnail and name, as the editor draws them.
    const texture = textures[i % textures.length]!;
    const thumbTex = keep(texture.clone());
    clones[i % textures.length]!.push(thumbTex);
    thumbTex.repeat.set(1, 9 / 16);
    thumbTex.offset.set(0, (1 - 9 / 16) / 2);
    const thumb = new Mesh(flat, keep(new MeshBasicMaterial({ map: thumbTex })));
    thumb.rotation.x = -Math.PI / 2;
    thumb.position.set(left + 0.2, c.top + 0.002, Z.video);
    thumb.scale.set(0.34, 0.42, 1);
    root.add(thumb);
    if (c.w > 0.9) {
      const label = new Mesh(flat, keep(new MeshBasicMaterial({ map: keep(labelTexture(s.label, s.seconds)), transparent: true, depthWrite: false })));
      label.rotation.x = -Math.PI / 2;
      label.position.set(left + 0.42 + 0.32, c.top + 0.003, Z.video - 0.02);
      label.scale.set(0.64, 0.2, 1);
      root.add(label);
    }

    // Two caption cues per scene, the way timed captions split a line.
    const half = s.seconds / 2;
    clip(at + 0.08, half - 0.12, Z.captions, 0.24, cue, 0.05);
    clip(at + half + 0.04, half - 0.12, Z.captions, 0.24, cue, 0.05);

    // The frame this clip becomes.
    const mat = keep(
      new ShaderMaterial({
        uniforms: {
          map: { value: texture },
          brightness: { value: 0.62 },
          size: { value: [FRAME_W, FRAME_H] },
          radius: { value: 0.07 },
        },
        vertexShader: FRAME_VERTEX,
        fragmentShader: FRAME_FRAGMENT,
        transparent: true,
      }),
    );
    const plane = new Mesh(keep(new PlaneGeometry(FRAME_W, FRAME_H)), mat);
    const home = new Vector3(c.mesh.position.x, FRAME_H / 2 + 0.1, Z.frames);
    plane.position.copy(home);
    root.add(plane);
    addShadow(home.x, Z.frames + 0.12, FRAME_W * 1.25, 0.34);
    frames.push({ mesh: plane, mat, home, lift: 0, start: at, end: at + s.seconds });
    at += s.seconds;
  });

  clip(OVERLAY.start, OVERLAY.seconds, Z.overlay, 0.34, kindAsset);
  // Music sits under everything, so it is the quietest colour on the table.
  const music = clip(0, TOTAL, Z.music, 0.34, cue.clone().lerp(ink, 0.35), 0.06);

  // A waveform printed on the music clip: a beat every half second.
  const BARS = 150;
  const bars = new InstancedMesh(keep(new BoxGeometry(1, 1, 1)), keep(new MeshBasicMaterial({ color: cue.clone().lerp(ink, 0.65) })), BARS);
  const dummy = new Object3D();
  for (let i = 0; i < BARS; i += 1) {
    const t = (i / BARS) * TOTAL;
    const beat = Math.exp(-7 * (t % 0.5)) * 0.75 + 0.25 * Math.abs(Math.sin(t * 9.1));
    dummy.position.set(X0 + t * UNIT + 0.04, music.top + 0.004, Z.music);
    dummy.scale.set(0.012, 0.004, 0.04 + beat * 0.22);
    dummy.updateMatrix();
    bars.setMatrixAt(i, dummy.matrix);
  }
  root.add(bars);

  // The ruler: a tick every second, a longer one every two.
  const tickGeo = keep(new BoxGeometry(1, 1, 1));
  const tickMat = keep(new MeshBasicMaterial({ color: ink.clone().lerp(new Color(1, 1, 1), 0.55) }));
  const ticks = new InstancedMesh(tickGeo, tickMat, Math.ceil(TOTAL) + 1);
  for (let s = 0; s <= Math.ceil(TOTAL); s += 1) {
    dummy.position.set(X0 + s * UNIT, 0.003, Z.ruler);
    dummy.scale.set(0.012, 0.004, s % 2 === 0 ? 0.16 : 0.08);
    dummy.updateMatrix();
    ticks.setMatrixAt(s, dummy.matrix);
  }
  root.add(ticks);

  // The playhead: a red bar across every track, with its head on the ruler.
  const playhead = new Group();
  const red = keep(new MeshBasicMaterial({ color: accent }));
  const bar = new Mesh(keep(new BoxGeometry(0.022, 0.012, Z.music - Z.ruler + 0.3)), red);
  bar.position.set(0, 0.11, (Z.music + Z.ruler) / 2 + 0.05);
  const head = new Mesh(keep(new RoundedBoxGeometry(0.13, 0.05, 0.13, 2, 0.02)), red);
  head.position.set(0, 0.11, Z.ruler - 0.04);
  playhead.add(bar, head);
  root.add(playhead);

  // ── Camera, fitted to the timeline's width at any aspect ─────────────
  const target = new Vector3(0, 0.84, -0.95);
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  let distance = 8;
  let scroll = 0;
  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    // Whichever is tighter: the timeline's width or the frames' height.
    const byWidth = (WIDTH * 0.58) / Math.tan(hfov / 2);
    const byHeight = 1.62 / Math.tan(vfov / 2);
    distance = Math.max(byWidth, byHeight);
    camera.updateProjectionMatrix();
    render();
  };
  const place = () => {
    const tilt = 0.3 - scroll * 0.14;
    camera.position.set(
      target.x + pointer.x * 0.5,
      target.y + Math.sin(tilt) * distance + pointer.y * 0.25,
      target.z + Math.cos(tilt) * distance,
    );
    camera.lookAt(target);
  };

  let time = options.playing ? 0 : 7.6; // a still sits mid-way through Scene 2
  let playing = options.playing;
  let visible = true;
  let last = performance.now();

  function update(dt: number) {
    if (playing) time = (time + dt) % TOTAL;
    playhead.position.x = X0 + time * UNIT;
    const k = 1 - Math.exp(-dt * 7);
    for (const f of frames) {
      const on = time >= f.start && time < f.end ? 1 : 0;
      f.lift += (on - f.lift) * (playing ? k : 1);
      f.mesh.position.set(f.home.x, f.home.y + f.lift * 0.22, f.home.z + f.lift * 0.5);
      f.mesh.rotation.x = -0.05 * (1 - f.lift);
      f.mesh.scale.setScalar(1 + f.lift * 0.07);
      (f.mat.uniforms.brightness as { value: number }).value = 0.6 + f.lift * 0.4;
    }
    pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 3);
    pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 3);
    place();
  }

  function render() {
    update(0);
    renderer.render(scene, camera);
  }

  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    renderer.render(scene, camera);
  }

  // Paused means still: no playhead, no settling, no pointer parallax.
  // The loop stops and the scene is drawn only when something asks.
  const loop = () => {
    last = performance.now();
    renderer.setAnimationLoop(visible && !document.hidden && !options.still && playing ? frame : null);
  };

  const onPointer = (e: PointerEvent) => {
    const r = host.getBoundingClientRect();
    pointer.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    pointer.ty = ((e.clientY - r.top) / r.height - 0.5) * -2;
  };
  if (!options.still) window.addEventListener('pointermove', onPointer, { passive: true });
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  document.addEventListener('visibilitychange', loop);
  resize();
  loop();

  return {
    setPlaying(p) {
      playing = p;
      loop();
      if (!p && visible) render();
    },
    setVisible(v) {
      visible = v;
      loop();
    },
    setScroll(p) {
      scroll = Math.max(0, Math.min(1, p));
      // Without a loop running, a scroll is the only reason to draw.
      if ((options.still || !playing) && visible) render();
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', loop);
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
