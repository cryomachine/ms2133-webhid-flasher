# U3 / SPI recovery path

This repository contains the source for the browser rescue path used with MS2133 boards that still enumerate as HID.

## What it does

- Detects `VID 0x345F` with `PID 0x2133` (normal USB3 Video) or `PID 0x0001` (U3 Upgrade).
- Uses the device's factory HID transport to reach its SPI controller.
- Double-reads the full Flash before any destructive operation.
- Accepts a locally selected 98,356-byte container or a full Flash backup.
- Preserves the target Flash tail when a boot container is written.
- Erases and programs only changed sectors, then verifies every sector and the full Flash.

The implementation is in [`src/webhid-protocol.ts`](../src/webhid-protocol.ts); UI-side file validation and the save-before-erase barrier are in [`src/backend.ts`](../src/backend.ts).

## Required state

The device must still enumerate as a WebHID device. A board with no USB/HID enumeration cannot be reached by this page; use a physical SPI clip or an external programmer for that state.

## Run locally

```sh
npm ci
npm run check:source
npm test
npm run build
npm run dev
```

Open the printed localhost URL in desktop Chrome or Edge, connect the device, make and save a complete backup, then select the firmware task. The page never ships a firmware image; choose an image from the local machine and verify its hash before starting.

## Publication boundary

Firmware, ROM dumps, full Flash backups, recovery packages, and generated binaries are excluded by `.gitignore` and the source-only CI check. This project documents and implements the WebHID factory SPI transaction; it is not a physical SPI programmer and does not contain any vendor image.
