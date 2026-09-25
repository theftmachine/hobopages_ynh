# Deploying custom room keys

Deploy the server update first, then the game website. Both updates are required.

## 1. Upgrade HoboPages

The `hobopages_ynh-1.2.0.tar.gz` archive is a YunoHost app package, not a website upload. Use it to upgrade the installed HoboPages application. Updating only its hosted game folder cannot enable the room service.

Before upgrading, create a full YunoHost backup of HoboPages and keep the old game release. The upgrade briefly restarts HoboPages, affecting every site on that instance. Site data format, visitor passwords and administrator credentials are preserved. Existing room connections cannot survive a restart.

For an installation whose app ID is `hobopages`, copy the archive to the server, extract it into an empty working directory, then use YunoHost's local-source upgrade:

```sh
tar -xzf hobopages_ynh-1.2.0.tar.gz
sudo yunohost app upgrade hobopages -u "$(pwd)/hobopages_ynh"
```

If this is a second instance, substitute its actual app ID (for example `hobopages__2`). Do not install a second instance to upgrade the existing one. This local delivery has not been pushed to your GitHub repository; upgrading from the old upstream URL will not pick up these changes.

The existing upgrade script copies the new source and reapplies Nginx automatically. Check that the upgrade completes and that the HoboPages admin page reports 1.2.0. No new environment variables or ports are needed. `HOBOPAGES_BASE_URL` must continue to match the public HTTPS domain, because incoming room connections are checked against that origin.

The new reserved route is `/<site-name>/__rooms`. Nginx forwards WebSocket upgrade headers on this route only. A hosted file at that exact path is now reserved. Static routes, uploads, authentication and release storage remain in the existing server.

## 2. Update the game

Open your existing game site in HoboPages. Retain at least two releases, upload `The-Last-Table-web-v0.6.0.zip`, enable extraction, and publish it. All devices should reload the same website URL.

Create `pokernight` on one device. Join `POKERNIGHT` on another. No server address should be necessary. Check that a duplicate host key is rejected and that leaving the host frees the key.

## Rollback

For a game problem, use HoboPages' existing release rollback to restore the complete previous game release, then reload all devices. v0.5.0 manual invitations work independently of the new room service; its old random-room protocol does not.

For a host-server problem, restore the pre-upgrade HoboPages backup through YunoHost's documented application restore workflow. Preserve current site data before restoring an older full backup; it may restore older website releases too. Do not delete the data directory or use a purge operation as a rollback shortcut. Returning HoboPages to 1.1.0 also requires returning the game to v0.5.0 for its old multiplayer interface.

## Hosting limits

Six seats per room, 100 rooms and 600 open room-service connections per HoboPages process. Unjoined connections expire after 15 seconds. Signalling is rate limited to 80 messages per connection per 10 seconds, with bounded message sizes. Deno heartbeat detects dead sockets. Rooms are temporary, unlisted and held in memory; they do not survive restarts.

The implementation assumes one HoboPages process, as supplied by this YunoHost package. Load-balancing multiple independent processes would require shared room state and is not supported by this package.

## Deployment verification limits

The Deno service and game are tested locally. The YunoHost install/upgrade scripts and Nginx configuration require verification on your actual YunoHost instance. No changes have been deployed to your live server by this delivery.

References: https://doc.yunohost.org/admin/backups/ and https://doc.yunohost.org/admin/upgrade/
