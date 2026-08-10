# HoboPages for YunoHost

[![Install HoboPages with YunoHost](https://install-app.yunohost.org/install-with-yunohost.svg)](https://install-app.yunohost.org/?app=hobopages)

*This package lets you install HoboPages quickly and simply on a YunoHost server. If you don't have YunoHost, please consult [the guide](https://yunohost.org/install) to learn how to install it.*

## Overview

HoboPages turns a domain into your own static site host. Drag a built folder into a web page and it goes live at `your-domain/site-name/` — no SFTP, no shell, no build server.

- **Browser uploads.** Drop a folder or a `.zip`. Uploads are chunked, so file size is never a problem.
- **Many sites, one domain.** Each site lives at its own path.
- **Root-absolute links are fixed automatically.** A build that expects to sit at a domain root still works: links in HTML and CSS are rewritten at deploy time, and stray runtime asset requests are recovered from the `Referer` header.
- **Atomic deploys and rollback.** A release is staged in full then switched over, so visitors never see a half-uploaded site. The last ten releases are kept and any can be made live in one click.
- **A real static server.** ETag and conditional requests, range requests for audio and video, gzip for text, immutable caching for content-hashed filenames, single-page-app routing, clean URLs and custom 404 pages.
- **Per-site visitor passwords** and an on/off switch.

Written in Deno with no third-party dependencies.

**Shipped version:** 1.0.1~ynh1

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
deno task test      # 86 integration assertions against a live instance
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
