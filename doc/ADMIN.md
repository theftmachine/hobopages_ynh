## Changing the admin password

The password is kept in a file rather than in the app settings:

```bash
printf '%s' 'your-new-password' > /var/www/hobopages/admin_password
chown hobopages:hobopages /var/www/hobopages/admin_password
chmod 600 /var/www/hobopages/admin_password
systemctl restart hobopages
```

Use `printf` rather than `echo` so no trailing newline is added.

## Disk usage

Every deploy is a complete copy of the site, so the space a site occupies is roughly its size multiplied by the number of builds kept.

By default each site keeps **2** builds: the live one and the one before it, so you can always roll back once. Change it per site in the web interface under **Storage → Old builds to keep** — set it to 1 if a site is large and you never roll back, or higher for something you revise often. Lowering the number deletes the surplus immediately.

The disk gauge in the left column shows how much space the published sites use and how much is free.

### The safety margin

HoboPages refuses a deploy that would leave less than **2 GB** free, so publishing can never fill the drive and break other services. The check happens before anything is uploaded, and again during long uploads in case something else consumes the space meanwhile. Already-published sites keep serving normally when the disk is full — only new deploys are blocked.

Change the margin in `/var/www/hobopages/.env`:

```
HOBOPAGES_DISK_RESERVE_BYTES=2147483648
```

Free space is read using `df`. If that is unavailable the gauge disappears and the guard stops blocking, rather than refusing every deploy.

## Settings

`/var/www/hobopages/.env` holds the rest of the configuration — the default number of builds kept by new sites, the disk margin, session lifetime, and so on. Restart the service after editing. Note that upgrading the app regenerates this file; your version is backed up first.

## Where the sites live

```
/home/yunohost.app/hobopages/
  sites.json                       site metadata
  secret.key                       session signing key
  sites/<name>/releases/<id>/      the published files
```

This directory is included in YunoHost backups of the app.

## Logs

```bash
journalctl -u hobopages -f
```

## Sub-path hosting

Sites are served from a path rather than a domain root, so a build that hardcodes `/assets/app.js` needs help. Two per-site toggles handle it, both on by default:

- **Fix root-absolute links** rewrites `/…` URLs in HTML and CSS to `/<site>/…` at deploy time. Script bodies are deliberately left alone.
- **Rescue stray asset requests** serves root-absolute requests that arrive with a `Referer` pointing at the site.

If your build tool supports a base path, setting it is cleaner still — `base: '/mysite/'` in Vite, `basePath` in Next, `--base-href` in Angular. Turn both toggles off in that case.

One real limitation: `robots.txt` and `sitemap.xml` are only honoured at a domain root, so crawlers will not read them from a sub-path. For a site that needs real SEO, give it its own domain.
