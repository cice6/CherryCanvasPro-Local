import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const numberOr = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};
const FRONT_VECTOR = new THREE.Vector3(0, 1, 0);

function makeTextSprite(text, color = "#ffffff") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(0,0,0,0.58)";
  ctx.roundRect?.(28, 10, 200, 38, 10);
  if(ctx.roundRect) ctx.fill();
  else ctx.fillRect(28, 10, 200, 38);
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

function limbBetween(from, to, radius, material) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const mid = start.clone().add(end).multiplyScalar(0.5);
  const direction = end.clone().sub(start);
  const geometry = new THREE.CylinderGeometry(radius, radius * 0.88, direction.length(), 14);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(mid);
  mesh.quaternion.setFromUnitVectors(FRONT_VECTOR, direction.normalize());
  return mesh;
}

function markActorObject(object, actorId) {
  object.userData.actorId = actorId;
  object.traverse?.((child) => {
    child.userData.actorId = actorId;
  });
  return object;
}

function makeActorMesh(actor, selected) {
  const color = new THREE.Color(actor.color || "#3b82f6");
  const darker = color.clone().multiplyScalar(0.46);
  const isSitting = actor.pose === "sitting";
  const mainMat = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.05 });
  const sideMat = new THREE.MeshStandardMaterial({ color: color.clone().lerp(new THREE.Color("#ffffff"), 0.18), roughness: 0.54 });
  const backMat = new THREE.MeshStandardMaterial({ color: darker, roughness: 0.72 });
  const faceMat = new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.45 });
  const darkMat = new THREE.MeshStandardMaterial({ color: "#111827", roughness: 0.7 });
  const selectedMat = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.16, depthWrite: false });
  const group = new THREE.Group();
  group.name = actor.name || "角色";
  group.userData.actorId = actor.id;

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
    group.add(limbBetween([-0.22, 0.9, 0], [-0.46, 0.5, 0.08], 0.065, mainMat));
    group.add(limbBetween([0.22, 0.9, 0], [0.46, 0.5, 0.08], 0.065, mainMat));
    group.add(limbBetween([-0.15, 0.36, 0.02], [-0.34, 0.26, 0.43], 0.08, mainMat));
    group.add(limbBetween([0.15, 0.36, 0.02], [0.34, 0.26, 0.43], 0.08, mainMat));
    group.add(limbBetween([-0.34, 0.26, 0.43], [-0.4, 0.02, 0.36], 0.073, mainMat));
    group.add(limbBetween([0.34, 0.26, 0.43], [0.4, 0.02, 0.36], 0.073, mainMat));
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.1, 0.44), new THREE.MeshBasicMaterial({ color: "#020617", transparent: true, opacity: 0.38, depthWrite: false }));
    seat.position.set(0, 0.23, -0.02);
    group.add(seat);
  } else {
    group.add(limbBetween([-0.22, 1.12, 0], [-0.48, 0.66, 0.08], 0.065, mainMat));
    group.add(limbBetween([0.22, 1.12, 0], [0.48, 0.66, 0.08], 0.065, mainMat));
    group.add(limbBetween([-0.12, 0.45, 0], [-0.24, 0.02, 0.05], 0.075, mainMat));
    group.add(limbBetween([0.12, 0.45, 0], [0.24, 0.02, 0.05], 0.075, mainMat));
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

  const label = makeTextSprite(actor.name, "#ffffff");
  label.position.y = isSitting ? 1.46 : 1.72;
  group.add(label);

  if(selected) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.014, 10, 64), selectedMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0.015, 0);
    group.add(ring);
  }

  group.rotation.y = Number(actor.yaw) || 0;
  group.scale.setScalar(clamp(Number(actor.scale) || 1, 0.35, 2.6));
  markActorObject(group, actor.id);
  return group;
}

function disposeObject(object) {
  object.traverse((child) => {
    if(child.geometry) child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
    materials.forEach((material) => {
      if(material.map) material.map.dispose();
      material.dispose?.();
    });
  });
}

export default function Panorama3DStage({
  mode = "panorama",
  nodeId,
  actors,
  selectedActorId,
  imageUrl,
  panoramaOffset = 0,
  panoramaZoom = 1,
  sceneOffsetX = 0.5,
  sceneOffsetY = 0.5,
  stageAspectRatio,
  accent = "#22d3ee",
  theme,
  onActorsChange,
  onSelectActor,
  onOffsetChange,
  onSceneViewChange,
}) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const threeRef = useRef(null);
  const dragRef = useRef(null);
  const actorsRef = useRef(actors);
  const viewRef = useRef({ panoramaOffset, panoramaZoom });
  const sceneImageSizeRef = useRef(null);
  actorsRef.current = actors;
  viewRef.current = { panoramaOffset, panoramaZoom, sceneOffsetX, sceneOffsetY };

  const renderScene = useCallback(() => {
    const state = threeRef.current;
    if(!state) return;
    state.renderer.render(state.scene, state.camera);
  }, []);

  const resize = useCallback(() => {
    const host = hostRef.current;
    const state = threeRef.current;
    if(!host || !state) return;
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    state.renderer.setSize(width, height, false);
    const aspect = width / height;
    const viewHeight = 4.4;
    const viewWidth = viewHeight * aspect;
    state.camera.left = -viewWidth / 2;
    state.camera.right = viewWidth / 2;
    state.camera.top = viewHeight / 2;
    state.camera.bottom = -viewHeight / 2;
    state.camera.updateProjectionMatrix();
    state.viewWidth = viewWidth;
    state.viewHeight = viewHeight;
    renderScene();
  }, [renderScene]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if(!canvas) return undefined;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-3, 3, 2.2, -2.2, 0.1, 100);
    camera.position.set(0, 1.1, 7);
    camera.lookAt(0, 1.1, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x111827, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(3, 4, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x7dd3fc, 0.65);
    fill.position.set(-4, 1.5, 3);
    scene.add(fill);
    const actorGroup = new THREE.Group();
    scene.add(actorGroup);
    threeRef.current = { renderer, scene, camera, actorGroup, raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(), viewWidth: 6, viewHeight: 4.4 };
    resize();
    return () => {
      disposeObject(actorGroup);
      renderer.dispose();
      threeRef.current = null;
    };
  }, [resize]);

  useEffect(() => {
    if(mode !== "scene" || !imageUrl) {
      sceneImageSizeRef.current = null;
      return undefined;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if(cancelled) return;
      sceneImageSizeRef.current = {
        width: img.naturalWidth || img.width || 1,
        height: img.naturalHeight || img.height || 1,
      };
    };
    img.onerror = () => {
      if(!cancelled) sceneImageSizeRef.current = null;
    };
    img.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [imageUrl, mode]);

  useEffect(() => {
    const host = hostRef.current;
    if(!host) return undefined;
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, [resize]);

  useEffect(() => {
    const state = threeRef.current;
    if(!state) return;
    disposeObject(state.actorGroup);
    state.actorGroup.clear();
    const sorted = [...(actors || [])].sort((a, b) => (a.y || 0) - (b.y || 0));
    sorted.forEach((actor) => {
      const mesh = makeActorMesh(actor, actor.id === selectedActorId);
      const x = -state.viewWidth / 2 + clamp(Number(actor.x) || 0.5, 0, 1) * state.viewWidth;
      const y = state.viewHeight / 2 - clamp(Number(actor.y) || 0.6, 0, 1) * state.viewHeight;
      const z = (clamp(Number(actor.y) || 0.6, 0, 1) - 0.5) * 0.7;
      mesh.position.set(x, y, z);
      state.actorGroup.add(mesh);
    });
    renderScene();
  }, [actors, selectedActorId, renderScene]);

  const pickActor = useCallback((event) => {
    const state = threeRef.current;
    const canvas = canvasRef.current;
    if(!state || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    state.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    state.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.pointer, state.camera);
    const hits = state.raycaster.intersectObjects(state.actorGroup.children, true);
    const hit = hits.find(item => item.object?.userData?.actorId);
    return hit?.object?.userData?.actorId || null;
  }, []);

  const emitActorMove = useCallback((actorId, event) => {
    const host = hostRef.current;
    if(!host) return;
    const rect = host.getBoundingClientRect();
    const nextX = clamp((event.clientX - rect.left) / rect.width, 0.04, 0.96);
    const nextY = clamp((event.clientY - rect.top) / rect.height, 0.08, 0.96);
    const next = actorsRef.current.map(actor => actor.id === actorId ? { ...actor, x: nextX, y: nextY } : actor);
    onActorsChange?.(next);
  }, [onActorsChange]);

  const handlePointerDown = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    const actorId = pickActor(event);
    if(actorId) {
      onSelectActor?.(actorId);
      dragRef.current = { type: "actor", actorId, pointerId: event.pointerId };
      emitActorMove(actorId, event);
    } else {
      onSelectActor?.("");
      const rect = hostRef.current?.getBoundingClientRect();
      if(mode === "panorama") {
        dragRef.current = {
          type: "view",
          pointerId: event.pointerId,
          startX: event.clientX,
          width: rect?.width || 1,
          startOffset: Number(viewRef.current.panoramaOffset) || 0,
        };
      } else if(onSceneViewChange) {
        const imageSize = sceneImageSizeRef.current;
        const width = rect?.width || 1;
        const height = rect?.height || 1;
        const zoom = clamp(Number(viewRef.current.panoramaZoom) || 1, 0.25, 3.2);
        const drawW = width * zoom;
        const drawH = imageSize?.width ? drawW * (imageSize.height / imageSize.width) : height * zoom;
        dragRef.current = {
          type: "scene-view",
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          width,
          height,
          drawW,
          drawH,
          startOffsetX: clamp(numberOr(viewRef.current.sceneOffsetX, 0.5), 0, 1),
          startOffsetY: clamp(numberOr(viewRef.current.sceneOffsetY, 0.5), 0, 1),
        };
      } else {
        dragRef.current = null;
        return;
      }
    }
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch {}
  }, [emitActorMove, mode, onSceneViewChange, onSelectActor, pickActor]);

  const handlePointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if(!drag) return;
    event.preventDefault();
    event.stopPropagation();
    if(drag.type === "actor") {
      emitActorMove(drag.actorId, event);
      return;
    }
    if(drag.type === "scene-view" && onSceneViewChange) {
      const rangeX = (drag.width || 1) - (drag.drawW || drag.width || 1);
      const rangeY = (drag.height || 1) - (drag.drawH || drag.height || 1);
      const nextX = Math.abs(rangeX) < 1
        ? drag.startOffsetX
        : clamp((rangeX * drag.startOffsetX + event.clientX - drag.startX) / rangeX, 0, 1);
      const nextY = Math.abs(rangeY) < 1
        ? drag.startOffsetY
        : clamp((rangeY * drag.startOffsetY + event.clientY - drag.startY) / rangeY, 0, 1);
      onSceneViewChange?.({ x: nextX, y: nextY });
      return;
    }
    if(drag.type !== "view" || !onOffsetChange) return;
    const delta = (event.clientX - drag.startX) / Math.max(160, drag.width || 1);
    const nextOffset = ((drag.startOffset - delta) % 1 + 1) % 1;
    onOffsetChange?.(nextOffset);
  }, [emitActorMove, onOffsetChange, onSceneViewChange]);

  const handlePointerUp = useCallback((event) => {
    if(!dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
  }, []);

  const bgWidth = Math.round(320 * clamp(Number(panoramaZoom) || 1, 0.75, 1.8));
  const bgOffset = ((Number(panoramaOffset) || 0) % 1 + 1) % 1;
  const isPanorama = mode === "panorama";
  const fixedAspectRatio = !isPanorama && Number(stageAspectRatio) > 0 ? Number(stageAspectRatio) : 0;
  const isDraggingView = dragRef.current?.type === "view" || dragRef.current?.type === "scene-view";
  const sceneBgWidth = Math.round(100 * clamp(Number(panoramaZoom) || 1, 0.25, 3.2));
  const sceneBgX = clamp(numberOr(sceneOffsetX, 0.5), 0, 1) * 100;
  const sceneBgY = clamp(numberOr(sceneOffsetY, 0.5), 0, 1) * 100;

  return (
    <div
      ref={hostRef}
      data-interactive="1"
      data-pano-stage={nodeId}
      style={{
        flex: fixedAspectRatio ? "0 0 auto" : 1,
        width: "100%",
        aspectRatio: fixedAspectRatio ? String(fixedAspectRatio) : undefined,
        minHeight: 230,
        borderRadius: 12,
        border: `1px solid ${theme?.border || "rgba(255,255,255,0.10)"}`,
        background: imageUrl
          ? `linear-gradient(rgba(0,0,0,0.07), rgba(0,0,0,0.16)), url(${imageUrl})`
          : `linear-gradient(135deg, ${accent}24, rgba(0,0,0,0.36))`,
        backgroundSize: imageUrl ? (isPanorama ? `cover, ${bgWidth}% auto` : `cover, ${sceneBgWidth}% auto`) : "cover",
        backgroundPosition: imageUrl ? (isPanorama ? `center, ${(bgOffset * 100).toFixed(2)}% center` : `center, ${sceneBgX.toFixed(2)}% ${sceneBgY.toFixed(2)}%`) : "center",
        backgroundRepeat: imageUrl ? (isPanorama ? "no-repeat, repeat-x" : "no-repeat, no-repeat") : "no-repeat",
        overflow: "hidden",
        position: "relative",
        cursor: isDraggingView ? "grabbing" : (isPanorama || imageUrl ? "grab" : "default"),
        touchAction: "none",
        userSelect: "none",
      }}
    >
      {!imageUrl && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", color: theme?.textMuted || "rgba(255,255,255,0.58)", padding: 20, pointerEvents: "none" }}>
          <div>
            <div style={{ fontSize: 12, color: theme?.text || "white", fontWeight: 700 }}>{isPanorama ? "上传 2:1 全景图，或把素材图连到这里" : "上传普通场景图，或把素材图连到这里"}</div>
            <div style={{ marginTop: 4, fontSize: 10, color: theme?.textDim || "rgba(255,255,255,0.38)" }}>{isPanorama ? "拖动空白区域转 360 视角，点小人后可缩放/旋转/删除" : "普通场景图不转视角，点小人后可缩放/旋转/删除"}</div>
          </div>
        </div>
      )}
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", cursor: dragRef.current ? "grabbing" : (isPanorama || imageUrl ? "grab" : "default") }}
      />
      <div style={{ position: "absolute", left: 10, bottom: 10, display: "flex", gap: 6, pointerEvents: "none" }}>
        <span style={{ padding: "4px 7px", borderRadius: 6, background: "rgba(0,0,0,0.5)", color: "white", fontSize: 10 }}>{isPanorama ? "360 预演" : "场景预演"}</span>
        <span style={{ padding: "4px 7px", borderRadius: 6, background: "rgba(0,0,0,0.5)", color: "white", fontSize: 10 }}>{actors?.length || 0} 角色</span>
      </div>
    </div>
  );
}
