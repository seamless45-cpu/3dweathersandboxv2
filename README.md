# MeteoLab: 3D Weather Sandbox

## GitHub Pages

GitHub Pages serves the static site from the `docs/` folder on `main`. Generate the single-file deployment with:

```sh
npm ci
npm run build:pages
```

Commit the updated `docs/index.html` after changing the app. The build targets the project-page path `/3dweathersandboxv2/` and bundles the app into one HTML file.