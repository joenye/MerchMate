# Brighter Merchant

[![Discord](https://img.shields.io/badge/Discord-Join%20Server-5865F2?logo=discord&logoColor=white)](https://discord.gg/mQdKPjDT)

> **⚠️ Important Notice:** As of the updated [Brighter Shores rules](https://brightershores.com/rules), using software that reads the game display is now prohibited. **Use at your own risk.** This project remains open source for educational purposes.

<p align="center">
  <img src="assets/icon.png" alt="Brighter Merchant Logo" width="128" height="128">
</p>

A desktop overlay for [Brighter Shores](https://www.brightershores.com/) that calculates the most efficient merchant bounty routes in real-time.

## Features

- **Real-time OCR** — Automatically detects bounties from your game screen
- **Optimal pathfinding** — Calculates the best route to maximize KP/hour
- **Overlay display** — Shows next steps directly on your game window
- **Session tracking** — Track your KP earned and bounties completed

## Screenshots

<p align="center">
  <img src="website/screenshot-1.jpg" alt="Optimal bounty selection" width="600">
  <br>
  <em>Optimal bounty selection with route overlay</em>
</p>

<p align="center">
  <img src="website/screenshot-2.jpg" alt="Edit mode" width="600">
  <br>
  <em>Edit mode for configuring overlay positions</em>
</p>

<p align="center">
  <img src="website/screenshot-3-4-combined.jpg" alt="Session tracking and settings" width="600">
  <br>
  <em>Session tracking and settings panel</em>
</p>

## Installation

Download the latest release from the [Releases page](https://github.com/joenye/BrighterMerchant/releases/latest).

### macOS

> **Note:** Only Apple Silicon Macs (M1/M2/M3+) are supported.

The app is not code-signed, so macOS will block it by default. To run it:

1. Download `Brighter Merchant-macos-arm64.dmg`
2. Open the `.dmg` and drag Brighter Merchant to your Applications folder
3. Remove the quarantine attribute:
   ```bash
   sudo xattr -cr /Applications/Brighter Merchant.app
   ```
   (You may see some "permission denied" warnings — these are safe to ignore)
4. Launch Brighter Merchant normally
5. Grant **Screen Recording** and **Accessibility** permissions when prompted
   - If not prompted, go to **System Settings → Privacy & Security** and enable Brighter Merchant under both

### Windows

1. Download `Brighter Merchant-windows-x64-setup.exe` (installer) or `Brighter Merchant-windows-x64-portable.exe` (no install)
2. Run the installer or portable executable
3. Windows Defender may show a warning — click "More info" → "Run anyway"

### Linux

> **Important:** Brighter Merchant requires an X11 window server. Wayland is not supported.

1. Download `Brighter Merchant-linux-x64.AppImage`
2. Make it executable: `chmod +x Brighter Merchant-linux-x64.AppImage`
3. Run: `./Brighter Merchant-linux-x64.AppImage`

If you're using Wayland, you can try running with XWayland:
```bash
GDK_BACKEND=x11 ./Brighter Merchant-linux-x64.AppImage
```

## Usage

1. Launch Brighter Shores
2. Launch Brighter Merchant
3. The overlay will automatically attach when you focus the game window
4. **Position the overlay regions** (first time only):
   - Press `Cmd+J` (macOS) or `Ctrl+J` (Windows/Linux) to enter edit mode
   - Drag the overlay regions to align with the bounty board and merchant UI elements
   - Press `Cmd+J` / `Ctrl+J` again to exit edit mode
5. Open the bounty board to start tracking

### Overlay Regions

In edit mode, position the overlay regions as follows:

| Region Name | Purpose |
|--------|---------|
| **Chat Box** | Displays the current route and route metrics |
| **Board Title** | Position over the bounty board title text (used to detect when the board is open) |
| **Guild Board 1-6** | Position over the 6 bounties shown on the bounty board |
| **Active Bounty 1-6** | Position over your 6 accepted bounties in the merchant UI |

### Keyboard Shortcuts

Default shortcuts (customizable in Settings):

| Shortcut | Action |
|----------|--------|
| `Cmd+J` | Toggle edit mode (reposition overlay regions) |
| `Cmd+K` | Toggle overlay visibility |
| `Cmd+N` | Force recalculate optimal route |
| `Cmd+,` | Open settings |

### OCR Performance

Brighter Merchant uses OCR to read bounty information from your screen. Two OCR engines are supported:

- **Tesseract.js** (default) — Built-in, works out of the box
- **Native Tesseract** (optional) — Slightly better performance and accuracy

The app auto-detects native Tesseract if installed. You can override this in Settings → OCR Method.

**Tip:** If OCR is having trouble detecting bounties, try increasing the game window size. Larger text is easier for OCR to read accurately. If the bounty board region is too small, the text may be difficult to recognize.

<details>
<summary>Installing native Tesseract (optional)</summary>

- **macOS**: `brew install tesseract`
- **Windows**: Download from [UB-Mannheim/tesseract](https://github.com/UB-Mannheim/tesseract/wiki)
- **Linux**: `sudo apt install tesseract-ocr`

</details>

## FAQs

### Is this against the Brighter Shores terms of service?

**Yes, as of the updated rules.** The [Brighter Shores rules](https://brightershores.com/rules) now explicitly prohibit "using or creating software which reads the display or memory or network traffic of the Brighter Shores client."

Brighter Merchant reads the game display using OCR to detect bounties, which violates this rule. **Use at your own risk.** We respect the developers' decision and understand if you choose not to use this tool.

This project will remain open source for educational purposes.

### Is this secure? The app needs to read my screen? That doesn't seem safe.

Brighter Merchant is completely open source, so you can verify exactly what it does. The app only captures specific regions of the Brighter Shores application window — nothing else on your screen. It makes no network calls except for checking for updates. You can review the source code, build it yourself, or verify the official builds match the published code. See [SECURITY.md](docs/SECURITY.md) for details on verifying releases.

### How do I report a bug or request a feature?

Please report bugs and feature requests on [GitHub Issues](https://github.com/joenye/BrighterMerchant/issues). Before creating a new issue, check if it already exists. For bugs, include your OS and Brighter Merchant version along with steps to reproduce. If you have questions or want to discuss ideas, join our [Discord server](https://discord.gg/mQdKPjDT).

## Building from Source

```bash
git clone https://github.com/joenye/BrighterMerchant.git
cd BrighterMerchant
npm install
npm run start
```

To build a distributable:
```bash
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for detailed development setup.

## Documentation

- [Contributing](docs/CONTRIBUTING.md) — Development setup and guidelines
- [Developing](docs/DEVELOPING.md) — Building and debugging
- [Security](docs/SECURITY.md) — Verifying release integrity
- [Releasing](docs/RELEASING.md) — How to create releases

## Acknowledgements

- [brighter-shores-routefinder](https://github.com/bricefrisco/brighter-shores-routefinder) — Original routefinding algorithm
- [electron-overlay-window](https://github.com/SnosMe/electron-overlay-window) — Native overlay window library
- [Brighter Shores Wiki](https://brightershoreswiki.org/) — Bounty and market data

## License

MIT — see [LICENSE](LICENSE)

This project includes code from [electron-overlay-window](https://github.com/SnosMe/electron-overlay-window). See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for details.
