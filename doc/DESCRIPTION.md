HoboPages turns a domain into your own static site host. Drag a built folder into a web page and it goes live at `your-domain/site-name/` — no SFTP, no shell, no build server.

Features:

- **Browser uploads.** Drop a folder or a `.zip`. Uploads are chunked, so file size is never a problem.
- **Many sites, one domain.** Each site lives at its own path.
- **Root-absolute links are fixed automatically.** A build that expects to sit at a domain root still works: links in HTML and CSS are rewritten at deploy time, and stray runtime asset requests are recovered from the `Referer` header.
- **Atomic deploys and rollback.** A build is staged in full then switched over, so visitors never see a half-uploaded site. By default the previous build is kept so you can roll back in one click; adjust per site from 1 to 20.
- **Small footprint by design.** Old builds are pruned automatically, and deploys are refused before they can fill the disk, leaving a configurable margin free for everything else on the server.
- **A real static server.** ETag and conditional requests, range requests for audio and video, gzip for text, long-lived caching for content-hashed filenames, single-page-app routing, clean URLs and custom 404 pages.
- **Per-site visitor passwords** and an on/off switch.

Written in Deno with no third-party dependencies.
