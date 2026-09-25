# Deploying server-relayed multiplayer

Deploy the server update first, then the game website. Both updates are required.

## 1. Upgrade HoboPages

The `hobopages_ynh-1.3.0.tar.gz` archive is a YunoHost app package, not a website upload. Use it to upgrade the installed HoboPages application. Updating only its hosted game folder cannot enable the room service.

Before upgrading, create a full YunoHost backup of HoboPages and keep the old game release. The upgrade briefly restarts HoboPages, affecting every site on that instance. Site data format, visitor passwords and administrator credentials are preserved. Existing room connections cannot survive a restart.

For an installation whose app ID is `hobopages`, copy the archive to the server, extract it into an empty working directory, then use YunoHost's local-source upgrade:

```sh
tar -xzf hobopages_ynh-1.3.0.tar.gz
sudo yunohost app upgrade hobopages -u "$(pwd)/hobopages_ynh"
```

If this is a second instance, substitute its actual app ID (for example `hobopages__2`). Do not install a second instance to upgrade the existing one. This local delivery has not been pushed to your GitHub repository; upgrading from the old upstream URL will not pick up these changes.

The existing upgrade script copies the new source and reapplies Nginx automatically. Check that the upgrade completes and that the HoboPages admin page reports 1.3.0. No new environment variables or ports are needed. `HOBOPAGES_BASE_URL` must continue to match the public HTTPS domain, because incoming room connections are checked against that origin.

The new reserved route is `/<site-name>/__rooms`. Nginx forwards WebSocket upgrade headers on this route only. A hosted file at that exact path is now reserved. Static routes, uploads, authentication and release storage remain in the existing server.

## 2. Update the game

Open your existing game site in HoboPages. Retain at least two releases, upload `The-Last-Table-web-v0.7.0.zip`, enable extraction, and publish it. All devices should reload the same website URL.

Create `pokernight` on one device. Join `POKERNIGHT` on another. No server address should be necessary. Check that a duplicate host key is rejected and that leaving the host frees the key.

## Rollback

Restore the matching game and HoboPages versions together: game v0.6.0 needs HoboPages 1.2.0; game v0.7.0 needs HoboPages 1.3.0. A mismatched pair cannot connect.

Use the existing site release rollback for the website and restore the pre-upgrade HoboPages backup for the server. Preserve current site data before restoring an older full backup. Reload all devices afterward.

## Hosting limits

Six seats per room, 100 rooms and 600 open room-service connections per HoboPages process. Unjoined connections and guests awaiting host acceptance expire after 15 seconds. Per 10 seconds, hosts may send up to 3,000 messages (8 MB conservative text budget), guests 300 messages (1 MB), and unjoined clients 20 requests. Individual messages are bounded to 65,536 characters; adapter backpressure is capped at 256 KiB. Deno and application heartbeats detect dead sockets. The server now carries gameplay traffic. Rooms are temporary, unlisted and held in memory; they do not survive restarts.

The implementation assumes one HoboPages process, as supplied by this YunoHost package. Load-balancing multiple independent processes would require shared room state and is not supported by this package.

## Deployment verification limits

The Deno service and game are tested locally. The YunoHost install/upgrade scripts and Nginx configuration require verification on your actual YunoHost instance. No changes have been deployed to your live server by this delivery.

References: https://doc.yunohost.org/admin/backups/ and https://doc.yunohost.org/admin/upgrade/
