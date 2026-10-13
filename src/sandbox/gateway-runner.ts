import { runGuestBrowserGateway } from "./guest-browser-gateway.js";
import * as http from "node:http";

let ready = false;
const status = http.createServer((request, response) => {
	if (request.url !== "/ready") { response.writeHead(404).end(); return; }
	response.writeHead(ready ? 200 : 503, { "content-type": "text/plain" }).end(ready ? "ready" : "waiting");
});
status.listen(7143, "127.0.0.1");

runGuestBrowserGateway((value) => { ready = value; }).catch((error: unknown) => {
	process.stderr.write(`secret gateway failed closed: ${error instanceof Error ? error.message : String(error)}\n`);
	status.close();
	process.exitCode = 1;
});
