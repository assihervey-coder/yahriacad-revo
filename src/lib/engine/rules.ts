/**
 * NEXUS PCB — Règles de conception
 * Équivalent : data/manufacturing_partners/pcbway_rules.json + jlcpcb_rules.json
 *
 * Règles usine standard 2 couches (process HASL, tolérances classiques).
 * La piste RF 2,8 mm sur FR4 1,6 mm ≈ 50 Ω (vérifié par simulator/signal_integrity).
 */
import type { DesignRules } from './types'

export const DEFAULT_RULES: DesignRules = {
  minTraceWidth: 0.2,
  clearance: 0.2,
  minDrill: 0.3,
  edgeClearance: 0.5,
  widths: {
    signal: 0.25,
    power: 0.6,
    ground: 0.5,
    highspeed: 0.3,
    diffpair: 0.25,
    analog: 0.3,
    rf: 2.8,
  },
}
