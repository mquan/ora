/**
 * `gregorian daemon` — run the long-lived daemon in the foreground.
 *
 * Boots the {@link Daemon} (store + scheduler + loopback API), prints the bind address, and stays alive
 * (the HTTP server + croner keep the event loop running). SIGINT/SIGTERM trigger a graceful `stop()`.
 * In v1 the OS keep-alive unit (m4 launchd) is what relaunches this at login; here it's a plain
 * foreground process.
 */

import { Daemon } from "../../daemon/daemon.js";

export async function daemonCommand(args: string[]): Promise<number> {
  let port: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      const value = args[++i];
      port = Number(value);
      if (value === undefined || Number.isNaN(port)) {
        process.stderr.write("gregorian daemon: --port must be a number\n");
        return 1;
      }
    } else {
      process.stderr.write(`gregorian daemon: unknown option '${args[i]}'\n`);
      return 1;
    }
  }

  const daemon = new Daemon(port !== undefined ? { port } : {});
  try {
    const info = await daemon.start();
    process.stdout.write(
      `gregorian daemon running on http://127.0.0.1:${info.port} (pid ${info.pid})\n` +
        "Press Ctrl-C to stop.\n",
    );
  } catch (err) {
    process.stderr.write(`gregorian daemon: ${(err as Error).message}\n`);
    return 1;
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write("\ngregorian daemon: shutting down…\n");
    void daemon.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Never resolves — the daemon runs until a signal calls process.exit via shutdown().
  return new Promise<number>(() => {});
}
