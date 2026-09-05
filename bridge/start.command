#!/bin/bash
# Double-click this on a Mac to start the printer bridge.
# Change --target console to your printer once you've tested it.
cd "$(dirname "$0")"
node server.js --target console
