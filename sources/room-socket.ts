import { RoomService } from "./rooms.js";

export function openRoomSocket(
  req: Request,
  scope: string,
  baseUrl: string,
  service: RoomService,
): Response {
  if (
    req.method !== "GET" ||
    req.headers.get("upgrade")?.toLowerCase() !== "websocket"
  ) {
    return new Response("A WebSocket connection is required.", { status: 426 });
  }
  if (req.headers.get("origin") !== new URL(baseUrl).origin) {
    return new Response("This room service only accepts its own website.", {
      status: 403,
    });
  }
  try {
    const { socket, response } = Deno.upgradeWebSocket(req, {
      idleTimeout: 30,
    });
    let id: string | null = null;
    socket.onopen = (): void => {
      id = service.connect(scope, {
        send(message: string): void {
          if (
            socket.readyState !== WebSocket.OPEN ||
            socket.bufferedAmount > 262144
          ) {
            throw new Error("Room connection is unavailable.");
          }
          socket.send(message);
        },
        close(code: number, reason: string): void {
          socket.close(code, reason);
        },
      });
    };
    socket.onmessage = (event: MessageEvent<unknown>): void => {
      if (id !== null) service.receive(id, event.data);
    };
    socket.onclose = (): void => {
      if (id !== null) service.disconnect(id);
    };
    socket.onerror = (): void => {
      if (id !== null) service.drop(id, 1011, "Room connection failed.");
    };
    return response;
  } catch {
    return new Response("Could not open the room connection.", { status: 400 });
  }
}
