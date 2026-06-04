/** 桌宠固定灯光 — 不依赖网络 HDR，避免 Environment 加载失败导致模型“消失” */
export function OverlaySceneLights() {
  return (
    <>
      <ambientLight intensity={1.05} />
      <hemisphereLight args={["#e8eef8", "#2a3040", 0.55]} />
      <directionalLight intensity={1.15} position={[2.5, 4, 3.5]} />
      <directionalLight intensity={0.45} position={[-2, 2.5, 2]} color="#88bbff" />
      <pointLight position={[0, 2.5, 2]} intensity={0.35} color="#ffffff" />
    </>
  );
}
