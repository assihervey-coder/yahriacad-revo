/**
 * NEXUS PCB — Netlists de démonstration
 * Équivalent : data/projects/ (netlists .net) + BDD composants
 *
 * 3 cartes industrielles représentatives :
 *   1. NEXUS-CORE  : MCU + USB HS (ULPI) — bus parallèle 8 bits
 *   2. NEXUS-IOT   : ESP32 + capteurs + gestion batterie
 *   3. NEXUS-RF    : nRF + antenne 50Ω + réseau d'adaptation
 */
import type { Netlist } from './types'
import {
  bga, chip2Pins, comp, crystal, header1x, led0603, mcuQfn48,
  qfn, rfModule, sot223, sot23, sot23_6, soic8, usbMicro,
} from './footprints'

/* ============================ PROJET 1 : NEXUS-CORE ============================ */

const nexusCore: Netlist = {
  id: 'nexus-core',
  name: 'NEXUS-CORE v1',
  description: 'MCU Cortex-M + PHY USB 2.0 HS (ULPI 8 bits) — bus parallèle haute vitesse',
  board: { w: 60, h: 45, layers: 2 },
  components: [
    comp('U1', 'MCU-48 Cortex-M4', 'mcu', mcuQfn48(7, 0.5, 'MCU_QFN48'), 0.42, {
      OSC_IN: 'XTAL1', OSC_OUT: 'XTAL2',
      PA0: 'ULPI_D0', PA1: 'ULPI_D1', PA2: 'ULPI_D2', PA3: 'ULPI_D3',
      PA4: 'ULPI_D4', PA5: 'ULPI_D5', PA6: 'ULPI_D6', PA7: 'ULPI_D7',
      PA8: 'ULPI_CLK', PA9: 'ULPI_DIR', PA10: 'ULPI_STP', PA11: 'ULPI_NXT',
      PA12: 'USB_DP', PA13: 'USB_DM', PA14: 'SWDIO', PA15: 'SWCLK',
      PB0: 'TX1', PB1: 'RX1', PB2: 'LED_A', PB3: 'LED_B', PB4: 'NRST_MCU',
      PB8: 'VDD_3V3', PB9: 'VDD_3V3', BOOT0: 'GND', NRST: 'NRST_MCU',
      VDD1: 'VDD_3V3', VDD2: 'VDD_3V3', VSS1: 'GND', VSS2: 'GND', VSS_EP: 'GND',
      PC0: 'TX1', PC1: 'RX1',
    }, { note: 'Cerveau de la carte — horloge 8 MHz, ULPI vers PHY' }),

    comp('U2', 'USB3300 PHY USB-HS', 'interface', qfn(5, 8, 0.5, 'QFN32'), 0.28, {
      '1': 'ULPI_D0', '2': 'ULPI_D1', '3': 'ULPI_D2', '4': 'ULPI_D3',
      '5': 'ULPI_D4', '6': 'ULPI_D5', '7': 'ULPI_D6', '8': 'ULPI_D7',
      '9': 'ULPI_CLK', '10': 'ULPI_DIR', '11': 'ULPI_STP', '12': 'ULPI_NXT',
      '17': 'USB_DP', '18': 'USB_DM', '25': 'VDD_3V3', '26': 'VDD_3V3',
      '27': 'GND', '28': 'GND', 'EP': 'GND',
    }, { note: 'PHY USB 2.0 high-speed ULPI' }),

    comp('U3', 'AMS1117-3.3 LDO', 'power', sot223(), 0.65, {
      '1': 'GND', '2': 'VDD_3V3', '3': 'VDD_5V', '4': 'VDD_3V3',
    }, { note: 'Régulateur 5V→3.3V, dissipateur thermique' }),

    comp('Y1', 'Quartz 8 MHz', 'crystal', crystal(3.2, 2.5, 'XTAL_3225'), 0, {
      '1': 'XTAL1', '2': 'XTAL2',
    }),

    comp('J1', 'USB Micro-B', 'connector', usbMicro(), 0, {
      VBUS: 'VDD_5V', 'D+': 'USB_DP', 'D-': 'USB_DM', GND: 'GND', ID: 'GND',
      SH1: 'GND', SH2: 'GND',
    }, { note: 'Connecteur alimentation + USB' }),

    comp('J2', 'Header SWD', 'connector', header1x(4), 0, {
      '1': 'VDD_3V3', '2': 'SWDIO', '3': 'SWCLK', '4': 'GND',
    }, { note: 'Débogage SWD' }),

    comp('J3', 'Header GPIO 12', 'connector', header1x(12), 0, {
      '1': 'VDD_3V3', '2': 'GND', '3': 'TX1', '4': 'RX1', '5': 'PA0_E', '6': 'PA1_E',
      '7': 'PA2_E', '8': 'PA3_E', '9': 'PA4_E', '10': 'PA5_E', '11': 'PA6_E', '12': 'PA7_E',
    }, { note: 'Extension GPIO' }),

    comp('C1', '100nF découplage', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'VDD_3V3', '2': 'GND' }, { parent: 'U1' }),
    comp('C2', '100nF découplage', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'VDD_3V3', '2': 'GND' }, { parent: 'U1' }),
    comp('C3', '4.7uF bulk', 'passive', chip2Pins('C_0805', 2.0, 1.25), 0,
      { '1': 'VDD_3V3', '2': 'GND' }, { parent: 'U3' }),
    comp('C4', '100nF découplage', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'VDD_3V3', '2': 'GND' }, { parent: 'U2' }),
    comp('C5', '22uF entrée', 'passive', chip2Pins('C_0805', 2.0, 1.25), 0,
      { '1': 'VDD_5V', '2': 'GND' }, { parent: 'J1' }),
    comp('C6', '18pF quartz', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'XTAL1', '2': 'GND' }, { parent: 'Y1' }),
    comp('C7', '18pF quartz', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'XTAL2', '2': 'GND' }, { parent: 'Y1' }),

    comp('R1', '10k pull-up', 'passive', chip2Pins('R_0402', 1.0, 0.5), 0,
      { '1': 'NRST_MCU', '2': 'VDD_3V3' }),
    comp('R2', '1k LED', 'passive', chip2Pins('R_0402', 1.0, 0.5), 0,
      { '1': 'LED_A', '2': 'LED1_K' }),
    comp('R3', '1k LED', 'passive', chip2Pins('R_0402', 1.0, 0.5), 0,
      { '1': 'LED_B', '2': 'LED2_K' }),

    comp('LED1', 'LED verte', 'led', led0603(), 0.02, { '1': 'GND', '2': 'LED1_K' }),
    comp('LED2', 'LED ambre', 'led', led0603(), 0.02, { '1': 'GND', '2': 'LED2_K' }),
  ],
  nets: [
    { name: 'VDD_3V3', cls: 'power', pins: [
      { ref: 'U1', pin: 'VDD1' }, { ref: 'U1', pin: 'VDD2' }, { ref: 'U1', pin: 'PB8' }, { ref: 'U1', pin: 'PB9' },
      { ref: 'U2', pin: '25' }, { ref: 'U2', pin: '26' }, { ref: 'U3', pin: '2' }, { ref: 'U3', pin: '4' },
      { ref: 'C1', pin: '1' }, { ref: 'C2', pin: '1' }, { ref: 'C3', pin: '1' }, { ref: 'C4', pin: '1' },
      { ref: 'J2', pin: '1' }, { ref: 'J3', pin: '1' }, { ref: 'R1', pin: '2' },
    ] },
    { name: 'VDD_5V', cls: 'power', pins: [
      { ref: 'U3', pin: '3' }, { ref: 'J1', pin: 'VBUS' }, { ref: 'C5', pin: '1' },
    ] },
    { name: 'GND', cls: 'ground', pins: [
      { ref: 'U1', pin: 'VSS1' }, { ref: 'U1', pin: 'VSS2' }, { ref: 'U1', pin: 'VSS_EP' }, { ref: 'U1', pin: 'BOOT0' },
      { ref: 'U2', pin: '27' }, { ref: 'U2', pin: '28' }, { ref: 'U2', pin: 'EP' },
      { ref: 'U3', pin: '1' }, { ref: 'J1', pin: 'GND' }, { ref: 'J1', pin: 'ID' }, { ref: 'J1', pin: 'SH1' }, { ref: 'J1', pin: 'SH2' },
      { ref: 'J2', pin: '4' }, { ref: 'J3', pin: '2' },
      { ref: 'C1', pin: '2' }, { ref: 'C2', pin: '2' }, { ref: 'C3', pin: '2' }, { ref: 'C4', pin: '2' },
      { ref: 'C5', pin: '2' }, { ref: 'C6', pin: '2' }, { ref: 'C7', pin: '2' },
      { ref: 'LED1', pin: '1' }, { ref: 'LED2', pin: '1' },
    ] },
    { name: 'USB_DP', cls: 'diffpair', pins: [
      { ref: 'J1', pin: 'D+' }, { ref: 'U2', pin: '17' }, { ref: 'U1', pin: 'PA12' },
    ] },
    { name: 'USB_DM', cls: 'diffpair', pins: [
      { ref: 'J1', pin: 'D-' }, { ref: 'U2', pin: '18' }, { ref: 'U1', pin: 'PA13' },
    ] },
    { name: 'XTAL1', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'OSC_IN' }, { ref: 'Y1', pin: '1' }, { ref: 'C6', pin: '1' }] },
    { name: 'XTAL2', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'OSC_OUT' }, { ref: 'Y1', pin: '2' }, { ref: 'C7', pin: '1' }] },
    { name: 'ULPI_D0', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA0' }, { ref: 'U2', pin: '1' }] },
    { name: 'ULPI_D1', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA1' }, { ref: 'U2', pin: '2' }] },
    { name: 'ULPI_D2', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA2' }, { ref: 'U2', pin: '3' }] },
    { name: 'ULPI_D3', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA3' }, { ref: 'U2', pin: '4' }] },
    { name: 'ULPI_D4', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA4' }, { ref: 'U2', pin: '5' }] },
    { name: 'ULPI_D5', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA5' }, { ref: 'U2', pin: '6' }] },
    { name: 'ULPI_D6', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA6' }, { ref: 'U2', pin: '7' }] },
    { name: 'ULPI_D7', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA7' }, { ref: 'U2', pin: '8' }] },
    { name: 'ULPI_CLK', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA8' }, { ref: 'U2', pin: '9' }] },
    { name: 'ULPI_DIR', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA9' }, { ref: 'U2', pin: '10' }] },
    { name: 'ULPI_STP', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA10' }, { ref: 'U2', pin: '11' }] },
    { name: 'ULPI_NXT', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA11' }, { ref: 'U2', pin: '12' }] },
    { name: 'SWDIO', cls: 'signal', pins: [{ ref: 'U1', pin: 'PA14' }, { ref: 'J2', pin: '2' }] },
    { name: 'SWCLK', cls: 'signal', pins: [{ ref: 'U1', pin: 'PA15' }, { ref: 'J2', pin: '3' }] },
    { name: 'TX1', cls: 'signal', pins: [{ ref: 'U1', pin: 'PB0' }, { ref: 'U1', pin: 'PC0' }, { ref: 'J3', pin: '3' }] },
    { name: 'RX1', cls: 'signal', pins: [{ ref: 'U1', pin: 'PB1' }, { ref: 'U1', pin: 'PC1' }, { ref: 'J3', pin: '4' }] },
    { name: 'NRST_MCU', cls: 'signal', pins: [{ ref: 'U1', pin: 'NRST' }, { ref: 'U1', pin: 'PB4' }, { ref: 'R1', pin: '1' }] },
    { name: 'LED_A', cls: 'signal', pins: [{ ref: 'U1', pin: 'PB2' }, { ref: 'R2', pin: '1' }] },
    { name: 'LED_B', cls: 'signal', pins: [{ ref: 'U1', pin: 'PB3' }, { ref: 'R3', pin: '1' }] },
    { name: 'LED1_K', cls: 'signal', pins: [{ ref: 'R2', pin: '2' }, { ref: 'LED1', pin: '2' }] },
    { name: 'LED2_K', cls: 'signal', pins: [{ ref: 'R3', pin: '2' }, { ref: 'LED2', pin: '2' }] },
    { name: 'PA0_E', cls: 'signal', pins: [{ ref: 'J3', pin: '5' }] },
    { name: 'PA1_E', cls: 'signal', pins: [{ ref: 'J3', pin: '6' }] },
    { name: 'PA2_E', cls: 'signal', pins: [{ ref: 'J3', pin: '7' }] },
    { name: 'PA3_E', cls: 'signal', pins: [{ ref: 'J3', pin: '8' }] },
    { name: 'PA4_E', cls: 'signal', pins: [{ ref: 'J3', pin: '9' }] },
    { name: 'PA5_E', cls: 'signal', pins: [{ ref: 'J3', pin: '10' }] },
    { name: 'PA6_E', cls: 'signal', pins: [{ ref: 'J3', pin: '11' }] },
    { name: 'PA7_E', cls: 'signal', pins: [{ ref: 'J3', pin: '12' }] },
  ],
}

/* ============================ PROJET 2 : NEXUS-IOT ============================ */

const nexusIot: Netlist = {
  id: 'nexus-iot',
  name: 'NEXUS-IoT v2',
  description: 'Nœud IoT ESP32 + capteur BME280 + gestion batterie LiPo + chargeur TP4056',
  board: { w: 45, h: 35, layers: 2 },
  components: [
    comp('U1', 'ESP32-WROOM-32E', 'mcu', rfModule(18, 25.5,
      ['3V3', 'EN', 'IO36', 'IO39', 'IO34', 'IO35', 'IO32', 'IO33', 'IO25', 'IO26', 'IO27'],
      ['IO14', 'IO12', 'IO13', 'IO15', 'IO2', 'IO0', 'IO4', 'IO5', 'IO18', 'IO19', 'IO21'],
      ['GND1', 'GND2'],
    ), 0.8, {
      '3V3': 'VDD_3V3', EN: 'NRST_ESP', IO21: 'SDA', IO19: 'SCL',
      IO4: 'STAT_LED', IO5: 'CH_STAT', IO18: 'I2C_PWR',
      IO25: 'BAT_SENSE', IO27: 'TXD', IO14: 'RXD',
      GND1: 'GND', GND2: 'GND',
    }, { note: 'Module WiFi/BT avec keepout antenne' }),

    comp('U2', 'BME280 capteur env.', 'sensor', soic8('SOIC-8'), 0.005, {
      '1': 'GND', '2': 'SDA', '3': 'VDD_3V3', '4': 'SCL',
      '5': 'NC1', '6': 'NC2', '7': 'NC3', '8': 'VDD_3V3',
    }, { note: 'Capteur I2C température/humidité/pression' }),

    comp('U3', 'TP4056 chargeur LiPo', 'power', soic8('SOP-8'), 0.35, {
      '1': 'CH_STAT', '2': 'GND', '3': 'VBAT_CHG', '4': 'VDD_5V',
      '5': 'GND', '6': 'BAT_SENSE', '7': 'GND', '8': 'GND',
    }, { note: 'Chargeur batterie 1A' }),

    comp('U4', 'MT3608 boost 5V', 'power', sot23_6(), 0.5, {
      '1': 'SW_5V', '2': 'GND', '3': 'FB_5V', '4': 'VBAT_CHG', '5': 'SW_5V', '6': 'VBAT_CHG',
    }, { note: 'Convertisseur boost vers 5V' }),

    comp('U5', 'AMS1117-3.3', 'power', sot223(), 0.4, {
      '1': 'GND', '2': 'VDD_3V3', '3': 'SW_5V', '4': 'VDD_3V3',
    }),

    comp('J1', 'USB Micro-B', 'connector', usbMicro(), 0, {
      VBUS: 'VDD_5V', GND: 'GND', ID: 'GND', SH1: 'GND', SH2: 'GND',
    }, { note: 'USB 5V uniquement (données non utilisées)' }),

    comp('J2', 'Header I2C/Debug', 'connector', header1x(6), 0, {
      '1': 'VDD_3V3', '2': 'GND', '3': 'SDA', '4': 'SCL', '5': 'TXD', '6': 'RXD',
    }),

    comp('J3', 'Connecteur batterie', 'connector', header1x(2), 0, {
      '1': 'VBAT_CHG', '2': 'GND',
    }, { note: 'LiPo 3.7V' }),

    comp('C1', '10uF ESP32', 'passive', chip2Pins('C_0805', 2.0, 1.25), 0,
      { '1': 'VDD_3V3', '2': 'GND' }, { parent: 'U1' }),
    comp('C2', '100nF BME280', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'VDD_3V3', '2': 'GND' }, { parent: 'U2' }),
    comp('C3', '10uF entrée USB', 'passive', chip2Pins('C_0805', 2.0, 1.25), 0,
      { '1': 'VDD_5V', '2': 'GND' }, { parent: 'J1' }),
    comp('C4', '10uF sortie boost', 'passive', chip2Pins('C_0805', 2.0, 1.25), 0,
      { '1': 'SW_5V', '2': 'GND' }, { parent: 'U4' }),
    comp('R1', '100k diviseur', 'passive', chip2Pins('R_0402', 1.0, 0.5), 0,
      { '1': 'BAT_SENSE', '2': 'GND' }),
    comp('R2', '100k diviseur', 'passive', chip2Pins('R_0402', 1.0, 0.5), 0,
      { '1': 'VBAT_CHG', '2': 'BAT_SENSE' }),
    comp('R3', '10k pull-up SDA', 'passive', chip2Pins('R_0402', 1.0, 0.5), 0,
      { '1': 'SDA', '2': 'VDD_3V3' }),
    comp('R4', '10k pull-up SCL', 'passive', chip2Pins('R_0402', 1.0, 0.5), 0,
      { '1': 'SCL', '2': 'VDD_3V3' }),
    comp('R5', '1k LED', 'passive', chip2Pins('R_0402', 1.0, 0.5), 0,
      { '1': 'STAT_LED', '2': 'LED1_K' }),
    comp('LED1', 'LED statut', 'led', led0603(), 0.02, { '1': 'GND', '2': 'LED1_K' }),
  ],
  nets: [
    { name: 'VDD_3V3', cls: 'power', pins: [
      { ref: 'U1', pin: '3V3' }, { ref: 'U2', pin: '3' }, { ref: 'U2', pin: '8' },
      { ref: 'U5', pin: '2' }, { ref: 'U5', pin: '4' },
      { ref: 'C1', pin: '1' }, { ref: 'C2', pin: '1' },
      { ref: 'J2', pin: '1' }, { ref: 'R3', pin: '2' }, { ref: 'R4', pin: '2' },
    ] },
    { name: 'VDD_5V', cls: 'power', pins: [
      { ref: 'U3', pin: '4' }, { ref: 'J1', pin: 'VBUS' }, { ref: 'C3', pin: '1' },
    ] },
    { name: 'SW_5V', cls: 'power', pins: [
      { ref: 'U4', pin: '1' }, { ref: 'U4', pin: '5' }, { ref: 'U5', pin: '3' }, { ref: 'C4', pin: '1' },
    ] },
    { name: 'VBAT_CHG', cls: 'power', pins: [
      { ref: 'U3', pin: '3' }, { ref: 'U4', pin: '4' }, { ref: 'U4', pin: '6' },
      { ref: 'J3', pin: '1' }, { ref: 'R2', pin: '1' },
    ] },
    { name: 'GND', cls: 'ground', pins: [
      { ref: 'U1', pin: 'GND1' }, { ref: 'U1', pin: 'GND2' },
      { ref: 'U2', pin: '1' }, { ref: 'U3', pin: '5' }, { ref: 'U3', pin: '7' }, { ref: 'U3', pin: '8' },
      { ref: 'U4', pin: '2' }, { ref: 'U5', pin: '1' },
      { ref: 'J1', pin: 'GND' }, { ref: 'J1', pin: 'ID' }, { ref: 'J1', pin: 'SH1' }, { ref: 'J1', pin: 'SH2' },
      { ref: 'J2', pin: '2' }, { ref: 'J3', pin: '2' },
      { ref: 'C1', pin: '2' }, { ref: 'C2', pin: '2' }, { ref: 'C3', pin: '2' }, { ref: 'C4', pin: '2' },
      { ref: 'R1', pin: '2' }, { ref: 'LED1', pin: '1' },
    ] },
    { name: 'SDA', cls: 'signal', pins: [
      { ref: 'U1', pin: 'IO21' }, { ref: 'U2', pin: '2' }, { ref: 'J2', pin: '3' }, { ref: 'R3', pin: '1' },
    ] },
    { name: 'SCL', cls: 'signal', pins: [
      { ref: 'U1', pin: 'IO19' }, { ref: 'U2', pin: '4' }, { ref: 'J2', pin: '4' }, { ref: 'R4', pin: '1' },
    ] },
    { name: 'TXD', cls: 'signal', pins: [{ ref: 'U1', pin: 'IO27' }, { ref: 'J2', pin: '5' }] },
    { name: 'RXD', cls: 'signal', pins: [{ ref: 'U1', pin: 'IO14' }, { ref: 'J2', pin: '6' }] },
    { name: 'BAT_SENSE', cls: 'analog', pins: [{ ref: 'U1', pin: 'IO25' }, { ref: 'U3', pin: '6' }, { ref: 'R1', pin: '1' }] },
    { name: 'CH_STAT', cls: 'signal', pins: [{ ref: 'U1', pin: 'IO5' }, { ref: 'U3', pin: '1' }] },
    { name: 'STAT_LED', cls: 'signal', pins: [{ ref: 'U1', pin: 'IO4' }, { ref: 'R5', pin: '1' }] },
    { name: 'LED1_K', cls: 'signal', pins: [{ ref: 'R5', pin: '2' }, { ref: 'LED1', pin: '2' }] },
    { name: 'NRST_ESP', cls: 'signal', pins: [{ ref: 'U1', pin: 'EN' }] },
    { name: 'I2C_PWR', cls: 'signal', pins: [{ ref: 'U1', pin: 'IO18' }] },
  ],
}

/* ============================ PROJET 3 : NEXUS-RF ============================ */

const nexusRf: Netlist = {
  id: 'nexus-rf',
  name: 'NEXUS-RF v3',
  description: 'nRF52840 + antenne 50Ω + réseau d’adaptation π — RF strict',
  board: { w: 50, h: 35, layers: 2 },
  components: [
    comp('U1', 'nRF52840-class', 'mcu', mcuQfn48(7, 0.5, 'MCU_QFN48'), 0.15, {
      OSC_IN: 'XTAL_32M_1', OSC_OUT: 'XTAL_32M_2',
      PA0: 'SPI_SCK', PA1: 'SPI_MOSI', PA2: 'SPI_MISO', PA3: 'FLASH_CS',
      PA4: 'RF_OUT', PA5: 'DEC1', PA6: 'DEC2', PA7: 'SWDIO', PA8: 'SWCLK',
      PA9: 'LED_A', PA12: 'USB_DP', PA13: 'USB_DM', PA15: 'VDC_DC',
      PB0: 'VDD_nRF', PB1: 'VDD_nRF', PB8: 'VDD_nRF', PB9: 'VDD_nRF',
      BOOT0: 'GND', NRST: 'NRST_RF', VDD1: 'VDD_nRF', VDD2: 'VDD_nRF',
      VSS1: 'GND', VSS2: 'GND', VSS_EP: 'GND',
      PC0: 'XTAL_32M_1', PC1: 'XTAL_32M_2',
    }, { note: 'Radio BLE 2.4 GHz' }),

    comp('U2', 'Flash MX25R SPI', 'memory', soic8(), 0.01, {
      '1': 'FLASH_CS', '2': 'SPI_MISO', '3': 'GND', '4': 'SPI_MOSI',
      '5': 'VDD_nRF', '6': 'SPI_SCK', '7': 'GND', '8': 'VDD_nRF',
    }, { note: 'Mémoire flash QSPI' }),

    comp('U3', 'LDO 3.3V faible bruit', 'power', sot223(), 0.3, {
      '1': 'GND', '2': 'VDD_nRF', '3': 'VDD_5V', '4': 'VDD_nRF',
    }),

    comp('ANT1', 'Antenne PCB 2.4GHz', 'rf', chip2Pins('ANT_50R', 6, 2), 0,
      { '1': 'RF_FEED', '2': 'NC_ANT' }, { note: 'Zone réservée antenne — aucun cuivre' }),

    comp('L1', '3.9nH adapt.', 'passive', chip2Pins('L_0402', 1.0, 0.5), 0,
      { '1': 'RF_OUT', '2': 'RF_FEED' }, { parent: 'U1' }),
    comp('C6', '1.5pF adapt.', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'RF_FEED', '2': 'GND' }, { parent: 'ANT1' }),
    comp('C7', '1pF adapt.', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'RF_OUT', '2': 'GND' }, { parent: 'U1' }),

    comp('Y1', 'Quartz 32 MHz', 'crystal', crystal(3.2, 2.5, 'XTAL_3225'), 0,
      { '1': 'XTAL_32M_1', '2': 'XTAL_32M_2' }),

    comp('J1', 'Header SWD', 'connector', header1x(4), 0, {
      '1': 'VDD_nRF', '2': 'SWDIO', '3': 'SWCLK', '4': 'GND',
    }),

    comp('C1', '100nF découplage', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'VDD_nRF', '2': 'GND' }, { parent: 'U1' }),
    comp('C2', '100nF découplage', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'VDD_nRF', '2': 'GND' }, { parent: 'U2' }),
    comp('C3', '4.7uF bulk', 'passive', chip2Pins('C_0805', 2.0, 1.25), 0,
      { '1': 'VDD_nRF', '2': 'GND' }, { parent: 'U3' }),
    comp('C4', '100nF DEC1', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'DEC1', '2': 'GND' }, { parent: 'U1' }),
    comp('C5', '100nF DEC2', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'DEC2', '2': 'GND' }, { parent: 'U1' }),
    comp('C8', '18pF quartz', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'XTAL_32M_1', '2': 'GND' }, { parent: 'Y1' }),
    comp('C9', '18pF quartz', 'passive', chip2Pins('C_0402', 1.0, 0.5), 0,
      { '1': 'XTAL_32M_2', '2': 'GND' }, { parent: 'Y1' }),

    comp('R1', '10k pull-up CS', 'passive', chip2Pins('R_0402', 1.0, 0.5), 0,
      { '1': 'FLASH_CS', '2': 'VDD_nRF' }),
    comp('LED1', 'LED statut', 'led', led0603(), 0.02, { '1': 'GND', '2': 'LED1_K' }),
    comp('R2', '1k LED', 'passive', chip2Pins('R_0402', 1.0, 0.5), 0,
      { '1': 'LED_A', '2': 'LED1_K' }),
  ],
  nets: [
    { name: 'VDD_nRF', cls: 'power', pins: [
      { ref: 'U1', pin: 'PB0' }, { ref: 'U1', pin: 'PB1' }, { ref: 'U1', pin: 'PB8' }, { ref: 'U1', pin: 'PB9' },
      { ref: 'U1', pin: 'VDD1' }, { ref: 'U1', pin: 'VDD2' }, { ref: 'U1', pin: 'PA15' },
      { ref: 'U2', pin: '5' }, { ref: 'U2', pin: '8' }, { ref: 'U3', pin: '2' }, { ref: 'U3', pin: '4' },
      { ref: 'C1', pin: '1' }, { ref: 'C2', pin: '1' }, { ref: 'C3', pin: '1' }, { ref: 'J1', pin: '1' }, { ref: 'R1', pin: '2' },
    ] },
    { name: 'VDD_5V', cls: 'power', pins: [{ ref: 'U3', pin: '3' }] },
    { name: 'GND', cls: 'ground', pins: [
      { ref: 'U1', pin: 'VSS1' }, { ref: 'U1', pin: 'VSS2' }, { ref: 'U1', pin: 'VSS_EP' }, { ref: 'U1', pin: 'BOOT0' },
      { ref: 'U2', pin: '3' }, { ref: 'U2', pin: '7' }, { ref: 'U3', pin: '1' },
      { ref: 'C1', pin: '2' }, { ref: 'C2', pin: '2' }, { ref: 'C3', pin: '2' }, { ref: 'C4', pin: '2' },
      { ref: 'C5', pin: '2' }, { ref: 'C6', pin: '2' }, { ref: 'C7', pin: '2' }, { ref: 'C8', pin: '2' }, { ref: 'C9', pin: '2' },
      { ref: 'J1', pin: '4' }, { ref: 'LED1', pin: '1' },
    ] },
    { name: 'RF_OUT', cls: 'rf', pins: [{ ref: 'U1', pin: 'PA4' }, { ref: 'L1', pin: '1' }, { ref: 'C7', pin: '1' }] },
    { name: 'RF_FEED', cls: 'rf', pins: [{ ref: 'L1', pin: '2' }, { ref: 'ANT1', pin: '1' }, { ref: 'C6', pin: '1' }] },
    { name: 'NC_ANT', cls: 'signal', pins: [{ ref: 'ANT1', pin: '2' }] },
    { name: 'XTAL_32M_1', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'OSC_IN' }, { ref: 'U1', pin: 'PC0' }, { ref: 'Y1', pin: '1' }, { ref: 'C8', pin: '1' }] },
    { name: 'XTAL_32M_2', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'OSC_OUT' }, { ref: 'U1', pin: 'PC1' }, { ref: 'Y1', pin: '2' }, { ref: 'C9', pin: '1' }] },
    { name: 'SPI_SCK', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA0' }, { ref: 'U2', pin: '6' }] },
    { name: 'SPI_MOSI', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA1' }, { ref: 'U2', pin: '4' }] },
    { name: 'SPI_MISO', cls: 'highspeed', pins: [{ ref: 'U1', pin: 'PA2' }, { ref: 'U2', pin: '2' }] },
    { name: 'FLASH_CS', cls: 'signal', pins: [{ ref: 'U1', pin: 'PA3' }, { ref: 'U2', pin: '1' }, { ref: 'R1', pin: '1' }] },
    { name: 'DEC1', cls: 'analog', pins: [{ ref: 'U1', pin: 'PA5' }, { ref: 'C4', pin: '1' }] },
    { name: 'DEC2', cls: 'analog', pins: [{ ref: 'U1', pin: 'PA6' }, { ref: 'C5', pin: '1' }] },
    { name: 'SWDIO', cls: 'signal', pins: [{ ref: 'U1', pin: 'PA7' }, { ref: 'J1', pin: '2' }] },
    { name: 'SWCLK', cls: 'signal', pins: [{ ref: 'U1', pin: 'PA8' }, { ref: 'J1', pin: '3' }] },
    { name: 'USB_DP', cls: 'diffpair', pins: [{ ref: 'U1', pin: 'PA12' }] },
    { name: 'USB_DM', cls: 'diffpair', pins: [{ ref: 'U1', pin: 'PA13' }] },
    { name: 'NRST_RF', cls: 'signal', pins: [{ ref: 'U1', pin: 'NRST' }] },
    { name: 'LED_A', cls: 'signal', pins: [{ ref: 'U1', pin: 'PA9' }, { ref: 'R2', pin: '1' }] },
    { name: 'LED1_K', cls: 'signal', pins: [{ ref: 'R2', pin: '2' }, { ref: 'LED1', pin: '2' }] },
    { name: 'VDC_DC', cls: 'signal', pins: [{ ref: 'U1', pin: 'PA15' }] },
  ],
}

/** Registre des projets disponibles (data/projects/) */
export const NETLISTS: Netlist[] = [nexusCore, nexusIot, nexusRf]

export function getNetlist(id: string): Netlist {
  return NETLISTS.find((n) => n.id === id) ?? NETLISTS[0]
}
