## Changing the admin password

The password is kept in a file rather than in the app settings:

```bash
printf '%s' 'your-new-password' > /var/www/hobopages/admin_password
chown hobopages:hobopages /var/www/hobopages/admin_password
chmod 600 /var/www/hobopages/admin_password
systemctl restart hobopages
```

Use `printf` rather than `echo` so no trailing newline is added.

## Settings

`/var/www/hobopages/.env` holds the rest of the configuration — how many releases to keep, session lifetime, and so on. Restart the service after editing. Note that upgrading the app regenerates this file; your version is backed up first.

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
