import { AtmosphereSimulationCoordinator } from '../src/sim/atmosphereCoordinator';
function run(tag: string) {
  const c = new AtmosphereSimulationCoordinator();
  const g: any = c.grid; const m: any = c.mesoscale;
  let nan=0, checked=0, maxW=0, maxTop=0, maxV=0, maxCover=0, torn=0;
  const fields=[g.u,g.vy,g.w,g.qc,g.qi,g.qr,g.rhoQ,g.phi,g.ex,g.ey,g.ez,m.thetaPert,m.qvPert,m.pressPert,m.soilSat];
  for (let f=0; f<20000; f++) {
    c.config.solarInsolationScale=1.0; c.step(1/60,12,false,0,0);
    if (f%300===0) for (const a of fields) for (let i=0;i<a.length;i+=97){checked++; if(!Number.isFinite(a[i]))nan++;}
    for (const cell of c.cellManager.cells){const cc:any=cell; if(cc.updraftMaxMS>maxW)maxW=cc.updraftMaxMS; if(cc.cloudTopM>maxTop)maxTop=cc.cloudTopM;}
    for (const t of c.tornadoes.active) if(t.maxTangentialMS>maxV)maxV=t.maxTangentialMS;
    const cov=g.domainCloudCoverFraction||0; if(cov>maxCover)maxCover=cov;
    torn=c.tornadoes.totalFormed;
  }
  console.log(`${tag} flash ${c.lightning.totalFlashes} TLE ${c.lightning.totalTLEs} cells ${c.cellManager.cells.length} torn ${torn} cover ${(maxCover*100).toFixed(1)}% top ${(maxTop/1000).toFixed(2)}km W ${maxW.toFixed(1)} tornV ${maxV.toFixed(0)}`);
  console.log(`   CFL ${g.maxCFL.toFixed(3)} divRes ${g.maxDivergenceResidual.toExponential(2)} nan ${nan}/${checked}`);
  console.log(`   theta' ${m.maxThetaPertK.toFixed(2)}K qv' ${m.maxQvPertGKg.toFixed(2)} p'[${m.minPressPertPa.toFixed(0)},${m.maxPressPertPa.toFixed(0)}] gust x${m.maxGustFactor.toFixed(2)}`);
  console.log(`   OBS T ${c.observerTempC.toFixed(1)}C Td ${c.observerDewpointC.toFixed(1)}C RH ${c.observerRelHumidity.toFixed(0)}% p ${c.observerPressureHPa.toFixed(2)} CAPE ${c.observerLocalCape.toFixed(0)} CIN ${c.observerLocalCin.toFixed(0)} LCL ${c.observerLocalLcl.toFixed(0)}m`);
  console.log(`   rod upFlash ${c.lightning.rodUpwardFlashes} leaders ${c.lightningRod.upwardLeaders}`);
  return [c.lightning.totalFlashes,c.lightning.totalTLEs,torn,+maxW.toFixed(6),+maxV.toFixed(6),+g.maxCFL.toFixed(6),+maxCover.toFixed(6),m.maxThetaPertK.toFixed(4),c.observerTempC.toFixed(4),c.observerPressureHPa.toFixed(4),nan].join('|');
}
const a=run('RUN A'); console.log('');
const b=run('RUN B');
console.log(`\nDETERMINISTIC: ${a===b}`);
