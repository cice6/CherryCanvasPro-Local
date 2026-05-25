import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

if(!existsSync("dist/index.html")){
  const build = spawnSync(npmCommand, ["run", "build"], { stdio: "inherit", shell: false });
  if(build.status !== 0) process.exit(build.status || 1);
}

const children = [
  spawn(process.execPath, ["server/dreamina-runtime.mjs"], {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      CHERRY_RUNTIME_PORT: process.env.CHERRY_RUNTIME_PORT || "8777",
      DREAMINA_CLI_PORT: process.env.DREAMINA_CLI_PORT || "18777",
    },
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "5174"], {
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  }),
];

const shutdown = (code = 0) => {
  for(const child of children){
    if(!child.killed) child.kill();
  }
  process.exit(code);
};

children.forEach(child => {
  child.on("exit", code => {
    if(code && code !== 0) shutdown(code);
  });
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
