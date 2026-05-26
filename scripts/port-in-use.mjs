/** @typedef {import('node:net').AddressInfo} AddressInfo */
import net from "node:net";

/** 能否成功独占绑定（比 TCP connect 更可靠，避免 dev:all 误判） */
export function isTcpPortInUse(port, host = "0.0.0.0") {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (err) => {
      resolve(/** @type {NodeJS.ErrnoException} */ (err).code === "EADDRINUSE");
    });
    probe.once("listening", () => {
      probe.close(() => resolve(false));
    });
    probe.listen({ port, host, exclusive: true });
  });
}
