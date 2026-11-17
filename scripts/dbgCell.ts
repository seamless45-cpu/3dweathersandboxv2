import { AtmosphereSimulationCoordinator } from '../src/sim/atmosphereCoordinator';
const c = new AtmosphereSimulationCoordinator();
const g: any = c.grid;
let maxAnv=0, firstAnv=-1;
const stages: Record<string,number> = {};
for (let f = 0; f < 22000; f++) {
  c.config.solarInsolationScale = 1.0;   // what the engine writes at the default afternoon sun
  c.step(1/60, 12, false, 0, 0);
  for (const cell of c.cellManager.cells) {
    if (cell.anvilRadiusM > maxAnv) maxAnv = cell.anvilRadiusM;
    if (cell.anvilRadiusM > 400 && firstAnv < 0) firstAnv = c.simTimeSec/60;
    stages[cell.stage] = (stages[cell.stage]||0)+1;
  }
}
const t = c.getTelemetrySnapshot();
console.log(`firstAnvil ${firstAnv.toFixed(1)}min  peakAnv ${(maxAnv/1000).toFixed(1)}km  stretch=${c.cadenceStretchFactor.toFixed(2)}`);
console.log('stages', JSON.stringify(stages));
console.log('drift', t.validation.waterConservationDriftPct.toFixed(3)+'%', 'maxRain', t.maxSurfaceRainMMHr.toFixed(1),
  'flashes', t.totalFlashes, 'tles', t.totalTLEs, 'CFL', t.validation.maxCFL.toFixed(3),
  'divRes', t.validation.massContinuityResidual.toExponential(2), 'thermoOK', t.validation.thermodynamicConsistent);
console.log('cover', (g.domainCloudCoverFraction*100).toFixed(1)+'%', 'cells', c.cellManager.cells.length, 'pools', c.cellManager.coldPools.length);
