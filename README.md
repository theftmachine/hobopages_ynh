## 1.5.1 — Immediate password retries

Removed the admin login lockout after incorrect passwords. You can retry immediately, and a correct password signs in even after repeated failures. Upgrade restarts the service and clears any existing in-memory lockout.

## 1.5.0 — Automatic poker host migration

Room protocol 3 adds private recovery snapshots, ordered host election,
reconnect identities and a 45-second inactive connection timeout. Requires
Hobo Poker Alpha v0.15.0 on all clients. Existing TURN configuration is unchanged.

See doc/HOST-MIGRATION.md for details. Recovery is in memory while the server and
at least one eligible player remain connected; it does not survive server restart.

## 1.4.0 — Hobo Poker voice signalling

Adds bounded voice connection messages to the existing authenticated room relay
and advertises voice support to clients. Poker protocol 2 remains compatible.
Raw microphone audio uses WebRTC rather than the Deno WebSocket service.

Optional `HOBOPAGES_VOICE_ICE_SERVERS` accepts a JSON RTCIceServer array. Defaults
to Google's STUN server. TURN credentials must be provided for relay access;
a TURN service is not included. See `doc/VOICE-SETUP.md` for deployment details.

# HoboPages for YunoHost

[![Install HoboPages with YunoHost](https://install-app.yunohost.org/install-with-yunohost.svg)](https://install-app.yunohost.org/?app=hobopages)

*This package lets you install HoboPages quickly and simply on a YunoHost server. If you don't have YunoHost, please consult [the guide](https://yunohost.org/install) to learn how to install it.*

## Overview

HoboPages turns a domain into your own static site host. Drag a built folder into a web page and it goes live at `your-domain/site-name/` — no SFTP, no shell, no build server.

- **Browser uploads.** Drop a folder or a `.zip`. Uploads are chunked, so file size is never a problem.
- **Many sites, one domain.** Each site lives at its own path.
- **Root-absolute links are fixed automatically.** A build that expects to sit at a domain root still works: links in HTML and CSS are rewritten at deploy time, and stray runtime asset requests are recovered from the `Referer` header.
- **Atomic deploys and rollback.** A build is staged in full then switched over, so visitors never see a half-uploaded site. By default the previous build is kept so you can roll back in one click; adjust per site from 1 to 20.
- **Small footprint by design.** Old builds are pruned automatically, and deploys are refused before they can fill the disk, leaving a configurable margin (2 GB by default) free for everything else.
- **A real static server.** ETag and conditional requests, range requests for audio and video, gzip for text, immutable caching for content-hashed filenames, single-page-app routing, clean URLs and custom 404 pages.
- **Per-site visitor passwords** and an on/off switch.

Written in Deno with no third-party dependencies.

**Shipped version:** 1.3.0~ynh1

## New in 1.3.0

Server-relayed multiplayer for The Last Table v0.7.0, at `/<site>/__rooms`. Each site has its own room namespace. Keys accept 3–32 letters/numbers and ignore case. Existing visitor passwords and enabled settings protect the endpoint; changing either closes its active room sessions. Rooms are bounded, rate limited and cleared when hosts disconnect. The server forwards gameplay only between the host and its accepted guests; no STUN/TURN setup is required. Protocol 2 requires the matching game update.

Nginx forwards WebSocket upgrades on that route. No extra process, port, dependency, environment variable or persistent database is added. The shared protocol is `sources/rooms.js`, and the Deno adapter is `sources/room-socket.ts`.

Also fixes weak ETag comparison, HEAD compression headers, and typed-array annotations incompatible with the package's pinned Deno 2.1.4 runtime. The compression test now reads the wire because Deno fetch strips encoding headers after decompression.

**For this local package, use the upgrade instructions in [doc/POKER_ROOMS.md](doc/POKER_ROOMS.md). The source has not been published to the upstream GitHub URL below.**

## Screenshots

The admin interface is a two-pane console: sites on the left, a drop bay and release ledger on the right.

## Installation

From the webadmin, go to **Applications → Install a custom app** and paste:

```
https://github.com/DizzyHobo/hobopages_ynh
```

Or from the command line:

```bash
sudo yunohost app install https://github.com/DizzyHobo/hobopages_ynh
```

You will be asked for a domain and an admin password.

### This is a full-domain app

HoboPages takes over the whole domain, because site names become paths on it. Give it a domain of its own:

```bash
sudo yunohost domain add pages.example.com
```

Keep the app's permission set to **visitors** — published sites need to be reachable by anyone, and the admin interface is protected by its own password regardless.

## Documentation

- Admin guide: [doc/ADMIN.md](doc/ADMIN.md) — changing the password, settings, logs, sub-path hosting notes.

## Architectures

`amd64` and `arm64`. Deno does not publish Linux builds for 32-bit ARM, so armhf boards (Raspberry Pi running a 32-bit OS) are not supported.

## Development

The application itself lives in `sources/` and is copied into the install directory by the install script; the Deno runtime is fetched as a declared source with a pinned checksum.

```bash
deno task check     # type-check
deno task test      # 125 HTTP/storage assertions plus room lifecycle tests
deno task start     # run locally
```

Local run:

```bash
HOBOPAGES_ADMIN_PASSWORD=devpassword \
HOBOPAGES_DATA_DIR=./data \
HOBOPAGES_BASE_URL=http://localhost:8787 \
HOBOPAGES_COOKIE_SECURE=false \
deno task start
```

`tests.toml` is configuration for YunoHost's `package_check` CI and has not been exercised against a real runner.

## Upgrading Deno

The runtime is pinned in `manifest.toml` under `[resources.sources.deno]`. To move to a newer release, update both URLs and both `sha256` values, and bump the package version:

```bash
curl -sL -o deno.zip https://github.com/denoland/deno/releases/download/vX.Y.Z/deno-x86_64-unknown-linux-gnu.zip
sha256sum deno.zip
```

## License

MIT. See [LICENSE](LICENSE).
