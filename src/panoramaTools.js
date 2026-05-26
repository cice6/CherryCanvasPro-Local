const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const ACTOR_COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4"];

export const createPanoramaActor = (overrides = {}) => ({
  id: overrides.id || `actor_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
  name: overrides.name || "角色",
  x: Number.isFinite(overrides.x) ? overrides.x : 0.5,
  y: Number.isFinite(overrides.y) ? overrides.y : 0.62,
  scale: Number.isFinite(overrides.scale) ? overrides.scale : 1,
  yaw: Number.isFinite(overrides.yaw) ? overrides.yaw : 0,
  gender: overrides.gender || "neutral",
  color: overrides.color || ACTOR_COLORS[0],
});

export const DEFAULT_PANORAMA_ACTORS = [
  createPanoramaActor({ name: "角色A", x: 0.34, y: 0.72, scale: 1.35, yaw: 0, gender: "male", color: ACTOR_COLORS[0] }),
  createPanoramaActor({ name: "角色B", x: 0.68, y: 0.54, scale: 0.82, yaw: Math.PI, gender: "female", color: ACTOR_COLORS[1] }),
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

const drawSceneBackground = (ctx, img, width, height, zoom = 1) => {
  const scale = Math.max(width / img.width, height / img.height) * clamp(Number(zoom) || 1, 0.75, 2.4);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  const x = (width - drawW) / 2;
  const y = (height - drawH) / 2;
  ctx.drawImage(img, x, y, drawW, drawH);
};

const drawMannequin = (ctx, actor, width, height) => {
  const x = actor.x * width;
  const y = actor.y * height;
  const s = Math.max(0.35, actor.scale || 1) * Math.min(width, height) / 420;
  const color = actor.color || "#3b82f6";
  const facingBack = Math.cos(Number(actor.yaw) || 0) < -0.2;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.fillStyle = "rgba(0,0,0,0.34)";
  ctx.beginPath();
  ctx.ellipse(0, 68, 36, 10, 0, 0, Math.PI * 2);
  ctx.fill();

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

  const sortedActors = normalizePanoramaActors(actors).sort((a, b) => a.y - b.y);
  sortedActors.forEach(actor => drawMannequin(ctx, actor, canvas.width, canvas.height));
  return canvas.toDataURL("image/png");
};

export const renderSceneBoardToDataUrl = async ({
  sceneUrl,
  actors,
  width = 1280,
  height = 720,
  zoom = 1,
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
    drawSceneBackground(ctx, img, canvas.width, canvas.height, zoom);
  }

  const sortedActors = normalizePanoramaActors(actors).sort((a, b) => a.y - b.y);
  sortedActors.forEach(actor => drawMannequin(ctx, actor, canvas.width, canvas.height));
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
