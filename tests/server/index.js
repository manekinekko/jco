import { _appendEnv } from "@bytecodealliance/preview2-shim/cli";
import { _setPreopens } from "@bytecodealliance/preview2-shim/filesystem";
import { mkdtemp } from "node:fs/promises";
import { readFileSync, rmdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { $init, generate } from "../../obj/js-component-bindgen-component.js";
import { fork } from "node:child_process";

export const testDir = await mkdtemp(tmpdir());

await $init;

process.on("exit", () => {
  // send stop message to server process
  serverProcess.send(null);
  rmdirSync(testDir, { recursive: true });
});

const serverProcess = fork(
  fileURLToPath(import.meta.url.split("/").slice(0, -1).join("/")) +
    "/http-server.js"
);
serverProcess.on("error", (err) => {
  console.error("server process error", err);
});
const runningPromise = new Promise((resolve) =>
  serverProcess.on("message", resolve)
);

export async function createIncomingServer(serverName) {
  const componentPath = fileURLToPath(import.meta.url.split("/").slice(0, -2).join("/")) + `/rundir/${serverName}.component.wasm`;
  console.error("loading component " + componentPath);
  try {
    const component = readFileSync(componentPath);
    const { files } = generate(component, {
      name: "component",
      noTypescript: true,
      map: Object.entries({
        "wasi:cli/*": "@bytecodealliance/preview2-shim/cli#*",
        "wasi:clocks/*": "@bytecodealliance/preview2-shim/clocks#*",
        "wasi:filesystem/*": "@bytecodealliance/preview2-shim/filesystem#*",
        "wasi:http/*": "@bytecodealliance/preview2-shim/http#*",
        "wasi:io/*": "@bytecodealliance/preview2-shim/io#*",
        "wasi:random/*": "@bytecodealliance/preview2-shim/random#*",
        "wasi:sockets/*": "@bytecodealliance/preview2-shim/sockets#*",
      }),
    });
    symlinkSync(
      fileURLToPath(
        import.meta.url.split("/").slice(0, -3).join("/") + "/node_modules"
      ),
      testDir + "/node_modules"
    );
    writeFileSync(testDir + "/package.json", '{"type":"module"}');
    for (const [name, contents] of files) {
      writeFileSync(testDir + "/" + name, contents);
    }
    serverProcess.send(testDir + "/component.js");
    const authority = await runningPromise;
    return authority;
  } catch (e) {
    console.error(e);
    throw e.toString();
  }
}