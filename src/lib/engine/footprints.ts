/**
 * NEXUS PCB — Bibliothèque d'empreintes (footprints)
 * Équivalent : data/component_library/ + services/parser/component_lib_matcher/
 *
 * Générateurs paramétriques d'empreintes industrielles courantes.
 * Toutes les cotes en mm, origine = centre du boîtier.
 */
import type { Component, ComponentCategory, Footprint, Pad } from './types'

const pad = (pin: string, lx: number, ly: number, w: number, h: number): Pad =>
  ({ pin, lx, ly, w, h })

/** Boîtier CMS 2 broches (0402 / 0603 / 0805 / 1206) */
export function chip2Pins(name: string, w: number, h: number): Footprint {
  const padW = w * 0.45, padH = h * 0.9
  return {
    name, w, h,
    pads: [pad('1', -w / 2 + padW / 2, 0, padW, padH), pad('2', w / 2 - padW / 2, 0, padW, padH)],
  }
}

/** SOIC-8 : 4 broches par côté, pas 1.27 mm */
export function soic8(name = 'SOIC-8'): Footprint {
  const pads: Pad[] = []
  for (let i = 0; i < 4; i++) {
    pads.push(pad(String(i + 1), -2.7, -1.905 + i * 1.27, 1.6, 0.6))
    pads.push(pad(String(8 - i), 2.7, -1.905 + i * 1.27, 1.6, 0.6))
  }
  return { name, w: 6, h: 5, pads }
}

/** SOIC-16 : 8 broches par côté, pas 1.27 mm */
export function soic16(name = 'SOIC-16'): Footprint {
  const pads: Pad[] = []
  for (let i = 0; i < 8; i++) {
    pads.push(pad(String(i + 1), -3.6, -4.445 + i * 1.27, 1.6, 0.6))
    pads.push(pad(String(16 - i), 3.6, -4.445 + i * 1.27, 1.6, 0.6))
  }
  return { name, w: 8, h: 7.5, pads }
}

/** QFN à n broches par côté + pad thermique central */
export function qfn(side: number, perSide: number, pitch: number, name: string): Footprint {
  const pads: Pad[] = []
  const span = ((perSide - 1) * pitch) / 2
  for (let i = 0; i < perSide; i++) {
    const off = -span + i * pitch
    pads.push(pad(String(i + 1), -side / 2 - 0.15, off, 1.2, 0.28))          // gauche 1..n
    pads.push(pad(String(perSide + i + 1), off, side / 2 + 0.15, 0.28, 1.2)) // bas
    pads.push(pad(String(2 * perSide + i + 1), side / 2 + 0.15, -off, 1.2, 0.28))   // droite
    pads.push(pad(String(3 * perSide + i + 1), -off, -side / 2 - 0.15, 0.28, 1.2))  // haut
  }
  pads.push(pad('EP', 0, 0, side * 0.55, side * 0.55))
  return { name, w: side + 1.4, h: side + 1.4, pads }
}

/** TQFP/LQFP carré, n broches par côté */
export function tqfp(side: number, perSide: number, pitch: number, name: string): Footprint {
  const pads: Pad[] = []
  const span = ((perSide - 1) * pitch) / 2
  for (let i = 0; i < perSide; i++) {
    const off = -span + i * pitch
    pads.push(pad(String(i + 1), -side / 2 - 0.85, off, 2.0, 0.35))
    pads.push(pad(String(perSide + i + 1), off, side / 2 + 0.85, 0.35, 2.0))
    pads.push(pad(String(2 * perSide + i + 1), side / 2 + 0.85, -off, 2.0, 0.35))
    pads.push(pad(String(3 * perSide + i + 1), -off, -side / 2 - 0.85, 0.35, 2.0))
  }
  return { name, w: side + 2.6, h: side + 2.6, pads }
}

/** BGA simplifié : grille pitch × pitch */
export function bga(rows: number, cols: number, pitch: number, name: string): Footprint {
  const pads: Pad[] = []
  const letters = 'ABCDEFGHJKLMNPRTUVW'
  const spanX = ((cols - 1) * pitch) / 2
  const spanY = ((rows - 1) * pitch) / 2
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      pads.push(pad(`${letters[r]}${c + 1}`, -spanX + c * pitch, -spanY + r * pitch, pitch * 0.5, pitch * 0.5))
  return { name, w: cols * pitch + 1.5, h: rows * pitch + 1.5, pads }
}

/** SOT-23 (3 broches) */
export function sot23(name = 'SOT-23'): Footprint {
  return {
    name, w: 3, h: 2.9,
    pads: [pad('1', -0.95, 1.1, 0.6, 1.0), pad('2', 0.95, 1.1, 0.6, 1.0), pad('3', 0, -1.1, 0.6, 1.0)],
  }
}

/** SOT-223 (régulateur) */
export function sot223(name = 'SOT-223'): Footprint {
  return {
    name, w: 7, h: 7,
    pads: [
      pad('1', -2.3, -3.4, 1.2, 2.0), pad('2', 0, -3.4, 1.2, 2.0), pad('3', 2.3, -3.4, 1.2, 2.0),
      pad('4', 0, 3.4, 3.6, 2.4),
    ],
  }
}

/** Header à 1 rangée, pas 2.54 mm */
export function header1x(n: number): Footprint {
  const pads: Pad[] = []
  const span = ((n - 1) * 2.54) / 2
  for (let i = 0; i < n; i++) pads.push(pad(String(i + 1), 0, span - i * 2.54, 1.7, 1.7))
  return { name: `Header1x${n}_2.54`, w: 3.2, h: n * 2.54 + 1, pads }
}

/** USB micro-B vertical */
export function usbMicro(): Footprint {
  return {
    name: 'USB_MicroB', w: 8, h: 5.6,
    pads: [
      pad('VBUS', -3.0, 2.4, 1.6, 1.0), pad('D-', -1.5, 2.4, 0.6, 1.0),
      pad('D+', 0, 2.4, 0.6, 1.0), pad('ID', 1.5, 2.4, 0.6, 1.0), pad('GND', 3.0, 2.4, 1.6, 1.0),
      pad('SH1', -3.8, -1.4, 1.4, 2.0), pad('SH2', 3.8, -1.4, 1.4, 2.0),
    ],
  }
}

/**
 * QFN "MCU générique" avec nomenclature sémantique des broches
 * (PA0..PA15, PB0..PB15, VDD, VSS + pad thermique EP = VSS)
 * Réutilisable pour tout MCU 48 broches (STM32-class, nRF-class...)
 */
export function mcuQfn48(side = 7, pitch = 0.5, name = 'MCU_QFN48'): Footprint {
  const perSide = 12
  const pads: Pad[] = []
  const span = ((perSide - 1) * pitch) / 2
  const left = ['PA0', 'PA1', 'PA2', 'PA3', 'PA4', 'PA5', 'PA6', 'PA7', 'PA8', 'PA9', 'PA10', 'PA11']
  const bottom = ['PA12', 'PA13', 'PA14', 'PA15', 'PB0', 'PB1', 'PB2', 'PB3', 'PB4', 'PB5', 'PB6', 'PB7']
  const right = ['PB8', 'PB9', 'PB10', 'PB11', 'PB12', 'PB13', 'PB14', 'PB15', 'BOOT0', 'NRST', 'VDD1', 'VDD2']
  const top = ['VSS1', 'VSS2', 'OSC_IN', 'OSC_OUT', 'PC0', 'PC1', 'PC2', 'PC3', 'PC4', 'PC5', 'PC6', 'PC7']
  left.forEach((p, i) => pads.push(pad(p, -side / 2 - 0.25, span - i * pitch, 1.1, 0.25)))
  bottom.forEach((p, i) => pads.push(pad(p, -span + i * pitch, side / 2 + 0.25, 0.25, 1.1)))
  right.forEach((p, i) => pads.push(pad(p, side / 2 + 0.25, span - i * pitch, 1.1, 0.25)))
  top.forEach((p, i) => pads.push(pad(p, -span + i * pitch, -side / 2 - 0.25, 0.25, 1.1)))
  pads.push(pad('VSS_EP', 0, 0, side * 0.55, side * 0.55))
  return { name, w: side + 1.6, h: side + 1.6, pads }
}

/** SOT-23-6 (conv DC-DC, buffered sensors...) */
export function sot23_6(name = 'SOT-23-6'): Footprint {
  return {
    name, w: 3, h: 3,
    pads: [
      pad('1', -0.95, 0.95, 0.55, 0.9), pad('2', 0, 0.95, 0.55, 0.9), pad('3', 0.95, 0.95, 0.55, 0.9),
      pad('4', 0.95, -0.95, 0.55, 0.9), pad('5', 0, -0.95, 0.55, 0.9), pad('6', -0.95, -0.95, 0.55, 0.9),
    ],
  }
}

/** Module radio avec keepout (ESP32-WROOM, nRF module...)
 *  leftPins / rightPins : rangées latérales, bottomPins : rangée inférieure */
export function rfModule(w: number, h: number, leftPins: string[], rightPins: string[], bottomPins: string[] = []): Footprint {
  const pads: Pad[] = []
  const stepL = Math.min(2.0, (h - 6) / Math.max(leftPins.length - 1, 1))
  const spanL = (stepL * (leftPins.length - 1)) / 2
  leftPins.forEach((p, i) => pads.push(pad(p, -w / 2 + 0.8, spanL - i * stepL, 1.3, 0.8)))
  const stepR = Math.min(2.0, (h - 6) / Math.max(rightPins.length - 1, 1))
  const spanR = (stepR * (rightPins.length - 1)) / 2
  rightPins.forEach((p, i) => pads.push(pad(p, w / 2 - 0.8, -spanR + i * stepR, 1.3, 0.8)))
  const stepB = Math.min(2.0, (w - 8) / Math.max(bottomPins.length - 1, 1))
  const spanB = (stepB * (bottomPins.length - 1)) / 2
  bottomPins.forEach((p, i) => pads.push(pad(p, -spanB + i * stepB, -h / 2 + 0.8, 0.8, 1.3)))
  return { name: 'RF_Module', w, h, pads }
}

/** Quartz HC-49 / CMS 3225 */
export function crystal(w: number, h: number, name: string): Footprint {
  return {
    name, w, h,
    pads: [pad('1', -(w / 2 - w * 0.2), 0, w * 0.35, h * 0.8), pad('2', w / 2 - w * 0.2, 0, w * 0.35, h * 0.8)],
  }
}

/** LED 0603 */
export const led0603 = (): Footprint => chip2Pins('LED_0603', 1.8, 1.0)

/** Fabrique rapide d'un composant */
export function comp(
  ref: string, value: string, category: ComponentCategory,
  footprint: Footprint, power: number,
  pins: Record<string, string>,
  opts?: { parent?: string; note?: string },
): Component {
  return { ref, value, category, footprint, power, pins, ...opts }
}
