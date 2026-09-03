// Copyright 2026 the AAI authors. MIT license.
/**
 * Answering a WebSocket upgrade handshake with a real HTTP response — the
 * one shape shared by every refusal/redirect site (plain-upgrade redirect,
 * broker 404/503, catch-all 500). A bare RST is
 * indistinguishable from a network fault to the caller, so every site
 * answers the handshake before destroying the socket.
 */

/** Minimal socket surface an upgrade answer needs. */
export type UpgradeReplySocket = { write: (data: string) => unknown; destroy: () => unknown };

/**
 * Write an HTTP response onto the upgrade socket and destroy it.
 * `status` is the full status line ("503 Service Unavailable");
 * `extraHeaders` append after the fixed Connection/Content-Type pair
 * (e.g. a Location for redirects).
 */
export function answerUpgrade(
  socket: UpgradeReplySocket,
  status: string,
  body: string,
  extraHeaders: string[] = [],
): void {
  const headers = ["Connection: close", "Content-Type: text/plain", ...extraHeaders];
  try {
    socket.write(`HTTP/1.1 ${status}\r\n${headers.join("\r\n")}\r\n\r\n${body}`);
  } catch {
    // Socket already gone — destroy below is all that's left.
  }
  socket.destroy();
}
