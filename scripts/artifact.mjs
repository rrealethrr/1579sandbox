// Makes dist/artifact.html: the built page without its document skeleton, for publishing
// as a claude.ai Artifact (the host adds its own <html>/<head>/<body>).
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync("dist/index.html", "utf8");
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1].replace(/<meta[^>]*>\s*/g, "");
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
writeFileSync("dist/artifact.html", head.trim() + "\n" + body.trim() + "\n");
console.log("wrote dist/artifact.html");
