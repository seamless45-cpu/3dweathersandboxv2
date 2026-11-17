import { AtmosphereSimulationCoordinator } from '../src/sim/atmosphereCoordinator';
const c = new AtmosphereSimulationCoordinator();
const g: any = c.grid;
let maxAnv=0, firstAnv=-1, peakRegions=0;
const stageHist: Record<string,number> = {};
for (let f = 0; f < 22000; f++) {
  c.step(1/60, 12, false, 0, 0);
  if (g.lastRegionVoxels > peakRegions) peakRegions = g.lastRegionVoxels;
  for (const cell of c.cellManager.cells) {
    if (cell.anvilRadiusM > maxAnv) maxAnv = cell.anvilRadiusM;
    if (cell.anvilRadiusM > 400 && firstAnv < 0) firstAnv = c.simTimeSec/60;
    stageHist[cell.stage] = (stageHist[cell.stage]||0)+1;
  }
  if (f % 6000 === 5999) {
    const cs=c.cellManager.cells;
    const top=Math.max(...cs.map(x=>x.cloudTopM),0), w=Math.max(...cs.map(x=>x.updraftMaxMS),0);
    const anv=Math.max(...cs.map(x=>x.anvilRadiusM),0);
    console.log(`t=${(c.simTimeSec/60).toFixed(0)}min n=${cs.length} top=${(top/1000).toFixed(1)}km anv=${(anv/1000).toFixed(1)}km w=${w.toFixed(1)} regions=${g.lastRegionVoxels} cover=${(g.domainCloudCoverFraction*100).toFixed(0)}%`);
  }
}
const tel=c.getTelemetrySnapshot();
console.log(`\nfirstAnvil ${firstAnv.toFixed(1)}min  peakAnv ${(maxAnv/1000).toFixed(1)}km  peakRegions ${peakRegions} (${(peakRegions/147456*100).toFixed(0)}%)`);
console.log('stages', JSON.stringify(stageHist));
console.log('drift', tel.validation.waterConservationDriftPct.toFixed(3)+'%', 'maxRain', tel.maxSurfaceRainMMHr.toFixed(1),
  'flashes', tel.totalFlashes, 'tles', tel.totalTLEs, 'maxE', tel.maxElectricFieldKVm.toFixed(1),
  'CFL', tel.validation.maxCFL.toFixed(3), 'divRes', tel.validation.massContinuityResidual.toExponential(2),
  'thermoOK', tel.validation.thermodynamicConsistent);
