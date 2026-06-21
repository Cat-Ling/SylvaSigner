import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rootDir } from "./toolchain.mjs";

for (const variant of ["zsign", "zsign-mobile"]) {
  const modulePath = path.join(rootDir, "public", "wasm", `${variant}.mjs`);
  const wasmPath = path.join(rootDir, "public", "wasm", `${variant}.wasm`);
  if (!existsSync(modulePath) || !existsSync(wasmPath)) {
    throw new Error(`Missing public/wasm/${variant} artifacts. Run \`npm run build:wasm\` first.`);
  }

  const logs = [];
  const createZsignModule = (await import(`${pathToFileURL(modulePath).href}?smoke=${Date.now()}`)).default;
  const mod = await createZsignModule({
    noInitialRun: true,
    wasmBinary: readFileSync(wasmPath),
    locateFile(file) {
      return path.join(rootDir, "public", "wasm", file);
    },
    print(line) {
      logs.push(line);
    },
    printErr(line) {
      logs.push(line);
    }
  });

  const code = mod.callMain(["-v"]);
  const text = logs.join("\n");
  if (code !== 0 || !text.includes("version:")) {
    console.error(text);
    throw new Error(`Unexpected ${variant} -v result: ${code}`);
  }
  console.log(`${variant}: ${text}`);
}

console.log("Desktop and mobile-native WASM smoke tests passed.");
