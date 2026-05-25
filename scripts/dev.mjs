import { spawn } from "node:child_process";

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
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5174"], {
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
