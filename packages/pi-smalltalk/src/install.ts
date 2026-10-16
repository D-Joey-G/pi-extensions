import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PHARO_VERSION = "130";
const FILES_URL = `https://files.pharo.org/get-files/${PHARO_VERSION}`;
const RUNTIME_DIR = path.join(getAgentDir(), "smalltalk", `pharo-${PHARO_VERSION}`);

/** A Pharo VM and the pristine image every project image starts from. */
export interface Runtime {
  vm: string;
  image: string;
  changes: string;
  sources: string;
}

interface Platform {
  vmZip: string;
  imageZip: string;
  /** VM executable relative to the unzipped VM directory. */
  vmPath: string;
}

function platform(): Platform {
  const arch = process.arch === "x64" ? "x86_64" : process.arch;
  if (process.platform === "darwin" && (arch === "x86_64" || arch === "arm64")) {
    return {
      vmZip: `pharo-vm-Darwin-${arch}-stable.zip`,
      imageZip: `pharoImage-${arch}.zip`,
      vmPath: "Pharo.app/Contents/MacOS/Pharo",
    };
  }
  if (process.platform === "linux" && arch === "x86_64") {
    return { vmZip: "pharo-vm-Linux-x86_64-stable.zip", imageZip: "pharoImage-x86_64.zip", vmPath: "bin/pharo" };
  }
  throw new Error(`No Pharo ${PHARO_VERSION} build for ${process.platform}/${process.arch}`);
}

function locate(dir: string): Runtime | undefined {
  const vm = path.join(dir, "vm", platform().vmPath);
  const imageDir = path.join(dir, "image");
  if (!fs.existsSync(vm) || !fs.existsSync(imageDir)) return undefined;
  const files = fs.readdirSync(imageDir);
  const find = (ext: string) => files.find((f) => f.endsWith(ext));
  const [image, changes, sources] = [find(".image"), find(".changes"), find(".sources")];
  if (!image || !changes || !sources) return undefined;
  return {
    vm,
    image: path.join(imageDir, image),
    changes: path.join(imageDir, changes),
    sources: path.join(imageDir, sources),
  };
}

export function installedRuntime(): Runtime | undefined {
  return locate(RUNTIME_DIR);
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Downloads the VM and base image into the agent dir, once, and answers where they are. */
export async function installRuntime(onProgress: (message: string) => void): Promise<Runtime> {
  const existing = installedRuntime();
  if (existing) return existing;

  const { vmZip, imageZip } = platform();
  // Assemble beside the final location and rename at the end, so an interrupted
  // download never looks installed.
  const staging = `${RUNTIME_DIR}.partial-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    const unzip = promisify(execFile);
    for (const [zip, dir] of [
      [vmZip, "vm"],
      [imageZip, "image"],
    ]) {
      onProgress(`Downloading ${zip}…`);
      const archive = path.join(staging, zip);
      await download(`${FILES_URL}/${zip}`, archive);
      await unzip("unzip", ["-q", archive, "-d", path.join(staging, dir)]);
      fs.rmSync(archive);
    }
    if (!locate(staging)) throw new Error(`Unexpected layout in ${FILES_URL} archives`);
    fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
    fs.renameSync(staging, RUNTIME_DIR);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  return installedRuntime()!;
}

/**
 * Answers the project's image, copying it from the base image on first use. The
 * sources file is shared through a symlink; Pharo finds it next to the image.
 */
export function projectImage(runtime: Runtime, dir: string): string {
  const image = path.join(dir, "pi.image");
  if (fs.existsSync(image)) return image;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
  const sources = path.join(dir, path.basename(runtime.sources));
  if (!fs.existsSync(sources)) fs.symlinkSync(runtime.sources, sources);
  fs.copyFileSync(runtime.changes, path.join(dir, "pi.changes"));
  // Image last: its presence is what marks the project as set up.
  fs.copyFileSync(runtime.image, `${image}.tmp`);
  fs.renameSync(`${image}.tmp`, image);
  return image;
}
