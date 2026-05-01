# Librarian AI — landing page

Static site you can host anywhere. Point visitors at the repo, design doc, and spec; optional buttons activate when you add Chrome Web Store or release URLs.

## Configure links

Edit `config.js`:

- `githubRepo` — your GitHub (or GitLab) repository URL (no trailing slash).
- `chromeWebStore` — optional listing URL; leave `""` to keep the button disabled.
- `latestReleaseZip` — optional direct download link; leave `""` if unused.

Until `githubRepo` is a real URL, **View source** / footer links use `#configure-repo` and show a browser tooltip.

## Deploy

This folder is self-contained (`index.html`, `styles.css`, `config.js`). Examples:

- **Netlify / Cloudflare Pages / Vercel:** create a project with root directory `landing` (or upload this folder only).
- **GitHub Pages:** publish the `landing` directory as the site root, or use an Action that copies `landing/*` to `gh-pages`.

No build step required.
