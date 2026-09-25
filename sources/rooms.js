// @ts-check
/** @typedef {{send: (message: string) => void, close: (code: number, reason: string) => void}} Transport */
/** @typedef {{readonly id: string, readonly scope: string, readonly transport: Transport, room: string | null, start: number, count: number, timer: ReturnType<typeof setTimeout> | null}} Client */
/** @typedef {{readonly host: string, readonly code: string, readonly members: Set<string>}} Room */

export class RoomError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

/** @param {unknown} value @returns {string} */
export function roomKey(value) {
  if (typeof value !== "string" || !/^[a-z0-9]{3,32}$/i.test(value)) {
    throw new RoomError(
      "INVALID_KEY",
      "Use 3–32 letters or numbers, with no spaces.",
    );
  }
  return value.toLowerCase();
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class RoomService {
  /** @type {Map<string, Client>} */
  clients = new Map();
  /** @type {Map<string, Room>} */
  rooms = new Map();

  /** @param {string} scope @param {Transport} transport @returns {string | null} */
  connect(scope, transport) {
    if (this.clients.size >= 600) {
      transport.close(1013, "Room service is full.");
      return null;
    }
    const id = crypto.randomUUID();
    const client = {
      id,
      scope,
      transport,
      room: null,
      start: Date.now(),
      count: 0,
      timer: setTimeout(
        () => this.drop(id, 1008, "Choose a room within 15 seconds."),
        15000,
      ),
    };
    this.clients.set(id, client);
    return id;
  }

  /** @param {string} id @param {unknown} raw @returns {void} */
  receive(id, raw) {
    const client = this.clients.get(id);
    if (!client) return;
    if (Date.now() - client.start > 10000) {
      client.start = Date.now();
      client.count = 0;
    }
    if (++client.count > 80) {
      this.drop(id, 1008, "Too many requests.");
      return;
    }
    if (typeof raw !== "string" || raw.length > 65536) {
      this.drop(id, 1009, "Invalid message size.");
      return;
    }
    try {
      /** @type {unknown} */
      const message = JSON.parse(raw);
      if (!record(message)) {
        throw new RoomError("INVALID_MESSAGE", "Expected a message object.");
      }
      if (message.type === "host" || message.type === "join") {
        this.enter(client, message);
      } else if (message.type === "signal") this.signal(client, message);
      else if (message.type === "remove-peer") {
        this.removePeer(client, message.to);
      } else throw new RoomError("INVALID_MESSAGE", "Unknown room request.");
    } catch (error) {
      const failure = error instanceof RoomError
        ? error
        : new RoomError("INVALID_MESSAGE", "Invalid room message.");
      this.send(id, {
        type: "error",
        code: failure.code,
        message: failure.message,
      });
    }
  }

  /** @param {Client} client @param {Record<string, unknown>} message @returns {void} */
  enter(client, message) {
    if (client.room) {
      throw new RoomError("ALREADY_JOINED", "Leave your current room first.");
    }
    const code = roomKey(message.code);
    const key = `${client.scope}/${code}`;
    if (message.type === "host") {
      if (this.rooms.has(key)) {
        throw new RoomError(
          "KEY_TAKEN",
          "That room key is already in use. Choose another.",
        );
      }
      if (this.rooms.size >= 100) {
        throw new RoomError(
          "ROOM_LIMIT",
          "The room service is full. Try again later.",
        );
      }
      this.rooms.set(key, { host: client.id, code, members: new Set() });
    }
    const room = this.rooms.get(key);
    if (!room) {
      throw new RoomError(
        "NOT_FOUND",
        "Room not found. Check the key and ask the host to create it first.",
      );
    }
    if (room.members.size >= 6) {
      throw new RoomError(
        "TABLE_FULL",
        "Table is full. All six seats are taken.",
      );
    }
    room.members.add(client.id);
    client.room = key;
    if (client.timer !== null) clearTimeout(client.timer);
    client.timer = null;
    this.send(client.id, {
      type: "room",
      code,
      id: client.id,
      hostId: room.host,
    });
    if (room.host !== client.id) {
      this.send(room.host, { type: "guest", id: client.id });
    }
  }

  /** @param {Client} client @param {Record<string, unknown>} message @returns {void} */
  signal(client, message) {
    const room = client.room ? this.rooms.get(client.room) : undefined;
    if (
      !room || typeof message.to !== "string" || message.to === client.id ||
      !room.members.has(message.to) ||
      (client.id !== room.host && message.to !== room.host)
    ) {
      throw new RoomError("INVALID_PEER", "Invalid peer.");
    }
    const description = message.description;
    const expected = client.id === room.host ? "offer" : "answer";
    if (
      !record(description) || description.type !== expected ||
      typeof description.sdp !== "string" ||
      !description.sdp.length || description.sdp.length > 60000
    ) {
      throw new RoomError("INVALID_SIGNAL", "Invalid connection description.");
    }
    this.send(message.to, {
      type: "signal",
      from: client.id,
      description: { type: description.type, sdp: description.sdp },
    });
  }

  /** @param {Client} client @param {unknown} target @returns {void} */
  removePeer(client, target) {
    const room = client.room ? this.rooms.get(client.room) : undefined;
    if (
      !room || room.host !== client.id || typeof target !== "string" ||
      target === client.id || !room.members.has(target)
    ) {
      throw new RoomError("INVALID_PEER", "Invalid peer.");
    }
    this.send(target, {
      type: "error",
      code: "PEER_FAILED",
      message: "The connection failed. Try joining again.",
    });
    this.drop(target, 1000, "Connection failed.");
  }

  /** @param {string} id @param {Record<string, unknown>} message @returns {void} */
  send(id, message) {
    const client = this.clients.get(id);
    if (!client) return;
    try {
      client.transport.send(JSON.stringify(message));
    } catch {
      this.drop(id, 1011, "Connection lost.");
    }
  }

  /** @param {string} id @returns {void} */
  disconnect(id) {
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    if (client.timer !== null) clearTimeout(client.timer);
    const room = client.room ? this.rooms.get(client.room) : undefined;
    if (!room) return;
    room.members.delete(id);
    if (room.host !== id) {
      this.send(room.host, { type: "peer-left", id });
      return;
    }
    this.rooms.delete(/** @type {string} */ (client.room));
    for (const member of room.members) {
      this.send(member, {
        type: "error",
        code: "HOST_LEFT",
        message: "The host left. This room has closed.",
      });
      this.drop(member, 1000, "Host left.");
    }
  }

  /** @param {string} id @param {number} code @param {string} reason @returns {void} */
  drop(id, code, reason) {
    const client = this.clients.get(id);
    this.disconnect(id);
    if (!client) return;
    try {
      client.transport.close(code, reason);
    } catch {
      console.warn({ event: "room-close-failed", code });
    }
  }

  /** @param {string} scope @returns {void} */
  closeScope(scope) {
    for (const client of this.clients.values()) {
      if (client.scope === scope) {
        this.drop(client.id, 1001, "Site access changed.");
      }
    }
  }

  /** @returns {void} */
  close() {
    for (const id of this.clients.keys()) {
      this.drop(id, 1001, "Server restarting.");
    }
  }
}
