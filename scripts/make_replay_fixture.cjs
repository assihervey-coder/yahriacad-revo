/** Génère une session nexus-replay v1 de test pour l'import P1.4. */
const fs = require('fs')

const events = []
const N_NETS = 8
for (let i = 0; i < N_NETS; i++) {
  const net = `IMP${i}`
  for (let s = 0; s < 6; s++) {
    events.push({
      k: 'trace',
      ev: {
        type: 'segment',
        net,
        segment: { net, pts: [{ x: 5 + s * 3, y: 5 + i * 3 }, { x: 8 + s * 3, y: 7 + i * 3 }], layer: 0, width: 0.25 },
      },
    })
  }
  events.push({ k: 'trace', ev: { type: 'via', net, via: { net, x: 8 + i, y: 7 + i * 3, drill: 0.3, diameter: 0.6 } } })
  events.push({ k: 'progress', p: { done: i + 1, total: N_NETS, net, ok: true } })
}
events.push({ k: 'phase', phase: 'via-min' })
events.push({ k: 'phase', phase: 'tune' })

const data = {
  format: 'nexus-replay',
  version: 1,
  exportedAt: new Date().toISOString(),
  project: { id: 'nexus-core', name: 'NEXUS-CORE v1', board: { w: 60, h: 45 } },
  stats: { total: events.length, baseCompactee: 0, bruts: events.length, traces: 0 },
  base: { consumed: 0, routes: [], traces: 0, netsDone: 0, netsTotal: 0, currentNet: '—', phase: 'greedy' },
  events,
}
fs.writeFileSync('/tmp/nexus-replay-test.json', JSON.stringify(data))
console.log('events:', events.length)
