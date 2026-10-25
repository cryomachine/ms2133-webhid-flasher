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

Open the printed localhost URL in desktop Chrome or Edge, connect the device, make and save a complete backup, then select the firmware task. For the normal rescue flow, choose a matching local image and save the device backup before starting. The separate factory restore task uses the pinned bundled image without a pre-read or backup, reconstructs full writable sectors, and verifies them after programming.

## Publication boundary

The sole bundled binary is `public/firmware/factory.bin`, 524288 bytes, SHA-256 `29139f8cb6d9671a605d4e2789a7dbfb8d311534b5d11219ff9d32c2715077f8`. CI verifies that exact image in source and deployment assets; all other firmware, ROM dumps, backups, recovery packages, and generated binaries remain excluded. This project documents and implements the WebHID factory SPI transaction; it is not a physical SPI programmer and bundles only the pinned factory image for the restore task.
