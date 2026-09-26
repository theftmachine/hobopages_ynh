// @ts-check
/** @typedef {{send: (message: string) => void, close: (code: number, reason: string) => void}} Transport */
/** @typedef {{readonly id: string, readonly scope: string, readonly transport: Transport, room: string | null, ready: boolean, bytes: number, start: number, count: number, timer: ReturnType<typeof setTimeout> | null, resumeKey?: string}} Client */
/** @typedef {{host: string, readonly code: string, readonly members: Set<string>, term: number, checkpoint: any, owners: Map<number,string>, retired: Set<string>}} Room */

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
  /** @param {Array<RTCIceServer>} iceServers */
  constructor(iceServers = [{urls: 'stun:stun.l.google.com:19302'}]) {
    if (!Array.isArray(iceServers) || iceServers.length > 8 || iceServers.some(s => {
      if (!s || typeof s !== 'object') return true;
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return !urls.length || urls.length > 8 || urls.some(u => typeof u !== 'string' || u.length > 512 || !/^(stun|stuns|turn|turns):[^\s]+$/.test(u)) || (urls.some(u => /^turns?:/.test(u)) && (typeof s.username !== 'string' || !s.username || typeof s.credential !== 'string' || !s.credential));
    })) throw new Error('Invalid HOBOPAGES_VOICE_ICE_SERVERS: expected an ICE server array; TURN requires username and credential.');
    this.iceServers = iceServers;
  }

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
      bytes: 0,
      ready: false,
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
    if(client.room){if(client.timer!==null)clearTimeout(client.timer);client.timer=setTimeout(()=>this.drop(id,1008,"Connection timed out."),45000);}
    if (Date.now() - client.start > 10000) {
      client.start = Date.now();
      client.count = 0;
      client.bytes = 0;
    }
    const hosting = client.room && this.rooms.get(client.room)?.host === id;
    if (++client.count > (hosting ? 3000 : client.room ? 300 : 20)) {
      this.drop(id, 1008, "Too many requests.");
      return;
    }
    if (typeof raw !== "string" || raw.length > 65536) {
      this.drop(id, 1009, "Invalid message size.");
      return;
    }
    client.bytes += raw.length * 2;
    if (client.bytes > (hosting ? 8000000 : 1000000)) {
      this.drop(id, 1008, "Too much data.");
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
      } else if (message.type === "game") this.relay(client, message);
      else if (message.type === "checkpoint") this.checkpoint(client, message);
      else if (message.type === "accept-peer") this.accept(client, message.to);
      else if (message.type === "ping" && client.room) {
        this.send(id, { type: "pong" });
      } else if (message.type === "remove-peer") {
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
    if (message.protocol !== 3) {
      throw new RoomError(
        "UPGRADE_REQUIRED",
        "Update Hobo Poker to v0.15.0 or newer and reload.",
      );
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
      this.rooms.set(key, { host: client.id, code, members: new Set(), term:1, checkpoint:null, owners:new Map(), retired:new Set() });
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
    const resumeKey=typeof message.resumeKey==='string'&&/^[a-zA-Z0-9-]{16,80}$/.test(message.resumeKey)?message.resumeKey:crypto.randomUUID();
    if([...room.members].some(id=>this.clients.get(id)?.resumeKey===resumeKey))throw new RoomError('ALREADY_CONNECTED','This player is already connected. Close the other game tab or wait for the connection to time out.');
    client.resumeKey=resumeKey;
    room.members.add(client.id);
    client.room = key;
    if (client.timer !== null) clearTimeout(client.timer);
    client.ready = room.host === client.id;
    client.timer = client.ready ? setTimeout(()=>this.drop(client.id,1008,"Connection timed out."),45000) : setTimeout(
      () => this.drop(client.id, 1008, "Host did not respond."),
      15000,
    );
    this.send(client.id, {
      protocol: 3,
      term:room.term,
      voice: 1,
      iceServers: this.iceServers,
      type: "room",
      code,
      id: client.id,
      hostId: room.host,
    });
    if (room.host !== client.id) {
      this.send(room.host, { type: "guest", id: client.id, seat:[...room.owners].find(([,key])=>key===resumeKey)?.[0] });
    }
  }

  /** @param {Client} client @param {unknown} target */
  accept(client, target) {
    const room = client.room ? this.rooms.get(client.room) : undefined;
    const peer = typeof target === "string"
      ? this.clients.get(target)
      : undefined;
    if (
      !room || room.host !== client.id || !peer || peer.id === client.id ||
      peer.room !== client.room || peer.ready
    ) throw new RoomError("INVALID_PEER", "Invalid peer.");
    peer.ready = true;
    if (peer.timer !== null) clearTimeout(peer.timer);
    peer.timer = setTimeout(()=>this.drop(peer.id,1008,"Connection timed out."),45000);
    this.send(peer.id, { type: "peer-ready", id: client.id });
  }

  /** @param {Client} client @param {Record<string, unknown>} message */
  relay(client, message) {
    const room = client.room ? this.rooms.get(client.room) : undefined;
    if(room&&room.retired.has(String(message.to)))return; // Ignore actions already in flight to a departed host.
    const peer = typeof message.to === "string"
      ? this.clients.get(message.to)
      : undefined;
    if (
      !room || !peer || !client.ready || !peer.ready || peer.id === client.id ||
      peer.room !== client.room ||
      (client.id !== room.host && peer.id !== room.host)
    ) throw new RoomError("INVALID_PEER", "Invalid peer.");
    const payload = message.payload;
    const allowed = client.id === room.host
      ? ["welcome", "state", "emote", "look", "peek", "error", "voice"]
      : ["hello", "action", "emote", "look", "peek", "voice"];
    if (
      !record(payload) || typeof payload.type !== "string" ||
      !allowed.includes(payload.type)
    ) throw new RoomError("INVALID_GAME", "Invalid game message.");
    if (payload.type === 'voice') {
      if (JSON.stringify(payload).length > 26000 || !['presence','roster','signal'].includes(String(payload.kind)) || (client.id !== room.host && payload.kind === 'roster')) throw new RoomError('INVALID_GAME','Invalid voice message.');
    }
    this.send(peer.id, { type: "game", from: client.id, payload });
  }

  /** @param {Client} client @param {Record<string,any>} message */
  checkpoint(client,message){
    const room=client.room?this.rooms.get(client.room):undefined;
    if(!room||room.host!==client.id||message.term!==room.term)throw new RoomError('NOT_HOST','Only the current host can save the table.');
    const c=message.snapshot;
    if(!record(c)||c.version!==1||!record(c.game)||!Array.isArray(c.game.players)||c.game.players.length!==6||!Array.isArray(c.seats)||c.seats.length>6||!['warehouse','backrooms'].includes(String(c.theme))||JSON.stringify(c).length>50000)throw new RoomError('INVALID_CHECKPOINT','Invalid recovery snapshot.');
    const ids=new Set(),seats=new Set();
    for(const entry of c.seats){if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||!room.members.has(entry[0])||!Number.isInteger(entry[1])||entry[1]<0||entry[1]>5||ids.has(entry[0])||seats.has(entry[1]))throw new RoomError('INVALID_CHECKPOINT','Invalid recovery seats.');ids.add(entry[0]);seats.add(entry[1]);}
    if(!ids.has(client.id))throw new RoomError('INVALID_CHECKPOINT','Host seat missing.');
    room.checkpoint=c;
    for(const [id,seat] of c.seats){const key=this.clients.get(id)?.resumeKey;if(key)room.owners.set(seat,key);}
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
    /** @type {{seats:Array<[string,number]>}|null} */
    const checkpoint=room.checkpoint;
    const next=[...room.members].find(member=>this.clients.get(member)?.ready&&checkpoint?.seats.some(entry=>entry[0]===member));
    if(next&&checkpoint){
      room.retired.add(id);room.host=next;room.term++;
      const connected=checkpoint.seats.filter(entry=>room.members.has(entry[0]));
      const departed=checkpoint.seats.filter(entry=>!room.members.has(entry[0])).map(entry=>entry[1]);
      for(const member of room.members)this.send(member,{type:'host-changed',hostId:next,term:room.term,...(member===next?{snapshot:checkpoint,peers:[...room.members].filter(p=>p!==next).map(p=>({id:p,seat:connected.find(entry=>entry[0]===p)?.[1]})),departed}: {})});
      return;
    }
    this.rooms.delete(/** @type {string} */ (client.room));
    for (const member of room.members) {
      this.send(member, {type:'error',code:'HOST_LEFT',message:'No connected player can recover this table. Create a new room.'});
      this.drop(member,1000,'Room ended.');
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
