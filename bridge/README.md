# printer bridge

Turns a deposited dream into a physical thermal-printer receipt.

The website can't talk to a printer directly, so this tiny local server sits in
between: the site POSTs the dream to it, and it speaks ESC/POS to the printer.
Runs anywhere Node runs. Zero dependencies. Nothing is stored.

## Run it (on the machine the printer is plugged into)

Double click `start.command` on a Mac or `start.bat` on Windows, or run it
yourself:

```bash
node server.js --target console
```

`--target console` is a dry run that prints the receipt to the terminal — use it
to test the flow before the printer arrives. Real targets:

| Printer | Command |
|---|---|
| Network / WiFi thermal printer | `node server.js --target 192.168.1.50` |
| USB printer on a COM port | `node server.js --target COM3` |
| Windows shared printer | `node server.js --target "\\\\THISPC\\Receipt"` |

Options: `--port 7788` (HTTP port), `--width 32` (chars per line: 32 = 58mm
paper, 48 = 80mm paper).

## Point the site at it

Open the site with the `printer` query param on the installation machine:

```text
https://nicholaspjm.github.io/dream-deposit-live/?printer=1
```

Every deposit then also posts the dream to the bridge — printing either the
visitor's own dream or a stranger's, matching their "show me…" choice.

(`?printer=http://other-machine:7788` works too if the bridge runs elsewhere.)

## USB printer notes (Windows)

Most USB thermal printers can expose a virtual COM port — install the vendor's
"virtual serial port" driver, check Device Manager for the COM number, then use
`--target COM3`. If the printer only installs as a Windows printer, share it
(Printer properties → Sharing → "Receipt") and use the shared-printer target.

## If the artwork prints as garbage

Receipts include nabii's logo and note dividers as printer graphics. A few
older printers don't support them. Start the bridge with `--nologo` and it
uses plain text instead:

    node server.js --target console --nologo

## If the spacing comes out wrong

Gaps are fed in dots, not blank lines, since printers disagree about how
tall a blank line is. The default is 32 dots per line. Tune it if needed:

    node server.js --target console --spacing 40
