#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Dream Deposit — thermal printer bridge
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
const WIDTH = Number(getArg('width', 32))

// ─── ESC/POS receipt ─────────────────────────────────────────

const ESC = '\x1b'
const GS = '\x1d'

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
  const rule = '-'.repeat(WIDTH)
  const origin = kind === 'stranger' ? "a stranger's dream" : 'your dream, returned to you'

  let r = ''
  r += ESC + '@' // init
  r += ESC + 'a' + '\x01' // center
  r += ESC + 'E' + '\x01' // bold on
  r += GS + '!' + '\x11' // double width+height
  r += 'DREAM DEPOSIT\n'
  r += GS + '!' + '\x00' // normal size
  r += ESC + 'E' + '\x00' // bold off
  r += 'nabii - it came to me in a dream\n'
  r += rule + '\n'
  r += stamp + '\n'
  r += origin + '\n'
  r += rule + '\n'
  r += ESC + 'E' + '\x01'
  r += 'thank you for your\ndream donation\n'
  r += ESC + 'E' + '\x00'
  r += '\n'
  for (const line of wrap(text, WIDTH)) r += line + '\n'
  r += '\n'
  r += `- ${toAscii(name || 'anonymous')}\n`
  r += rule + '\n'
  r += 'in a world that feels hopeless\nyou still dreamt\n'
  r += '\n\n\n\n'
  r += GS + 'V' + '\x42' + '\x00' // partial cut with feed
  return Buffer.from(r, 'latin1')
}

// ─── printer transports ──────────────────────────────────────

function sendToPrinter(buf) {
  return new Promise((resolve, reject) => {
    if (TARGET === 'console') {
      process.stdout.write('\n────── receipt (dry run) ──────\n')
      process.stdout.write(buf.toString('latin1').replace(/[\x00-\x08\x0b-\x1f]/g, ''))
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
      // Windows shared printer — raw copy of a temp file
      const tmp = path.join(os.tmpdir(), `dream-${Date.now()}.bin`)
      fs.writeFileSync(tmp, buf)
      execFile('cmd', ['/c', 'copy', '/b', tmp, TARGET], (err) => {
        fs.unlink(tmp, () => {})
        err ? reject(err) : resolve()
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
  new Promise((done) => execFile(cmd, args, (err, out) => done(err ? '' : String(out).trim())))

async function findPrinters() {
  const found = []

  if (process.platform === 'win32') {
    const printers = await run('powershell', [
      '-NoProfile',
      '-Command',
      'Get-Printer | Select-Object -ExpandProperty Name',
    ])
    for (const name of printers.split(/\r?\n/).filter(Boolean)) {
      found.push({ value: `\\\\${os.hostname()}\\${name.trim()}`, label: `${name.trim()} (installed printer)` })
    }
    const ports = await run('powershell', [
      '-NoProfile',
      '-Command',
      '[System.IO.Ports.SerialPort]::GetPortNames()',
    ])
    for (const port of ports.split(/\r?\n/).filter(Boolean)) {
      found.push({ value: port.trim(), label: `${port.trim()} (serial port)` })
    }
  } else {
    const cups = await run('lpstat', ['-p'])
    for (const line of cups.split('\n')) {
      if (!line.startsWith('printer ')) continue
      const name = line.split(' ')[1]
      found.push({ value: `cups:${name}`, label: `${name} (installed printer)` })
    }
    try {
      for (const d of fs.readdirSync('/dev')) {
        if (/^(cu|tty)\.(usb|wch|SLAB)/i.test(d) || /^ttyUSB\d+$/.test(d)) {
          found.push({ value: `/dev/${d}`, label: `${d} (usb or serial)` })
        }
      }
    } catch {
      /* unreadable /dev, nothing to add */
    }
  }

  found.push({ value: 'console', label: 'no printer, print to this window' })
  return found
}

if (process.argv.includes('--list')) {
  findPrinters().then((list) => {
    console.log('Printers and ports on this machine\n')
    for (const p of list) console.log(`  --target ${p.value}\n      ${p.label}`)
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
    return findPrinters().then((printers) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
      res.end(JSON.stringify({ ok: true, current: TARGET, printers }))
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
    return res.end(JSON.stringify({ ok: true, target: TARGET, width: WIDTH }))
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
    console.log(`Dream Deposit printer bridge`)
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
