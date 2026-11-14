# MeteoLab: 3D Weather Sandbox

## GitHub Pages

GitHub Pages is configured to publish the repository root from `main`. Generate the deployable single-file `index.html` with:

```sh
npm ci
npm run build:pages
```

Commit the updated root `index.html` after changing the app. The Vite source template is `app.html`; the build targets `/3dweathersandboxv2/` and bundles the app into one self-contained HTML file.

## Controls and audio

- Desktop: move with WASD or the arrow keys; ground movement is set to 120 km/h. Drag the scene to look around.
- Mobile: use the on-screen joystick; keyboard movement is disabled.
- Sound is opt-in from the toolbar. Wind, rain, and distance-delayed thunder are synthesized locally in the browser, so no audio files or network requests are needed.
