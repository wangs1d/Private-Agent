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

export async function exitIfDevPortInUse(port: number): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  if (await isTcpPortInUse(port)) process.exit(0);
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
