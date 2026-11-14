# MeteoLab: 3D Weather Sandbox

## GitHub Pages

GitHub Pages is configured to publish the repository root from `main`. Generate the deployable single-file `index.html` with:

```sh
npm ci
npm run build:pages
```

Commit the updated root `index.html` after changing the app. The Vite source template is `app.html`; the build targets `/3dweathersandboxv2/` and bundles the app into one self-contained HTML file.
