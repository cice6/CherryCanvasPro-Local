const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const ACTOR_COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4"];
const numberOr = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

export const createPanoramaActor = (overrides = {}) => ({
  id: overrides.id || `actor_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
  name: overrides.name || "角色",
  x: Number.isFinite(overrides.x) ? overrides.x : 0.5,
  y: Number.isFinite(overrides.y) ? overrides.y : 0.62,
  scale: Number.isFinite(overrides.scale) ? overrides.scale : 1,
  yaw: Number.isFinite(overrides.yaw) ? overrides.yaw : 0,
  pose: overrides.pose === "sitting" ? "sitting" : "standing",
  gender: overrides.gender || "neutral",
  color: overrides.color || ACTOR_COLORS[0],
});

export const DEFAULT_PANORAMA_ACTORS = [
  createPanoramaActor({ name: "角色A", x: 0.34, y: 0.72, scale: 1.35, yaw: 0, pose: "standing", gender: "male", color: ACTOR_COLORS[0] }),
  createPanoramaActor({ name: "角色B", x: 0.68, y: 0.58, scale: 0.9, yaw: Math.PI, pose: "sitting", gender: "female", color: ACTOR_COLORS[1] }),
];

export const arrangePanoramaActors = (count = 6) => {
  const total = clamp(Math.round(Number(count) || 6), 1, 12);
  const actors = [];
  for(let i = 0; i < total; i += 1){
    const row = Math.floor(i / 3);
    const col = i % 3;
    actors.push(createPanoramaActor({
      name: `角色${i + 1}`,
      x: 0.22 + col * 0.24 + row * 0.035,
      y: 0.54 + row * 0.14,
      scale: 1.08 - row * 0.12,
      yaw: i % 2 ? Math.PI : 0,
      pose: i % 4 === 3 ? "sitting" : "standing",
      gender: i % 2 ? "female" : "male",
      color: ACTOR_COLORS[i % ACTOR_COLORS.length],
    }));
  }
  return actors;
};

export const normalizePanoramaActors = (actors) => {
  const list = Array.isArray(actors) ? actors : DEFAULT_PANORAMA_ACTORS;
  return list.map((actor, index) => createPanoramaActor({
    ...actor,
    id: actor.id || `actor_${index}`,
    name: actor.name || `角色${index + 1}`,
    x: clamp(Number(actor.x) || 0.5, 0.04, 0.96),
    y: clamp(Number(actor.y) || 0.6, 0.08, 0.96),
    scale: clamp(Number(actor.scale) || 1, 0.35, 2.6),
    yaw: Number.isFinite(Number(actor.yaw)) ? Number(actor.yaw) : 0,
    pose: actor.pose === "sitting" ? "sitting" : "standing",
    gender: actor.gender || "neutral",
    color: actor.color || ACTOR_COLORS[index % ACTOR_COLORS.length],
  }));
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("图片读取失败"));
  img.src = src;
});

const drawPanoBackground = (ctx, img, width, height, offset = 0, zoom = 1) => {
  const scale = (height / img.height) * clamp((Number(zoom) || 1) * 1.8, 1.2, 4.2);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  const y = (height - drawH) / 2;
  let x = -(((Number(offset) || 0) % 1 + 1) % 1) * drawW;
  while(x > -drawW) x -= drawW;
  for(; x < width + drawW; x += drawW){
    ctx.drawImage(img, x, y, drawW, drawH);
  }
};

const drawSceneBackground = (ctx, img, width, height, zoom = 1, offsetX = 0.5, offsetY = 0.5) => {
  const scale = (width / img.width) * clamp(Number(zoom) || 1, 0.25, 3.2);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  const x = (width - drawW) * clamp(numberOr(offsetX, 0.5), 0, 1);
  const y = (height - drawH) * clamp(numberOr(offsetY, 0.5), 0, 1);
  ctx.drawImage(img, x, y, drawW, drawH);
};

const drawStageShade = (ctx, width, height) => {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(0,0,0,0.07)");
  gradient.addColorStop(1, "rgba(0,0,0,0.16)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
};

function makeTextSprite3D(THREE, text, color = "#ffffff") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(0,0,0,0.58)";
  if(ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(28, 10, 200, 38, 10);
    ctx.fill();
  } else {
    ctx.fillRect(28, 10, 200, 38);
  }
  ctx.font = "700 24px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(String(text || "角色"), 128, 30);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.position.set(0, 1.72, 0);
  sprite.scale.set(1.15, 0.29, 1);
  sprite.renderOrder = 1000;
  return sprite;
}

function limbBetween3D(THREE, frontVector, from, to, radius, material) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const mid = start.clone().add(end).multiplyScalar(0.5);
  const direction = end.clone().sub(start);
  const geometry = new THREE.CylinderGeometry(radius, radius * 0.88, direction.length(), 14);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(mid);
  mesh.quaternion.setFromUnitVectors(frontVector, direction.normalize());
  return mesh;
}

function makeActorMesh3D(THREE, frontVector, actor) {
  const color = new THREE.Color(actor.color || "#3b82f6");
  const darker = color.clone().multiplyScalar(0.46);
  const isSitting = actor.pose === "sitting";
  const mainMat = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.05 });
  const sideMat = new THREE.MeshStandardMaterial({ color: color.clone().lerp(new THREE.Color("#ffffff"), 0.18), roughness: 0.54 });
  const backMat = new THREE.MeshStandardMaterial({ color: darker, roughness: 0.72 });
  const faceMat = new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.45 });
  const darkMat = new THREE.MeshStandardMaterial({ color: "#111827", roughness: 0.7 });
  const group = new THREE.Group();
  group.name = actor.name || "角色";

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.23, 0.55, 8, 18), mainMat);
  torso.position.set(0, isSitting ? 0.67 : 0.86, 0);
  torso.scale.set(1.02, isSitting ? 1.05 : 1.18, 0.72);
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), sideMat);
  head.position.set(0, isSitting ? 1.2 : 1.46, 0);
  group.add(head);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.16, 14), mainMat);
  neck.position.set(0, isSitting ? 1.0 : 1.24, 0);
  group.add(neck);

  if(isSitting) {
    group.add(limbBetween3D(THREE, frontVector, [-0.22, 0.9, 0], [-0.46, 0.5, 0.08], 0.065, mainMat));
    group.add(limbBetween3D(THREE, frontVector, [0.22, 0.9, 0], [0.46, 0.5, 0.08], 0.065, mainMat));
    group.add(limbBetween3D(THREE, frontVector, [-0.15, 0.36, 0.02], [-0.34, 0.26, 0.43], 0.08, mainMat));
    group.add(limbBetween3D(THREE, frontVector, [0.15, 0.36, 0.02], [0.34, 0.26, 0.43], 0.08, mainMat));
    group.add(limbBetween3D(THREE, frontVector, [-0.34, 0.26, 0.43], [-0.4, 0.02, 0.36], 0.073, mainMat));
    group.add(limbBetween3D(THREE, frontVector, [0.34, 0.26, 0.43], [0.4, 0.02, 0.36], 0.073, mainMat));
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.1, 0.44), new THREE.MeshBasicMaterial({ color: "#020617", transparent: true, opacity: 0.38, depthWrite: false }));
    seat.position.set(0, 0.23, -0.02);
    group.add(seat);
  } else {
    group.add(limbBetween3D(THREE, frontVector, [-0.22, 1.12, 0], [-0.48, 0.66, 0.08], 0.065, mainMat));
    group.add(limbBetween3D(THREE, frontVector, [0.22, 1.12, 0], [0.48, 0.66, 0.08], 0.065, mainMat));
    group.add(limbBetween3D(THREE, frontVector, [-0.12, 0.45, 0], [-0.24, 0.02, 0.05], 0.075, mainMat));
    group.add(limbBetween3D(THREE, frontVector, [0.12, 0.45, 0], [0.24, 0.02, 0.05], 0.075, mainMat));
  }

  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.32, 0.025), faceMat);
  chest.position.set(0, isSitting ? 0.73 : 0.95, 0.185);
  group.add(chest);

  const backPlate = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.34, 0.025), backMat);
  backPlate.position.set(0, isSitting ? 0.74 : 0.96, -0.185);
  group.add(backPlate);

  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), darkMat);
  eyeL.position.set(-0.064, isSitting ? 1.24 : 1.5, 0.178);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.064;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.075, 10), darkMat);
  nose.position.set(0, isSitting ? 1.195 : 1.455, 0.195);
  nose.rotation.x = Math.PI / 2;
  group.add(eyeL, eyeR, nose);

  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 32), new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.28, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, -0.01, 0);
  group.add(shadow);

  const label = makeTextSprite3D(THREE, actor.name, "#ffffff");
  label.position.y = isSitting ? 1.46 : 1.72;
  group.add(label);

  group.rotation.y = Number(actor.yaw) || 0;
  group.scale.setScalar(clamp(Number(actor.scale) || 1, 0.35, 2.6));
  return group;
}

function disposeThreeObject(object) {
  object.traverse?.((child) => {
    if(child.geometry) child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
    materials.forEach((material) => {
      if(material.map) material.map.dispose?.();
      material.dispose?.();
    });
  });
}

const renderActors3D = async (canvas, actors) => {
  const THREE = await import("three");
  const frontVector = new THREE.Vector3(0, 1, 0);
  const width = canvas.width;
  const height = canvas.height;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const aspect = width / height;
  const viewHeight = 4.4;
  const viewWidth = viewHeight * aspect;
  const camera = new THREE.OrthographicCamera(-viewWidth / 2, viewWidth / 2, viewHeight / 2, -viewHeight / 2, 0.1, 100);
  camera.position.set(0, 1.1, 7);
  camera.lookAt(0, 1.1, 0);
  camera.updateProjectionMatrix();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x111827, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(3, 4, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x7dd3fc, 0.65);
  fill.position.set(-4, 1.5, 3);
  scene.add(fill);

  const group = new THREE.Group();
  scene.add(group);
  const sorted = normalizePanoramaActors(actors).sort((a, b) => (a.y || 0) - (b.y || 0));
  sorted.forEach((actor) => {
    const mesh = makeActorMesh3D(THREE, frontVector, actor);
    const actorX = -viewWidth / 2 + clamp(Number(actor.x) || 0.5, 0, 1) * viewWidth;
    const actorY = viewHeight / 2 - clamp(Number(actor.y) || 0.6, 0, 1) * viewHeight;
    const actorZ = (clamp(Number(actor.y) || 0.6, 0, 1) - 0.5) * 0.7;
    mesh.position.set(actorX, actorY, actorZ);
    group.add(mesh);
  });

  renderer.render(scene, camera);
  disposeThreeObject(scene);
  renderer.dispose();
};

const drawActorsLayer = async (ctx, actors, width, height) => {
  try {
    const actorCanvas = document.createElement("canvas");
    actorCanvas.width = width;
    actorCanvas.height = height;
    await renderActors3D(actorCanvas, actors);
    ctx.drawImage(actorCanvas, 0, 0, width, height);
    actorCanvas.width = 1;
    actorCanvas.height = 1;
  } catch(err) {
    const sortedActors = normalizePanoramaActors(actors).sort((a, b) => a.y - b.y);
    sortedActors.forEach(actor => drawMannequin(ctx, actor, width, height));
  }
};

const drawMannequin = (ctx, actor, width, height) => {
  const x = actor.x * width;
  const y = actor.y * height;
  const s = Math.max(0.35, actor.scale || 1) * Math.min(width, height) / 420;
  const color = actor.color || "#3b82f6";
  const facingBack = Math.cos(Number(actor.yaw) || 0) < -0.2;
  const isSitting = actor.pose === "sitting";

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.fillStyle = "rgba(0,0,0,0.34)";
  ctx.beginPath();
  ctx.ellipse(0, 68, 36, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  if(isSitting){
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(-34, 24, 68, 11);

    ctx.strokeStyle = "rgba(0,0,0,0.32)";
    ctx.lineWidth = 22;
    ctx.beginPath();
    ctx.moveTo(-18, -6); ctx.lineTo(-42, 26);
    ctx.moveTo(18, -6); ctx.lineTo(42, 26);
    ctx.moveTo(-13, 31); ctx.lineTo(-44, 48); ctx.lineTo(-54, 68);
    ctx.moveTo(13, 31); ctx.lineTo(44, 48); ctx.lineTo(54, 68);
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.moveTo(-16, -8); ctx.lineTo(-40, 22);
    ctx.moveTo(16, -8); ctx.lineTo(40, 22);
    ctx.moveTo(-12, 28); ctx.lineTo(-42, 44); ctx.lineTo(-52, 64);
    ctx.moveTo(12, 28); ctx.lineTo(42, 44); ctx.lineTo(52, 64);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, -50, 19, 22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-18, -28, 36, 58);

    ctx.fillStyle = facingBack ? "rgba(0,0,0,0.28)" : "rgba(255,255,255,0.72)";
    ctx.fillRect(-11, -15, 22, 26);
    if(!facingBack){
      ctx.fillStyle = "rgba(0,0,0,0.78)";
      ctx.beginPath();
      ctx.arc(-7, -50, 2.4, 0, Math.PI * 2);
      ctx.arc(7, -50, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 2;
    ctx.strokeRect(-16, -26, 32, 52);

    ctx.font = "700 14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "white";
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.lineWidth = 4;
    ctx.strokeText(actor.name || "角色", 0, -82);
    ctx.fillText(actor.name || "角色", 0, -82);

    ctx.restore();
    return;
  }

  ctx.strokeStyle = "rgba(0,0,0,0.32)";
  ctx.lineWidth = 22;
  ctx.beginPath();
  ctx.moveTo(-18, 8); ctx.lineTo(-44, 34);
  ctx.moveTo(18, 8); ctx.lineTo(40, 36);
  ctx.moveTo(-10, 42); ctx.lineTo(-22, 68);
  ctx.moveTo(10, 42); ctx.lineTo(22, 68);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.moveTo(-16, 0); ctx.lineTo(-42, 28);
  ctx.moveTo(16, 0); ctx.lineTo(38, 30);
  ctx.moveTo(-9, 40); ctx.lineTo(-20, 66);
  ctx.moveTo(9, 40); ctx.lineTo(20, 66);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, -30, 19, 22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-18, -8, 36, 54);

  ctx.fillStyle = facingBack ? "rgba(0,0,0,0.28)" : "rgba(255,255,255,0.72)";
  ctx.fillRect(-11, 4, 22, 26);
  if(!facingBack){
    ctx.fillStyle = "rgba(0,0,0,0.78)";
    ctx.beginPath();
    ctx.arc(-7, -30, 2.4, 0, Math.PI * 2);
    ctx.arc(7, -30, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 2;
  ctx.strokeRect(-16, -6, 32, 48);

  ctx.font = "700 14px sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "white";
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.lineWidth = 4;
  ctx.strokeText(actor.name || "角色", 0, -62);
  ctx.fillText(actor.name || "角色", 0, -62);

  ctx.restore();
};

export const renderPanoramaBoardToDataUrl = async ({
  panoramaUrl,
  actors,
  width = 1280,
  height = 720,
  offset = 0,
  zoom = 1,
}) => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(320, Math.round(width));
  canvas.height = Math.max(180, Math.round(height));
  const ctx = canvas.getContext("2d");
  if(!ctx) throw new Error("当前浏览器不支持截图画布");

  ctx.fillStyle = "#080809";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if(panoramaUrl){
    const img = await loadImage(panoramaUrl);
    drawPanoBackground(ctx, img, canvas.width, canvas.height, offset, zoom);
  }

  await drawActorsLayer(ctx, actors, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
};

export const renderSceneBoardToDataUrl = async ({
  sceneUrl,
  actors,
  width = 1280,
  height = 720,
  zoom = 1,
  offsetX = 0.5,
  offsetY = 0.5,
}) => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(320, Math.round(width));
  canvas.height = Math.max(180, Math.round(height));
  const ctx = canvas.getContext("2d");
  if(!ctx) throw new Error("当前浏览器不支持截图画布");

  ctx.fillStyle = "#080809";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if(sceneUrl){
    const img = await loadImage(sceneUrl);
    drawSceneBackground(ctx, img, canvas.width, canvas.height, zoom, offsetX, offsetY);
  }
  drawStageShade(ctx, canvas.width, canvas.height);

  await drawActorsLayer(ctx, actors, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
};

export const captureVideoFrame = async (video) => {
  if(!video) throw new Error("未找到视频元素");
  if(video.readyState < 2){
    await new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error("视频读取失败")); };
      const cleanup = () => {
        video.removeEventListener("loadeddata", done);
        video.removeEventListener("error", fail);
      };
      video.addEventListener("loadeddata", done, { once: true });
      video.addEventListener("error", fail, { once: true });
    });
  }
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if(!ctx) throw new Error("当前浏览器不支持视频抽帧");
  ctx.drawImage(video, 0, 0, width, height);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width,
    height,
    time: Number(video.currentTime) || 0,
  };
};
