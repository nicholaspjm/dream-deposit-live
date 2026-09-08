#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Dream Deposit — thermal printer bridge
//   version 1.9.12 (notes -> "in a world..." gap: 64 -> 32 dots)
//
// A tiny local HTTP server the site talks to. It turns a deposited
// dream into an ESC/POS receipt and sends it to a thermal printer.
//
//   node server.js --target 192.168.1.50        network printer (port 9100)
//   node server.js --target 192.168.1.50:9100   network printer, explicit port
//   node server.js --target COM3                USB/serial printer on Windows
//   node server.js --target "\\\\PC\\Receipt"   Windows shared printer (raw copy)
//   node server.js --target console             dry-run: print to the terminal
//
// Options:  --port 7788   HTTP port the site posts to (default 7788)
//           --spacing 32  dots per line (raise it if gaps print too tight)
//           --width 32    characters per line (32 = 58mm, 48 = 80mm paper)
//
// Then open the site with  ?printer=1  on the installation machine:
//   https://…/dream-deposit-live/?printer=1
//
// Zero dependencies. No data is stored — dreams pass straight through.
// ─────────────────────────────────────────────────────────────

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

// ─── config ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

let TARGET = getArg('target', 'console')
const HTTP_PORT = Number(getArg('port', 7788))
// Bumped whenever this file changes. The setup page reads the copy it
// serves and compares, so people can tell if the one they downloaded
// has fallen behind without having to diff anything.
const VERSION = '1.9.12'

const WIDTH = Number(getArg('width', 32))
// ESC @ resets line spacing to whatever the printer was built with, and
// some ship with it near zero to save paper, which collapses every gap.
// So we state it rather than inherit it, and gaps are fed in dots.
const LINE = Math.max(1, Math.min(255, Number(getArg('spacing', 32))))
const NO_ART = process.argv.includes('--nologo')
// how long to pause mid-receipt right after each raster image — see
// PAUSE_MARKER below for why that pause exists at all. 400ms wasn't
// enough: printing an image is much slower than printing text on cheap
// thermal printers (the head heats/cools per dot row), so the printer
// was often still physically outputting the image when the next command
// — even just a feed — arrived and got dropped. 1800ms gives it real
// room to finish before anything else is sent.
const PAUSE_MS = Math.max(0, Number(getArg('pause', 1800)))

// Written into the receipt bytes right after every raster image. Cheap
// thermal printers can drop or garble whatever arrives immediately after
// they finish printing an image — even a plain feed command, not just
// another image — because the printer is still physically busy outputting
// it; blank lines and feeds placed right after an image kept vanishing on
// real hardware no matter how many we sent. This marker lets the printing
// code (further down) find that spot and insert a real pause before
// sending anything else. Bytes 1-8 never occur together in genuine
// ESC/POS output or in dream text (which is filtered down to printable
// ASCII before it reaches here), so this can't collide with anything real.
// Only the local Windows spooler path (sendRawToLocalPrinterWindows)
// currently acts on this — see the note in the \\host\share branch below
// for why the other transports just pass it through untouched.
const PAUSE_MARKER = String.fromCharCode(1, 2, 3, 4, 5, 6, 7, 8)

// ─── ESC/POS receipt ─────────────────────────────────────────

const ESC = '\x1b'
const GS = '\x1d'

// nabii's mark, a note divider and a few sleepy cats, pre-rendered to
// ESC/POS raster so the bridge stays dependency free. These glyphs have
// no ASCII equivalent and CP437 maps the note characters onto control
// codes, so they have to be pictures. Regenerate only if the art
// changes; --nologo falls back to plain text.
const NOTE_RASTER = 'HXYwAC4AGQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAAAcAAAAAAAAAAAAAAAPAAAcAAAAAAAAAAAAAAAPAAAcAAAAB4AAAAAAAAAAH4B4PgAAB4AAAAAAAAAAH4B4PgAAB4AAAAAAAAAAH4B4PgAAAA+AAAAAAAAAABmA+GMAAA+AAAAAAAAAABmA+GMAAA+AAAAAAAAAABmA+GMAAAAN8AAAADAAAAAPAN9jAAAN8AAAADAAAAAPAN9jAAAN8AAAADAAAAAPAN9jAAAADPAAAAA4AAAABgDPPgAADPAAAAA4AAAABgDPPgAADPAAAAA4AAAABgDPPgAAAAwwAAAAOAAAAAAAwxwAAAwwAAAAOAAAAAAAwxwAAAwwAAAAOAAAAAAAwxwAAAAMMAAAADYAAAAAAPsAAAAMMAAAADYAAAAAAPsAAAAMMAAAADYAAAAAAPsAAAAADDAgAAA2AAAAAAD/AAAADDAgAAA2AAAAAAD/AAAADDAgAAA2AAAAAAD/AAAAAAwwMAAANgAAAAAA3wAAAAwwMAAANgAAAAAA3wAAAAwwMAAANgAAAAAA3wAAAAAMMf4AADAAAAAAAMMAAAAMMf4AADAAAAAAAMMAAAAMMf4AADAAAAAAAMMAAAAAPDH8AAAwAAAAAAPDAAAAPDH8AAAwAAAAAAPDAAAAPDH8AAAwAAAAAAPDAAAAAHww+AAAMAAAAAAHwwAAAHww+AAAMAAAAAAHwwAAAHww+AAAMAAAAAAHwwAAAAD8MNgcADAAAMAAD8MAAAD8MNgcADAAAMAAD8MAAAD8MNgcADAAAMAAD8MAAAAA/PBIPgHwAADAAA/PAAAA/PBIPgHwAADAAA/PAAAA/PBIPgHwAADAAA/PAAAAAPnwAGMB8AAAwAAPnwAAAPnwAGMB8AAAwAAPnwAAAPnwAGMB8AAAwAAPnwAAAAAD8ABjB/AAB/gAAD8AAPAD8ABjB/AAB/gAAD8AAPAD8ABjB/AAB/gAAD8AAPAAA/AAPgfgAAP4AAA/AADwA/AAPgfgAAP4AAA/AADwA/AAPgfgAAP4AAA/AADwAAPgABwHwAAAwAAAPgAA8APgABwHwAAAwAAAPgAA8APgABwHwAAAwAAAPgAA8AAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const LOGO_RASTER = 'HXYwAB4AhwAAAAAAP//4AAAAAAAAAAAAAAAAAAAAAB//+AAAAAAAAAAD////wAAAAAAAAAAAAAAAAAAAA////8AAAAAAAAAf////+AAAAAAAAAAAAAAAAAAAH/////gAAAAAAAD//////wAAAAAAAAAAAAAAAAAA//////8AAAAAAAP//////8AAAAAAAAAAAAAAAAAD///////AAAAAAAf/4AH///AAAAAAAAAAAAAAAAAP//+AB//gAAAAAB/+AAA///wAAAAAAAAAAAAAAAA///wAAH/4AAAAAD/wAAAP//4AAAAAAAAAAAAAAAB//+AAAB/8AAAAAP/AAAAD//+AAAAAAAAAAAAAAAH//8AAAAP/AAAAAf8AAAAA///AAAAAAAAAAAAAAAP//wAAAAH/gAAAA/4AAAAAf//gAAAAAAAAAAAAAAf//gAAAAB/wAAAB/wAAAAAP//wAAAAAAAAAAAAAA///AAAAAA/4AAAD/AAAAAAH//4AAAAAAAAAAAAAB//+AAAAAAP8AAAH+AAAAAAD//8AAAAAAAAAAAAAD//8AAAAAAH+AAAP8AAAAAAB//+AAAAAAAAAAAAAH//4AAAAAAD/AAAf4AAAAAAA///AAAA/AAAPgAAAP//wAAAAAAB/gAAfwAAAAAAA///gAAD/4AB/8AAAf//wAAAAAAA/gAA/wAAAAAAAf//wAAH/8AD/+AAA///gAAAAAAA/wAB/gAAAAAAAf//wAAP/+AH//AAA///gAAAAAAAf4AB/AAAAAAAAP//4AAP/+AP//AAB///AAAAAAAAP4AB/AAAAAAAAP//8AAf//AP//gAD///AAAAAAAAP8AD/AAAAAAAAH//8AA///AP//gAD//+AAAAAAAAP8AD/AAAAAAAAH//+AA///AP//wAH//+AAAAAAAAP8AH/AAAAAAAAH//+AA///gP//wAH//+AAAAAAAAP+AH/AAAAAAAAD///AA///gP//wAP//8AAAAAAAAP+AH/AAAAAAAAD///AA///gP//wAP//8AAAAAAAAP+AH/gAAAAAAAD///gA///AP//wAf//8AAAAAAAAf+AP/4AAAAAAAD///gAf//AP//gAf//8AAAAAAAB//AP///gAAAAAB///gAf//AP//gAf//4AAAAAAf///AP////gAAAAB///wAP/+AH//AA///4AAAAAf////AP////8AAAAB///wAH/8AD/+AA///4AAAAD/////AP////+AAAAB///wAD/4AB/8AA///4AAAAH/////AP/////AAAAB///4AB/wAA/4AB///4AAAAP/////AP/////gAAAB///4AAAAAAAAAB///4AAAAf/////AP/////gAAAB///4AAAAAAAAAB///4AAAAf/////AP/////wAAAA///4AAAAAAAAAB///wAAAA//////AP/////wAAAA///4AAAAAAAAAB///wAAAA//////AP/////wAAAA///8AAAAAAAAAD///wAAAA//////AH/////wAAAA///8AAAAAAAAAD///wAAAA//////AH/////wAAAA///8AAAAAAAAAD///wAAAA/////+AH/////wAAAA///8AAAAAAAAAD///wAAAA/////+AH/////wAAAA///8AAAAAAAAAD///wAAAA/////+AD/////wAAAA///8AAAAAAAAAD///wAAAA/////8AD/////gAAAA///8AAAAAAAAAD///wAAAAf////8AB/////gAAAA///8AAAAAAAAAD///wAAAAf////4AA/////AAAAA///8AAAAAAAAAD///wAAAAP////wAAf///+AAAAA///8AAAAAAAAAD///wAAAAH////gAAP///8AAAAB///8AAAAAAAAAD///4AAAAD////AAAH///4AAAAB///8AAAAAAAAAD///4AAAAB///+AAAB///gAAAAB///8AAAAAAAAAD///4AAAAAf//4AAAAf/+AAAAAB///8AAAAAAAAAD///4AAAAAH//gAAAAAfAAAAAAB///8AAf4AB/gAD///4AAAAAAHgAAAAAAAAAAAAAB///4AB/8AD/4AB///4AAAAAAAAAAAAAAAAAAAAAB///4AD/+AH/8AB///4AAAAAAAAAAAAAAAAAAAAAD///4AH//AP/+AB///8AAAAAAAAAAAAAAAAAAAAAD///4AP//gf//AB///8AAAAAAAAAAAAAAAAAAAAAD///4AP//gf//AB///8AAAAAAAAAAAAAAAAAAAAAD///wAP//w///AA///8AAAAAAAAAAAAAAAAAAAAAH///wAf//w///AA///+AAAAAAAAAAAAAAAAAAAAAH///wAf//w///gA///+AAAAAAAAAAAAAAAAAAAAAH///gAf//w///gAf//+AAAAAAAAAAAAAAAAAAAAAH///gAf//w///gAf//+AAAAAAAAAAAAAAAAAAAAAP///gAP//gf//AAf///AAAAAAAAAAAAAAAAAAAAAP///AAP//gf//AAP///AAAAAAAAAAAAAAAAAAAAAP///AAH//gf/+AAP///AAAAAAAAAAAAAAAAAAAAAf//+AAH//AP/+AAH///gAAAAAAAAAAAAAAAAAAAAf//+AAD/+AH/8AAH///gAAAAAAAAAAAAAAAAAAAA///+AAB/8AD/4AAH///wAAAAAAAAAAAAAAAAAAAA///8AAAf4AB/gAAD///wAAAAAAAAAAAAAAAAAAAA///8AAAAAAAAAAAD///wAAAAAAAAAAAAAAAAAAAB///4AAAAAAAAAAAB///4AAAAAAAAAAAAAAAAAAAB///wAAAAAAAAAAAA///4AAAAAAAAAAAAAAAAAAAD///wAAAAAAAAAAAA///8AAAAAAAAAAAAAAAAAAAD///gAAAAAAAAAAAAf//8AAAAAAAAAAAAAAAAAAAH///gAAAAAAAAAAAAf//+AAAAAAAAAAAAAAAAAAAH///AAAAAAAAAAAAAP//+AAAAAAAAAAAAAAAAAAAP//+AAAAAAAAAAAAAH///AAAAAAAAAAAAAAAAAAAP//+AAAAAAAAAAAAAH///AAAAAAAAAAAAAAAAAAAf//8AAAAAAAAAAAAAD///gAAAAAAAAAAAAAAAAAA///4AAAAAAAAAAAAAB///wAAAAAAAAAAAAAAAAAA///4AAAAAAAAAAAAAB///wAAAAAAAAAAAAAAAAAB///wAAAAAAAAAAAAAA///4AAAAAAAAAAAAAAAAAB///gAAAAAAAAAAAAAAf//4AAAAAAAAAAAAAAAAAD///AAAAAAAAAAAAAAAP//8AAAAAAAAAAAAAAAAAH//+AAAAAAAAAAAAAAAH//+AAAAAAAAAAAAAAAAAH//+AAAAAAAAAAAAAAAD//+AAAAAAAAAAAAAAAAAP//8AAAAAAAAAAAAAAAD///AAAAAAAAAAAAAAAAAf//4AAAAAAAAAAAAAAAB///gAAAAAAAAAAAAAAAA///wAAAAAAAAAAAAAAAA///wAAAAAAAAAAAAAAAA///gAAAAAAAAAAAAAAAAf//wAAAAAAAAAAAAAAAB///AAAAAAAAAAAAAAAAAP//4AAAAAAAAAAAAAAAD//+AAAAAAAAAAAAAAAAAH//8AAAAAAAAAAAAAAAH//8AAAAAAAAAAAAAAAAAD//+AAAAAAAAAAAAAAAP//4AAAAAAAAAAAAAAAAAB///AAAAAAAAAAAAAAAf//wAAAAAAAAAAAAAAAAAA///gAAAAAAAAAAAAAA///gAAAAAAAAAAAAAAAAAAf//wAAAAAAAAAAAAAB///AAAAAAAAAAAAAAAAAAAP//4AAAAAAAAAAAAAD//8AAAAAAAAAAAAAAAAAAAD//8AAAAAAAAAAAAAH//4AAAAAAAAAAAAAAAAAAAB//+AAAAAAAAAAAAAP//wAAAAAAAAAAAAAAAAAAAA///AAAAAAAAAAAAAf//gAAAAAAAAAAAAAAAAAAAAf//gAAAAAAAAAAAA///AAAAAAAAAAAAAAAAAAAAAP//wAAAAAAAAAAAB//+AAAAAAAAAAAAAAAAAAAAAH//4AAAAAAAAAAAD//4AAAAAAAAAAAAAAAAAAAAAB//8AAAAAAAAAAAH//wAAAAAAAAAAAAAAAAAAAAAA//+AAAAAAAAAAAP//gAAAAAAAAAAAAAAAAAAAAAAf//AAAAAAAAAAAf//AAAAAAAAAAAAAAAAAAAAAAAP//gAAAAAAAAAA//+AAAAAAAAAAAAAAAAAAAAAAAH//wAAAAAAAAAB//4AAAAAAAAAAAAAAAAAAAAAAAB//4AAAAAAAAAD//wAAAAAAAAAAAAAAAAAAAAAAAA//8AAAAAAAAAP//gAAAAAAAAAAAAAAAAAAAAAAAAf//AAAAAAAAAf/+AAAAAAAAAAAAAAAAAAAAAAAAAH//gAAAAAAAA//8AAAAAAAAAAAAAAAAAAAAAAAAAD//wAAAAAAAB//wAAAAAAAAAAAAAAAAAAAAAAAAAA//4AAAAAAAD//gAAAAAAAAAAAAAAAAAAAAAAAAAAf/8AAAAAAAH/+AAAAAAAAAAAAAAAAAAAAAAAAAAAH/+AAAAAAAf/8AAAAAAAAAAAAAAAAAAAAAAAAAAAD//gAAAAAA//wAAAAAAAAAAAAAAAAAAAAAAAAAAAA//wAAAAAB//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/4AAAAAD/+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/8AAAAAP/4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//AAAAAf/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf/gAAAA//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/wAAAD/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/8AAAH/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+AAAP/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/AAAf8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/gAB/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/4AD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AH8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+AfwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/g/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPx8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM='
const CAT_RASTERS = [
  'HXYwACgAYQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABsAABgAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAbAAAYAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGwAAGAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAGwAAAAAAGwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAABsAAAAAABsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAbAAAAAAAbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAMMAAAAAAMMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4AADDAAAAAADDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+AAAwwAAAAAAwwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/gAAwGHgHgHgwGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPwAAMBg4A4A4MBgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4AADAYGAGAGDAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgBgBgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAwAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAYAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAEAAAEAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAADADAAADAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAABgBgAABgAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAA/8AAAAAAAAAAYAYAAAYAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAH/AAAAAAAAAAGAGAAAGAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAwAAAAAAAAAGAGAAAGAAAAAAAAAMMAAAAAABgAAAAAAAAAAAA/8/8AMAAAAAAAAABgBgAABgAAAADwAAGDgADwAAAYAAAAAAAAAAAAH/H/AGAAAAAAAAAAYAYAAAYAAAAA+AADAYAA+AAAGAAAAAAAAAAAAAAwAwDAAAAAAAAAAGAGAAAGAAAAA/wAAwGAA/wAABgAAAAAAAAAAAAAwAwBgAAAAAAAAABgBgAABgAAAAP8AAMRgAP8AAAYAAAAAAAAAAAAAcAcAwAAAAAAAAAAYAYAAAYAAAAD/AADGYAD/AAAGAAAAAAAAAAAAAGAGAYAAAAAAAAAAGAGAAAGAAAAA/wAAxmAA/wAABgAAAAAAAAAAAAGAGAMAAAAAAAAAABgBgAABgAAAAH8AAMZgAH8AAAYAAAAAAAAAAAADgDgGAAAAAAAAAAAYAYAAAYAAAAA+AADGYAA+AAAGAAAAAAAAAAAAAwAwDAAAAAAAAAAABgBgAABgAAAAAAAAxmAAAAAAGAAAAAAAAAAAAAwAwAwAAAAAAAAAAAYAYAAAYAAf/gAAAH/gAAAf/hgAAAAAAAAAAAAP+P+P+AAAAAAAAAAGAGAAAGAAH/4AAAA7wAAAH/4YAAAAAAAAAAAAD/z/z/wAAAAAAAAAAwAwAAAwAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAEAAAEAAf/gAAAAAAAAAf/iAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/4AAAAAAAAAH/4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAP8AMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAEf/gHmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAADHAYD7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAOABh/+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAAAAADgAYf/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAGD/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgAAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAPgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAGAAEAACAAAAACACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAwADAAAwAAAAAwAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAMABgAAGAAAAAGAGAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAADAAYAABgAAAABgBgAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAwAGAAAYAAAAAYAYAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAwAGAAABgAAAABgBgAAAABsAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAMABgAAAYAAAAAYAYAAAAAbAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAADAAYAAAGAAAAAGAGAAAAAGwAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAGAAABgAAAABgBgAAAABgAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYABgAAAYAAAAAYAYAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAYAAAGAAAAAGAGAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAGAAGAAABgAAAABgBgAAAABgAAAAAAAAAAAAAAAAAAAAAAAAABgAAADgABgAAAYAAAAAYAYAAAAD4AAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAwAAYAAAGAAAAAGAGAAAAA+AAAAAAAAAAAAAAAAAAAAAAAAAABgAAAwAABgAAGAAAAAGAGAAAAA/gAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAcAAAYAABgAAAABgBgAAAAPwAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAGAAAGAAAYAAAAAYAYAAAAD4AAAAAAAAAAAAAAAAAAAAAAAAAAAw/+GAAAAw/+MAAAAAMAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEH/ggAAAEH/iAAAAACACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'HXYwAB0ASQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAANgAAAAAANgAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2AAAAAAA2AAAAAAAAAAAAAAAAAAAAAAAAAAAAADYAAAAAADYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYYAAAAAAYYAAAAAAAAAAAAAAAAAAAAAAAAAAAABhgAAAAABhgAAAAAAAAAAAAAAAAAAAAAAAAAAAAGGAAAAAAGGAAAAAAAAAAAAAAAAAAAAAAAAAAAABgMPAPAPBgMAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAwcAcAcGAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAYDAwAwAwYDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADADADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAYAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADADADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAADAAAAAPAAAAAAAAAPAAAAAMAAAAADAAAAAAAAAAMAAAAB+AAAf/4AAB+AAAAAwAAAAAOAAAAAAAAAAwAAAAGYAAD//wAAGYAAAADAAAAAA4AAAAAAAAAMAAAAAAAAAMADAAAAAAAAADAAAAADYAAAAAAAAAwAABxwAAAAwAMAAAAOOAAAMAAAAANgAAAAAAAADAAAHHAAAADAAwAAAA44AAAwAAAAA2AAAAAAAAAMAABhgAAAAMADAAAAAYYAADAAAAADAAAAAAAAAAwAACCAAAAAwAMAAAABBAAAMAAAAAMAAAAAAAAADAAAAAAAAADAAwAAAAAAAAAwAAAAAwAAAAAAAAAMAAAAAAAAAMADAAAAAAAAADAAAAADAAAAAAAAAAwAAAAAAAAAwAMAAAAAAAAAMAAAAB8AAAAAAAAADAAAAAAAAADAAwAAAAAAAAAwAAAAHwAAAAAAAAADAAAAAAAAADAMAAAAAAAAAMAAAAB/AAAAAAAAAAMAAAAAAAAAP/wAAAAAAAAAwAAAAH4AAAAAAAAAAwAAAAAAAAAf+AAAAAAAAADAAAAAfAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAByAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACP/wAAAAAAAABzAAAAAAAAAAAAAAAAAAAAAAAAAY4DAAAAAAAAAHeAAAAAAAAAAAAAAAAAAAAAAAAAcADAAAAAAAABjMAAAAAAAAAAAAAAAAAAAAAAAABwAMAAAAAAAAGIwAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAYDAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAABgMAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAGAwAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAYDAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAYYAAAAAAAAAAAAAAAAAAAAAAAAAADwAAAAAAAABzAAAAAAAAAAAAAAAAAAAAAAAAAAAeAAAAAAAAADYAAAAAAAAAAAAAAAAAAAAAAAAAAfAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAB4AAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  'HXYwABcASQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAADAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAwAAAAAAAAAAAAAAAAAAAAANgAAAAAANgAAAAAAAAAAAAAAAAAAAAA2AAAAAAA2AAAAAAAAAAAAAAAAAAAAADYAAAAAADYAAAAAAAAAAAAAAAAAAAAAYYAAAAAAYYAAAAAAAAAAAAAAAAAAAABhgAAAAABhgAAAAAAAAAAAAAAAAAAAAGGAAAAAAGGAAAAAAAAAAAAAAAAAAAABgMAAAAABgMAAAAAAAAAAAAAAAAAAAAGAwAAAAAGAwAAAAAAAAAAAAAAAAAAAAYDAAAAAAYDAAAAAAAAAAAAAAAAAAAAAAB/9/9/8AAAAAAAAAAAAAAAAAAAAAAAAD/z/z/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAABAAAAAAeAAAAAAAAAAYAAAAAAAAAAAAGAAAAAD4AAAAAAAAADAAAAAAAAAAAAAMAAAAAN8AAAAAAAAAMAAAAAAAAAAAAAwAAAAAzwAAAAAAAAAwAAAAAAAAAAAADAAAAADDAAAAAAAAAMAAAAAAAYYAAAADAAAAAMMAAAAAAAAAwAAAAB4DBx4AAAMAAAAAwwAAAAAAAADAAAAAHwYDHwAAAwAAAADDAAAAAAAAAMAAAAB/hgN/gAADAAAAAMMAAAAAAAAAwAAAAH+GI3+AAAMAAAADwwAAAAAAAADAAAAAf4Yzf4AAAwAAAAfDAAAAAAAAAMAAAcB/hjN/gcADAAAAD8MAAAAAAAAAwAAD4D+GMz+D4AMAAAAPzwAAAAAAAADAAAYwHwYzHwYwAwAAAA+fAAAAAAAAADAABjAABjMABjAMAAAAAD8AAAAAAAAAMAAD4AAD/wAD4AwAAAAAPwAAAAAAAAAwAAHAAAHeAAHADAAAAAA+AAAAAAAAABgAAAAAAAAAAAAYAAAAAAAAAAAAAAAACAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAwAAAAAAAAAAAAAAAAAAAAAZgAAAAAAZgAAAAAAAAAAAAAAAAAAAAByAAAAAAByAAAAAAAAAAAAAAAAAAAAADAAAAAAADAAAAAAAAAAAAAAAAAAAAAf4AAAAAAf4AAAAAAAAAAAAAAAAAAACP/wAAAACP/wAAAAAAAAAAAAAAAAAAAY4DAAAAAY4DAAAAAAAAAAAAAAAAAAAAcADAAAAAcADAAAAAAAAAAAAAAAAAAABwAMAAAABwAMAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAwAAAAAAAAAAAAAAAAAAAAADAAAAAAADAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAwAAAAAAAAAAAAAAAAAAAAAMAAAAAAAMAAAAAAAAAAAAAAAAAAAAADwAAAAAADwAAAAAAAAAAAAAAAAAAAAAeAAAAAAAeAAAAAAAAAAAAAAAAAAAAAfAAAAAAAfAAAAAAAAAAAAAAAAAAAAAB4AAAAAAB4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  'HXYwABwASQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADYAAAADAAAAAAADAAAAAAAAAAAAAAAAAAAAAAA2AAAAAwAAAAAAAwAAAAAAAAAAAAAAAAAAAAAANgAAAAMAAAAAAAMAAAAAAAAAAAAAAAAAAAAAADAAAAANgAAAAAANgAAAAAAAAAAAAAAAAAAAAAAwAAAADYAAAAAADYAAAAAAAAAAAAAAAAAAAAAAMAAAAA2AAAAAAA2AAAAAAAAAAAAAAAAAAAAAADAAAAAYYAAAAAAYYAAAAAAAAAAAAAAAAAAAAAHwAAAAGGAAAAAAGGAAAAAAAAAAAAAAAAAAAAAB8AAAABhgAAAAABhgAAAAAAAAAAAAAAAAAAAAB/AAAABgMPAPAPBgMAAAAAAAAAAAAAAAAAAAAAfgAAAAYDBwBwBwYDAAAAAAAAAAAAAAAAAAAAAHwAAAAGAwMAMAMGAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAADADADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgBgBgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAwAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAMAAAAAAAAAYYAAAAAADAAAAAAAAAAAAAAAAAADAAAAAHgAAMHAAHgAAAwAAAAAAAAAAAAAAAAAAwAAAAB8AAGAwAB8AAAMAAAAAAAAAAAAAAAAAAMAAAAB/gABgMAB/gAADAAAAAAAAAAAAAAAAAADAAAAAf4AAYjAAf4AAAwAAAAAAAAAAAAAAAAAAwAAAAH+AAGMwAH+AAAMAAAAAAAAAAAAAAAAAAMAAAAB/gABjMAB/gAADAAAAAAAAAAAAAAAAAADAAAAAP4AAYzAAP4AAAwAAAAAAAAAAAAAAAAAAwAAAAB8AAGMwAB8AAAMAAAAAAAAAAAAAAAAAADAAAAAAAABjMAAAAAAMAAAAAAAAAAAAAAAAAAAwAA//AAAAP/AAAA//DAAAAAAAAAAAAAAAAAAAMAAP/wAAAB3gAAAP/wwAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAIAA//AAAAAAAAAA//EAAAAAAAAAAAAAAAAAAAAAAP/wAAAAAAAAAP/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgYAAAAAAABgYAAAAAAAAAAAAAAAAAAAAAAAAAYGAAAAAAAAYGAAAAAAAgAAAAAAAAAAAAAAAAAGBgAAAAAAAGBgAAAAAAMAAAAAAAAAAAAAAAAABgYAAAAAAABgYAAAAAAf4AAAAAAAAAAAAAAAAAYGAAAAAAAAYGAAAAAAH8AAAAAAAAAAAAAAAAAGBgAAAAAAAGBgAAAAAA+AAAAAAAAAAAAAAAAABgYAAAAAAABgYAAAAAANgcAAAAAAAAAAAAAAAAYGAAAAAAAAYGAAAAAABIPgAAAAAAAAAAAAAAAGBgAAAAAAAGBgAAAAAAAGMAAAAAAAAAAAAAAABgYAAAAAAABgYAAAAAAABjAAAAAAAAAAAAAAAAP8AAAAAAAAP8AAAAAAAAPgAAAAAAAAAAAAAAAB+AAAAAAAAB+AAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
]

// thermal printers speak CP437-ish — fold fancy unicode down to ASCII
function toAscii(str) {
  return String(str)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/♥|♡|❤/g, '<3')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e\n]/g, '')
}

function wrap(text, width) {
  const words = toAscii(text).split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      if (line) lines.push(line)
      line = w.length > width ? w.slice(0, width) : w
    } else {
      line = (line + ' ' + w).trim()
    }
  }
  if (line) lines.push(line)
  return lines
}

function buildReceipt({ text, name, kind }) {
  const when = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${when.getFullYear()}.${pad(when.getMonth() + 1)}.${pad(when.getDate())}  ${pad(when.getHours())}:${pad(when.getMinutes())}`
  const origin = kind === 'stranger' ? "a stranger's dream" : 'your dream, returned to you'

  const raster = (b64) => Buffer.from(b64, 'base64').toString('latin1')
  // feed n lines worth of paper outright, independent of line spacing
  const feed = (n) => ESC + 'J' + String.fromCharCode(Math.min(255, Math.round(n * LINE)))
  // A real image made of nothing but zero bytes, printed through the exact
  // same raster path as the logo/cat/note art. A dedicated diagnostic
  // print proved feed() reliably makes space before TEXT (that's the
  // logo -> header gap) but NOT before another IMAGE — no amount of feed
  // (tried up to 8 lines' worth) put daylight between the cat and the
  // note graphic, on this printer specifically. Rather than keep guessing
  // why, this sidesteps the question: images print here every time, so a
  // blank one gives a guaranteed gap the same way a real one gives a
  // guaranteed picture.
  const blankGap = (dots) => {
    const h = Math.max(0, Math.min(4095, Math.round(dots)))
    if (!h) return ''
    return GS + 'v' + '0' + '\x00' + '\x01\x00' + String.fromCharCode(h & 0xff, (h >> 8) & 0xff) + '\x00'.repeat(h)
  }
  // A plain rule, not the note glyphs: the note raster did not come out
  // on real hardware, and a row of dashes is the one thing every thermal
  // printer agrees on.
  const divider = feed(1) + '-'.repeat(WIDTH) + '\n' + feed(1)
  // the note strip, sitting right against the cat above it — no gap here,
  // that's deliberate (see the cat art below)
  const noteDivider = NO_ART ? divider : raster(NOTE_RASTER) + feed(1) + '\n'
  const cat = CAT_RASTERS[Math.floor(Math.random() * CAT_RASTERS.length)]

  let r = ''
  r += ESC + '@' // init
  r += ESC + '3' + String.fromCharCode(LINE) // say the line spacing out loud
  r += ESC + 'a' + '\x01' // centre everything, rasters included

  // blankGap on both sides of the logo, not feed() — a blank image is the
  // one mechanism that's shown up reliably on paper every time, whichever
  // side of an image it sits on, so both gaps use it now
  if (!NO_ART) r += blankGap(2 * LINE) + raster(LOGO_RASTER) + PAUSE_MARKER + blankGap(32)
  r += ESC + 'E' + '\x01' + GS + '!' + '\x11' // bold, double size
  r += 'DREAM DEPOSIT\n'
  r += GS + '!' + '\x00' + ESC + 'E' + '\x00'
  r += ESC + 'J' + String.fromCharCode(88) // 88 dots — plain text either side, so feed() is fine here
  r += 'nabii - it came to me in a dream\n'

  r += divider + '\n'
  r += feed(1)
  r += stamp + '\n'
  r += origin + '\n'
  r += feed(1)
  r += divider + '\n'

  // the dream itself is the point of the receipt, so it carries the weight
  r += feed(2)
  r += ESC + 'E' + '\x01'
  for (const line of wrap(text, WIDTH)) r += line + '\n'
  r += feed(1)
  r += `- ${toAscii(name || 'anonymous')}\n`
  r += ESC + 'E' + '\x00'
  r += feed(2)

  // pause after the image only (the image itself is slow to print, still
  // needs the breather) — no gap after it: cat and notes sit flush together
  if (!NO_ART) r += raster(cat) + PAUSE_MARKER

  r += noteDivider + '\n'
  // padding above "in a world..." — a blank image, not feed(), because
  // feed() right after this particular note graphic barely showed up on
  // real paper; a blank image is the one mechanism that's printed
  // reliably every time on this hardware
  r += blankGap(32)
  r += 'in a world that feels hopeless\nyou still dreamt\n'
  r += feed(3)
  r += ESC + 'E' + '\x01'
  r += 'thank you for your\ndream deposit\n'
  r += ESC + 'E' + '\x00'
  r += feed(2)
  r += GS + 'V' + '\x42' + '\x00' // partial cut with feed
  return Buffer.from(r, 'latin1')
}

// ─── printer transports ──────────────────────────────────────

// length of one GS v 0 payload, so the dry run can skip past it
function rasterBytes(afterHeader) {
  // after the GS v 0 marker comes the mode byte, then width in bytes
  // and height in rows, each little endian
  const b = Buffer.from(afterHeader.slice(0, 5), 'latin1')
  return (b[1] | (b[2] << 8)) * (b[3] | (b[4] << 8))
}

// Talks straight to a local Windows printer queue through the spooler's
// own WritePrinter API, bypassing file sharing entirely — the printer
// doesn't need to be shared, and no firewall/network settings apply,
// because nothing leaves the machine. Used as a fallback when the
// \\host\share raw-copy trick fails (very common for a printer that's
// only ever been used locally, e.g. one sitting on a USB port).
function sendRawToLocalPrinterWindows(printerName, filePath, pauseMs) {
  return new Promise((resolve, reject) => {
    const psSource = path.join(os.tmpdir(), `dream-print-${Date.now()}.ps1`)
    const escapedFile = filePath.replace(/'/g, "''")
    const escapedName = printerName.replace(/'/g, "''")
    const pauseArg = Math.max(0, Math.round(Number(pauseMs) || 0))
    const script = `
Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DreamRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Ansi)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA di);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] data, int count, out int written);

  // Splits on the 8-byte pause marker (see PAUSE_MARKER in server.js) and
  // sleeps between the pieces, all inside one print job — this is what
  // lets an image-heavy receipt (logo, cat, note graphic) reach a cheap
  // thermal printer without the printer dropping whatever sits right
  // between two images because it hasn't finished the first one yet.
  public static string SendBytes(string printerName, byte[] data, int pauseMs) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
      return "OpenPrinter failed - check the printer name and that it's installed";
    try {
      DOCINFOA di = new DOCINFOA();
      di.pDocName = "Dream Deposit receipt";
      di.pDataType = "RAW";
      if (!StartDocPrinter(hPrinter, 1, ref di)) return "StartDocPrinter failed";
      try {
        if (!StartPagePrinter(hPrinter)) return "StartPagePrinter failed";
        try {
          byte[] marker = new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 };
          int start = 0;
          int written;
          int i = 0;
          while (i <= data.Length - marker.Length) {
            bool match = true;
            for (int j = 0; j < marker.Length; j++) {
              if (data[i + j] != marker[j]) { match = false; break; }
            }
            if (!match) { i++; continue; }
            int segLen = i - start;
            if (segLen > 0) {
              byte[] segment = new byte[segLen];
              Array.Copy(data, start, segment, 0, segLen);
              if (!WritePrinter(hPrinter, segment, segment.Length, out written)) return "WritePrinter failed";
            }
            System.Threading.Thread.Sleep(pauseMs);
            start = i + marker.Length;
            i = start;
          }
          int lastLen = data.Length - start;
          if (lastLen > 0) {
            byte[] tail = new byte[lastLen];
            Array.Copy(data, start, tail, 0, lastLen);
            if (!WritePrinter(hPrinter, tail, tail.Length, out written)) return "WritePrinter failed";
          }
          return "";
        } finally { EndPagePrinter(hPrinter); }
      } finally { EndDocPrinter(hPrinter); }
    } finally { ClosePrinter(hPrinter); }
  }
}
"@
$bytes = [System.IO.File]::ReadAllBytes('${escapedFile}')
$result = [DreamRawPrint]::SendBytes('${escapedName}', $bytes, ${pauseArg})
if ($result -ne "") { Write-Error $result; exit 1 }
`
    fs.writeFileSync(psSource, script)
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psSource],
      (err, _stdout, stderr) => {
        fs.unlink(psSource, () => {})
        if (err) reject(new Error(stderr.trim() || err.message))
        else resolve()
      },
    )
  })
}

// The dry-run console preview below shows what's IN the receipt buffer,
// but feed() (ESC J, dots) and ESC d (whole lines) are printer
// instructions, not literal blank-line characters — so left alone they
// show up as stray, confusing bytes instead of the gap they actually
// produce on paper. This turns both into real '\n' characters so the
// terminal preview finally shows the space where the space really is.
function visualizeFeeds(str) {
  let out = ''
  for (let i = 0; i < str.length; i++) {
    if (str[i] === ESC && str[i + 1] === 'J') {
      const dots = str.charCodeAt(i + 2)
      out += '\n'.repeat(Math.max(0, Math.round(dots / LINE)))
      i += 2
      continue
    }
    if (str[i] === ESC && str[i + 1] === 'd') {
      const n = str.charCodeAt(i + 2)
      out += '\n'.repeat(Math.max(0, n))
      i += 2
      continue
    }
    out += str[i]
  }
  return out
}

function sendToPrinter(buf) {
  return new Promise((resolve, reject) => {
    if (TARGET === 'console') {
      process.stdout.write('\n────── receipt (dry run) ──────\n')
      const shown = visualizeFeeds(
        buf
          .toString('latin1')
          .split(GS + 'v0')
          .map((part, i) => (i === 0 ? part : part.slice(5 + rasterBytes(part))))
          .join('[ nabii artwork ]'),
      ).replace(/[\x00-\x08\x0b-\x1f]/g, '')
      process.stdout.write(shown)
      process.stdout.write('───────────────────────────────\n')
      return resolve()
    }

    if (/^COM\d+$/i.test(TARGET)) {
      // USB/serial printer exposed as a COM port
      const stream = fs.createWriteStream('\\\\.\\' + TARGET.toUpperCase())
      stream.on('error', reject)
      stream.end(buf, () => resolve())
      return
    }

    if (TARGET.startsWith('/dev/')) {
      // a serial or USB printer that shows up as a device file, which is
      // how they appear on macOS and Linux
      const stream = fs.createWriteStream(TARGET)
      stream.on('error', reject)
      stream.end(buf, () => resolve())
      return
    }

    if (TARGET.startsWith('cups:')) {
      // a printer macOS or Linux already knows about, sent raw so the
      // ESC/POS reaches it untouched instead of being treated as a document
      const queue = TARGET.slice(5)
      const tmp = path.join(os.tmpdir(), `dream-${Date.now()}.bin`)
      fs.writeFileSync(tmp, buf)
      execFile('lp', ['-d', queue, '-o', 'raw', tmp], (err) => {
        fs.unlink(tmp, () => {})
        err ? reject(err) : resolve()
      })
      return
    }

    if (TARGET.startsWith('\\\\')) {
      // A Windows printer named as \\host\share. We used to send this as a
      // raw file copy (`copy /b file \\host\share`) — that "works" in the
      // sense that it succeeds and text prints, but a copy like that isn't
      // guaranteed to reach the printer as true raw bytes: if the shared
      // queue's default datatype isn't RAW, the driver can quietly treat
      // it as a text document and reformat it — trimming or collapsing
      // exactly the blank lines and feed commands we're relying on for
      // spacing, with no error to tell us it happened. Going straight
      // through the spooler API instead (same mechanism as the plain
      // local-printer case below) forces RAW regardless of how the queue
      // is configured, and skips needing the printer shared at all — this
      // machine has the printer on it, so the "share" was never necessary.
      const tmp = path.join(os.tmpdir(), `dream-${Date.now()}.bin`)
      fs.writeFileSync(tmp, buf)
      const printerName = TARGET.split('\\').filter(Boolean).pop()
      sendRawToLocalPrinterWindows(printerName, tmp, PAUSE_MS)
        .then(() => {
          fs.unlink(tmp, () => {})
          resolve()
        })
        .catch((localErr) => {
          fs.unlink(tmp, () => {})
          reject(localErr)
        })
      return
    }

    // network printer — raw TCP (JetDirect port 9100)
    const [host, port] = TARGET.split(':')
    const socket = net.createConnection({ host, port: Number(port) || 9100, timeout: 5000 })
    socket.on('error', reject)
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('printer connection timed out'))
    })
    socket.on('connect', () => {
      socket.end(buf, () => resolve())
    })
  })
}

// ─── HTTP server the site talks to ───────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*', // local-only service, no data returned
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// ─── finding printers ────────────────────────────────────────
// One detector, used both by --list on the command line and by the
// setup page, so what you see in a terminal is what the page offers.

const run = (cmd, args) =>
  new Promise((done) =>
    execFile(cmd, args, (err, out, errOut) =>
      done({ out: String(out || '').trim(), err: err ? String(errOut || err.message).trim() : '' }),
    ),
  )

const lines = (s) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

// Reports what it looked for and how each lookup went, because "no
// printers" on its own is impossible to act on from the other end of a
// phone call. Windows in particular has three different ways to ask,
// and machines exist where the first one is missing.
async function findPrinters() {
  const found = []
  const notes = []
  const add = (value, label) => {
    if (!found.some((f) => f.value === value)) found.push({ value, label })
  }

  if (process.platform === 'win32') {
    const attempts = [
      ['Get-Printer', 'Get-Printer | Select-Object -ExpandProperty Name'],
      ['Win32_Printer', 'Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name'],
      ['WMIC', null],
    ]
    let names = []
    for (const [label, script] of attempts) {
      const r = script
        ? await run('powershell', ['-NoProfile', '-Command', script])
        : await run('wmic', ['printer', 'get', 'name'])
      const got = lines(r.out).filter((n) => n.toLowerCase() !== 'name')
      if (got.length) {
        names = got
        notes.push(`Printers via ${label}: ${got.join(', ')}`)
        break
      }
      notes.push(`Printers via ${label}: ${r.err ? `failed, ${r.err.split('\n')[0]}` : 'none'}`)
    }
    for (const name of names) {
      add(`\\\\${os.hostname()}\\${name}`, `${name} (installed printer)`)
    }

    const ports = await run('powershell', [
      '-NoProfile',
      '-Command',
      '[System.IO.Ports.SerialPort]::GetPortNames()',
    ])
    const portNames = lines(ports.out)
    notes.push(`Serial ports: ${portNames.length ? portNames.join(', ') : 'none'}`)
    for (const port of portNames) add(port, `${port} (serial port)`)
  } else {
    // -p lists queues that are up, -e lists every destination CUPS knows,
    // including ones -p quietly omits.
    const shown = await run('lpstat', ['-p'])
    const all = await run('lpstat', ['-e'])
    const queues = [
      ...lines(shown.out)
        .filter((l) => l.startsWith('printer '))
        .map((l) => l.split(' ')[1]),
      ...lines(all.out),
    ]
    const uniq = [...new Set(queues)]
    if (shown.err && !uniq.length) notes.push(`lpstat failed: ${shown.err.split('\n')[0]}`)
    notes.push(`Installed printers: ${uniq.length ? uniq.join(', ') : 'none, add it in system settings first'}`)
    for (const name of uniq) add(`cups:${name}`, `${name} (installed printer)`)

    let devs = []
    try {
      devs = fs
        .readdirSync('/dev')
        .filter((d) => /^(cu|tty)\.(usb|wch|SLAB)/i.test(d) || /^ttyUSB\d+$/.test(d))
    } catch {
      notes.push('Could not read /dev')
    }
    notes.push(`USB and serial devices: ${devs.length ? devs.join(', ') : 'none'}`)
    for (const d of devs) add(`/dev/${d}`, `${d} (usb or serial)`)
  }

  add('console', 'no printer, print to this window')
  return { printers: found, notes, platform: process.platform, host: os.hostname() }
}

if (process.argv.includes('--list')) {
  findPrinters().then(({ printers, notes }) => {
    console.log('Printers and ports on this machine\n')
    for (const n of notes) console.log(`  ${n}`)
    console.log('')
    for (const p of printers) console.log(`  --target ${p.value}\n      ${p.label}`)
    console.log('\nA network printer is just its address:  --target 192.168.1.50')
    process.exit(0)
  })
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/printers') {
    return findPrinters().then((info) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
      res.end(JSON.stringify({ ok: true, version: VERSION, current: TARGET, ...info }))
    })
  }

  if (req.method === 'POST' && req.url === '/target') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const { target } = JSON.parse(body || '{}')
        if (!target || typeof target !== 'string') throw new Error('no target given')
        TARGET = target
        console.log(`[target] now printing to ${TARGET}`)
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
        res.end(JSON.stringify({ ok: true, target: TARGET }))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS })
        res.end(JSON.stringify({ ok: false, error: err.message }))
      }
    })
    return
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
    return res.end(JSON.stringify({ ok: true, version: VERSION, target: TARGET, width: WIDTH }))
  }

  if (req.method === 'POST' && req.url === '/print') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        const { text, name, kind } = JSON.parse(body || '{}')
        if (!text || String(text).trim().length < 2) throw new Error('no dream text')
        await sendToPrinter(buildReceipt({ text, name, kind }))
        console.log(`[printed] (${kind || 'own'}) "${String(text).slice(0, 50)}…" — ${name || 'anonymous'}`)
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        console.error('[print failed]', err.message)
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS })
        res.end(JSON.stringify({ ok: false, error: err.message }))
      }
    })
    return
  }

  res.writeHead(404, CORS)
  res.end()
})

// Bound to every interface, not just loopback, because the browser doing
// the depositing is usually on a different machine to the printer. Pass
// --host 127.0.0.1 to keep it local.
const hostArg = process.argv.indexOf('--host')
const HOST = hostArg > -1 ? process.argv[hostArg + 1] : '0.0.0.0'

function lanAddresses() {
  const out = []
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address)
    }
  }
  return out
}

if (!process.argv.includes('--list')) {
  server.listen(HTTP_PORT, HOST, () => {
    console.log(`Dream Deposit printer bridge  v${VERSION}`)
    console.log(`  printing to   ${TARGET}${TARGET === 'console' ? ' (dry run, pick one on the setup page)' : ''}`)
    console.log(`  paper width   ${WIDTH} chars`)
    console.log(`  listening on  http://127.0.0.1:${HTTP_PORT}`)
    for (const ip of lanAddresses()) {
      console.log(`                http://${ip}:${HTTP_PORT}   <- use this one from another machine`)
    }
    console.log(`\nOn the machine people deposit from, open`)
    console.log(`  itcametomeinadream.online/printer.html`)
    console.log(`paste one of the addresses above, and pick this printer from the list.`)
  })
}
