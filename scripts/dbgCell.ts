import { AtmosphereSimulationCoordinator } from '../src/sim/atmosphereCoordinator';
function run(tag: string) {
  const c = new AtmosphereSimulationCoordinator();
  const g: any = c.grid; const rod: any = c.lightningRod;
  let nan = 0, checked = 0, maxW = 0, maxV = 0, torn = 0;
  const fields = [g.u, g.vy, g.w, g.qc, g.qi, g.qr, g.rhoQ, g.phi, g.ex, g.ey, g.ez];
  for (let f = 0; f < 20000; f++) {
    c.config.solarInsolationScale = 1.0; c.step(1/60, 12, false, 0, 0);
    if (f % 250 === 0) {
      for (const arr of fields) {
        for (let i = 0; i < arr.length; i += 97) { checked++; if (!Number.isFinite(arr[i])) nan++; }
      }
    }
    for (const cell of c.cellManager.cells) if ((cell as any).updraftMaxMS > maxW) maxW = (cell as any).updraftMaxMS;
    for (const t of c.tornadoes.active) if (t.maxTangentialMS > maxV) maxV = t.maxTangentialMS;
    torn = c.tornadoes.totalFormed;
  }
  const sig = [c.lightning.totalFlashes, c.lightning.totalTLEs, torn,
    +maxW.toFixed(6), +maxV.toFixed(6), +g.maxCFL.toFixed(6),
    +g.domainCloudCoverFraction.toFixed(6), rod.upwardLeaders,
    c.lightning.rodUpwardFlashes, rod.interceptedStrikes, nan].join('|');
  console.log(`${tag} ${sig}`);
  console.log(`   nonfinite ${nan} / ${checked} sampled   CFL ${g.maxCFL.toFixed(3)}  divRes ${g.maxDivergenceResidual.toExponential(2)}  maxUpdraft ${maxW.toFixed(1)}  peakTornado ${maxV.toFixed(1)} m/s`);
  return sig;
}
const a = run('RUN A');
const b = run('RUN B');
console.log(`\nDETERMINISTIC: ${a === b}`);
