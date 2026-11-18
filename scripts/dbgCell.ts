import { AtmosphereSimulationCoordinator } from '../src/sim/atmosphereCoordinator';
function run(burn: boolean) {
  const c = new AtmosphereSimulationCoordinator();
  const g: any = c.grid;
  let flashes = 0, tles = 0;
  const seen = new Set<string>();
  for (let f = 0; f < 9000; f++) {
    c.config.solarInsolationScale = 1.0;
    c.step(1/60, 12, false, 0, 0);
    if (burn && f % 300 === 0) { const t = Date.now(); while (Date.now() - t < 4) {} }
    for (const cell of c.cellManager.cells) seen.add(cell.stage);
  }
  flashes = c.lightning.totalFlashes; tles = c.lightning.totalTLEs;
  let satSum = 0, satMax = 0, wet = 0;
  for (let i = 0; i < g.groundSat.length; i++) {
    satSum += g.groundSat[i];
    if (g.groundSat[i] > satMax) satMax = g.groundSat[i];
    if (g.groundSat[i] > 0.01) wet++;
  }
  return `rain=${c.observerRainMMHr.toFixed(9)} flash=${flashes} tle=${tles} cells=${c.cellManager.cells.length} ` +
         `maxW=${Math.max(0,...c.cellManager.cells.map((x:any)=>x.updraftMaxMS)).toFixed(6)} ` +
         `satSum=${satSum.toFixed(6)} satMax=${satMax.toFixed(6)} wetCols=${wet} ` +
         `E=${c.electrification.maxElectricFieldKVm.toFixed(6)} drift=${c.waterMassDriftPercent}`;
}
const a = run(false);
const b = run(true);
const c2 = run(false);
console.log('clean    :', a);
console.log('CPU-burn :', b);
console.log('clean #2 :', c2);
console.log('\nDETERMINISTIC (no wall-clock coupling):', a === b && b === c2);
