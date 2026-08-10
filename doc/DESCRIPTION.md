HoboPages turns a domain into your own static site host. Drag a built folder into a web page and it goes live at `your-domain/site-name/` — no SFTP, no shell, no build server.

Features:

- **Browser uploads.** Drop a folder or a `.zip`. Uploads are chunked, so file size is never a problem.
- **Many sites, one domain.** Each site lives at its own path.
- **Root-absolute links are fixed automatically.** A build that expects to sit at a domain root still works: links in HTML and CSS are rewritten at deploy time, and stray runtime asset requests are recovered from the `Referer` header.
- **Atomic deploys and rollback.** A release is staged in full then switched over, so visitors never see a half-uploaded site. The last ten releases are kept and any of them can be made live again in one click.
- **A real static server.** ETag and conditional requests, range requests for audio and video, gzip for text, long-lived caching for content-hashed filenames, single-page-app routing, clean URLs and custom 404 pages.
- **Per-site visitor passwords** and an on/off switch.

Written in Deno with no third-party dependencies.
