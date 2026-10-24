import path from "node:path";

// Pure SBPL generation: callers resolve symlinks before entering the sandbox.
export function seatbeltProfile(paths: {
  stateDir: string;
  realStateDir: string;
  socket: string;
  realSocket: string;
}): string {
  const quote = (value: string) => {
    if (!value.startsWith("/") || /[\x00-\x1f\x7f]/.test(value))
      throw Error(
        "Seatbelt paths must be absolute and contain no control characters",
      );
    return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  };
  const states = [...new Set([paths.stateDir, paths.realStateDir])];
  const sockets = [
    ...new Set([
      paths.socket,
      paths.realSocket,
      ...states.map((state) => `${state}/runtime.sock`),
    ]),
  ];
  // A same-UID worker could rename an unprotected relocated socket or parent.
  const relocatedDirectories = new Set<string>();
  if (paths.socket !== path.join(paths.stateDir, "runtime.sock")) {
    for (const socket of [paths.socket, paths.realSocket]) {
      const directory = path.dirname(socket);
      relocatedDirectories.add(directory);
      if (directory === "/tmp" || directory.startsWith("/tmp/"))
        relocatedDirectories.add(`/private${directory}`);
      if (directory === "/private/tmp" || directory.startsWith("/private/tmp/"))
        relocatedDirectories.add(directory.slice("/private".length));
    }
  }
  return [
    "(version 1)",
    "(allow default)",
    ...states.map(
      (state) => `(deny file-read* file-write* (subpath ${quote(state)}))`,
    ),
    ...[...relocatedDirectories].flatMap((directory) => [
      `(deny file-write* (subpath ${quote(directory)}))`,
      `(deny network-outbound (remote unix-socket (subpath ${quote(directory)})))`,
    ]),
    ...sockets.map(
      (socket) =>
        `(deny network-outbound (remote unix-socket (path-literal ${quote(socket)})))`,
    ),
  ].join("\n");
}
