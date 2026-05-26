import net from "node:net";

export function isTcpPortInUse(port: number, host = "0.0.0.0"): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE");
    });
    probe.once("listening", () => {
      probe.close(() => resolve(false));
    });
    probe.listen({ port, host, exclusive: true });
  });
}

export function isDevListenConflict(err: unknown): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

/** 开发态：端口已被占用则安静退出，避免 node --watch 刷 EADDRINUSE */
export async function exitIfDevPortInUse(port: number): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  if (await isTcpPortInUse(port)) process.exit(0);
}
