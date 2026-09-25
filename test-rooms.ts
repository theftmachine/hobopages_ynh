import { roomKey, RoomService } from "./sources/rooms.js";

function check(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

Deno.test("room keys, namespaces, membership and lifecycle", () => {
  const service = new RoomService();
  function client(scope: string): {
    id: string;
    messages: Record<string, unknown>[];
    closed: number[];
  } {
    const messages: Record<string, unknown>[] = [];
    const closed: number[] = [];
    const id = service.connect(scope, {
      send(raw: string): void {
        messages.push(JSON.parse(raw));
      },
      close(code: number): void {
        closed.push(code);
      },
    });
    if (!id) throw new Error("Could not connect.");
    return { id, messages, closed };
  }
  try {
    check(roomKey("PokerNight") === "pokernight", "Case folding failed.");
    for (const key of ["ab", "a b", "a".repeat(33), "a/b", null, 123]) {
      let rejected = false;
      try {
        roomKey(key);
      } catch {
        rejected = true;
      }
      check(rejected, "Invalid key was accepted.");
    }
    const host = client("poker");
    const other = client("other");
    const guest = client("poker");
    service.receive(
      host.id,
      JSON.stringify({ type: "host", protocol: 2, code: "Friday" }),
    );
    service.receive(
      other.id,
      JSON.stringify({ type: "host", protocol: 2, code: "Friday" }),
    );
    check(service.rooms.size === 2, "Sites must have independent rooms.");
    service.receive(
      guest.id,
      JSON.stringify({ type: "host", protocol: 2, code: "FRIDAY" }),
    );
    check(
      guest.messages.at(-1)?.code === "KEY_TAKEN",
      "Duplicate key allowed.",
    );
    service.receive(
      guest.id,
      JSON.stringify({ type: "join", protocol: 2, code: "FRIDAY" }),
    );
    check(guest.messages.at(-1)?.hostId === host.id, "Joined the wrong host.");
    service.receive(
      guest.id,
      JSON.stringify({ type: "remove-peer", to: host.id }),
    );
    check(
      guest.messages.at(-1)?.code === "INVALID_PEER",
      "Guest could remove host.",
    );
    service.disconnect(host.id);
    check(guest.closed.length === 1, "Guest was not disconnected.");
    const replacement = client("poker");
    service.receive(
      replacement.id,
      JSON.stringify({ type: "host", protocol: 2, code: "friday" }),
    );
    check(
      replacement.messages.at(-1)?.type === "room",
      "Key was not released.",
    );
    service.closeScope("other");
    check(
      !service.clients.has(other.id),
      "Site shutdown left connections open.",
    );
  } finally {
    service.close();
    check(
      service.clients.size === 0 && service.rooms.size === 0,
      "State leaked.",
    );
  }
});

Deno.test("room service bounds messages and removes idle clients on shutdown", () => {
  const service = new RoomService();
  const closed: number[] = [];
  try {
    const id = service.connect("poker", {
      send(): void {},
      close(code: number): void {
        closed.push(code);
      },
    });
    if (!id) throw new Error("Could not connect.");
    service.receive(id, "x".repeat(65537));
    check(
      closed[0] === 1009 && service.clients.size === 0,
      "Oversized input allowed.",
    );
  } finally {
    service.close();
  }
});
