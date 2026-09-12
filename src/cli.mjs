import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { ensureServer, request } from "./client.mjs";

const [command = "help", argument] = process.argv.slice(2);
try {
  if (command === "init") {
    const config = loadConfig();
    console.log(JSON.stringify({
      configFile: `${config.dir}/config.json`,
      browserUrl: `ws://127.0.0.1:${config.port}/browser`,
      next: "Enter browserToken from config.json into the extension. Do not share controlToken."
    }, null, 2));
  } else if (command === "help") {
    console.log("Commands: init, start, stop, status, create/send/close/reopen <request.json>, result/wait/cancel <job-id>");
  } else if (command === "stop") {
    console.log(JSON.stringify(await request("shutdown", {})));
  } else {
    await ensureServer();
    if (command === "start" || command === "status")
      console.log(JSON.stringify(await request("status"), null, 2));
    else if (command === "result")
      console.log(JSON.stringify(await request(`jobs/${encodeURIComponent(argument)}`), null, 2));
    else if (["wait", "cancel"].includes(command))
      console.log(JSON.stringify(await request(command, { jobId: argument }), null, 2));
    else if (["create", "send", "close", "reopen"].includes(command)) {
      const input = JSON.parse(await readFile(argument, "utf8"));
      console.log(JSON.stringify(await request(command, input), null, 2));
    } else throw new Error("Unknown command. Use help.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
