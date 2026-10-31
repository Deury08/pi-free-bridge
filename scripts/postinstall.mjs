#!/usr/bin/env node
// postinstall.mjs - Downloads pi-free-bridge binary for the current platform

import { spawnSync } from "child_process";
import { writeFileSync, existsSync, mkdirSync, chmodSync, copyFileSync, unlinkSync, readFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import https from "https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const BIN_DIR = join(ROOT, "node_modules", ".bin");
const BRIDGE_GO_DIR = join(ROOT, "bridge-go");

const RELEASE_BASE = "https://github.com/Deury08/pi-free-bridge/releases/download";
const REPO = "Deury08/pi-free-bridge";
const BINARY_NAME = "pi-free-bridge";

const WARP_RELEASE_BASE = "https://github.com/Deury08/warp-minimal/releases/download";
const WARP_VERSION = "v0.1.0";
const WARP_BINARY_NAME = "warp-minimal";

const PLATFORM_MAP = {
  "win32-x64": "windows_amd64",
  "win32-arm64": "windows_arm64",
  "linux-x64": "linux_amd64",
  "linux-arm64": "linux_arm64",
  "darwin-x64": "darwin_amd64",
  "darwin-arm64": "darwin_arm64",
};

function getPlatformKey() {
  const platform = process.platform;
  const arch = process.arch;
  return `${platform}-${arch}`;
}

function getAssetName(platformKey, version) {
  const mapped = PLATFORM_MAP[platformKey];
  if (!mapped) {
    throw new Error(`Unsupported platform: ${platformKey}`);
  }
  const ext = process.platform === "win32" ? ".exe" : "";
  return `pi-free-bridge_${version}_${mapped}${ext === ".exe" ? ".zip" : ".tar.gz"}`;
}

function getWarpAssetName(platformKey, version) {
  const mapped = PLATFORM_MAP[platformKey];
  if (!mapped) {
    throw new Error(`Unsupported platform: ${platformKey}`);
  }
  const ext = process.platform === "win32" ? ".exe" : "";
  const archiveExt = process.platform === "win32" ? ".zip" : ".tar.gz";
  return `warp-minimal_${version}_${mapped}${ext}${archiveExt}`;
}

function downloadFile(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = https.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status === 301 || status === 302 || status === 307 || status === 308) {
        const location = res.headers.location;
        res.resume();
        if (!location) {
          reject(new Error(`HTTP ${status}: no Location header: ${url}`));
          return;
        }
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects: ${url}`));
          return;
        }
        const nextUrl = new URL(location, url).href;
        downloadFile(nextUrl, dest, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}: ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        writeFileSync(dest, Buffer.concat(chunks));
        resolve();
      });
    });
    file.on("error", reject);
  });
}

function extractArchive(archivePath, destDir) {
  const isZip = archivePath.endsWith(".zip");
  if (isZip) {
    const result = spawnSync("powershell", [
      "-Command",
      "Expand-Archive",
      "-Path",
      archivePath,
      "-DestinationPath",
      destDir,
      "-Force",
    ], { stdio: "inherit" });
    if (result.error || result.status !== 0) {
      throw new Error(`Failed to extract zip`);
    }
  } else {
    const result = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
    if (result.error || result.status !== 0) {
      throw new Error(`Failed to extract tar.gz`);
    }
  }
}

async function downloadWarpBinary() {
  console.log("[postinstall] Installing warp-minimal (optional)...");

  const platformKey = getPlatformKey();
  const assetName = getWarpAssetName(platformKey, WARP_VERSION);
  const downloadUrl = `${WARP_RELEASE_BASE}/${WARP_VERSION}/${assetName}`;
  const archivePath = join(BIN_DIR, assetName);
  const binaryPath = join(BIN_DIR, WARP_BINARY_NAME + (process.platform === "win32" ? ".exe" : ""));

  console.log(`[postinstall] Platform: ${platformKey}`);
  console.log(`[postinstall] Downloading: ${downloadUrl}`);

  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
  }

  try {
    await downloadFile(downloadUrl, archivePath);
    console.log("[postinstall] Download complete, extracting...");
    extractArchive(archivePath, BIN_DIR);

    if (process.platform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }

    unlinkSync(archivePath);
    console.log(`[postinstall] warp-minimal installed to ${binaryPath}`);
  } catch (err) {
    console.error("[postinstall] Failed to download warp-minimal:", err.message);
    console.log("[postinstall] warp-minimal is optional; you can build it from source in warp-minimal/");
  }
}

async function main() {
  console.log("[postinstall] Installing pi-free-bridge...");

  const pkgPath = join(ROOT, "package.json");
  let version = "v0.1.0";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    version = "v" + (pkg.version || version).replace(/^v/, "");
  } catch {}

  const platformKey = getPlatformKey();
  const assetName = getAssetName(platformKey, version);
  const downloadUrl = `${RELEASE_BASE}/${version}/${assetName}`;
  const archivePath = join(BIN_DIR, assetName);
  const binaryPath = join(BIN_DIR, BINARY_NAME + (process.platform === "win32" ? ".exe" : ""));

  console.log(`[postinstall] Platform: ${platformKey}`);
  console.log(`[postinstall] Downloading: ${downloadUrl}`);

  try {
    if (!existsSync(BIN_DIR)) {
      mkdirSync(BIN_DIR, { recursive: true });
    }

    await downloadFile(downloadUrl, archivePath);
    console.log("[postinstall] Download complete, extracting...");
    extractArchive(archivePath, BIN_DIR);

    if (process.platform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }

    // The archive contains bridge-go/pi-free-bridge.exe; move it to BIN_DIR
    const extractedBinary = join(BIN_DIR, "bridge-go", "pi-free-bridge" + (process.platform === "win32" ? ".exe" : ""));
    if (existsSync(extractedBinary) && extractedBinary !== binaryPath) {
      copyFileSync(extractedBinary, binaryPath);
      if (process.platform !== "win32") chmodSync(binaryPath, 0o755);
      const subDir = join(BIN_DIR, "bridge-go");
      if (existsSync(subDir)) rmSync(subDir, { recursive: true, force: true });
    }
    unlinkSync(archivePath);
    console.log(`[postinstall] pi-free-bridge installed to ${binaryPath}`);
  } catch (err) {
    console.error("[postinstall] Failed to download pi-free-bridge:", err.message);
    console.log("[postinstall] Falling back to local build if available...");

    const localBinary = join(BRIDGE_GO_DIR, "pi-free-bridge" + (process.platform === "win32" ? ".exe" : ""));
    if (existsSync(localBinary)) {
      copyFileSync(localBinary, binaryPath);
      if (process.platform !== "win32") {
        chmodSync(binaryPath, 0o755);
      }
      console.log("[postinstall] Using locally built binary");
    } else {
      // Try to build from source if Go is available.
      console.log("[postinstall] Attempting to build pi-free-bridge from source...");
      const buildResult = spawnSync("go", ["build", "-o", localBinary, "./cmd/bridge-go"], {
        cwd: BRIDGE_GO_DIR,
        stdio: "inherit",
      });
      if (!buildResult.error && buildResult.status === 0 && existsSync(localBinary)) {
        copyFileSync(localBinary, binaryPath);
        if (process.platform !== "win32") {
          chmodSync(binaryPath, 0o755);
        }
        console.log("[postinstall] Built pi-free-bridge from source");
      } else {
        console.warn("[postinstall] No pi-free-bridge binary available. Install Go and run 'go build -o pi-free-bridge ./cmd/bridge-go' in pi-free-bridge/");
        process.exit(1);
      }
    }
  }
}

const wantWarp =
  process.env.PI_FREE_BRIDGE_WARP === "true" ||
  process.argv.includes("--warp");

if (wantWarp) {
  await downloadWarpBinary();
}

main().catch((err) => {
  console.error("[postinstall] Fatal:", err);
  process.exit(1);
});
