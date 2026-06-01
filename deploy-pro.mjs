import fs from "node:fs";
import path from "node:path";

const token = process.env.VERCEL_TOKEN;
const teamId = process.env.VERCEL_TEAM_ID || "team_PR3WVWq1OllFG0qODrsah0o0";
const projectName = process.env.VERCEL_PROJECT || "kbk-theta-accumulation-pro";
const root = process.cwd();
const include = ["index.html", "build.mjs", "package.json", "vercel.json", "assets", "legacy", "api"];

if (!token) {
  console.error("Missing VERCEL_TOKEN. Set it first, then run: node deploy-pro.mjs");
  process.exit(1);
}

function walk(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) return [];
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    return fs.readdirSync(absolutePath).flatMap((entry) => walk(path.join(relativePath, entry)));
  }
  return [relativePath.replace(/\\/g, "/")];
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload).slice(0, 1200)}`);
  }
  return payload;
}

const files = include.flatMap(walk).map((file) => ({
  file,
  data: fs.readFileSync(path.join(root, file)).toString("base64"),
  encoding: "base64",
}));

console.log(`Uploading ${files.length} files to ${projectName}`);

const deployment = await api(`https://api.vercel.com/v13/deployments?teamId=${teamId}`, {
  method: "POST",
  body: JSON.stringify({
    name: projectName,
    project: projectName,
    target: "production",
    files,
    projectSettings: {
      buildCommand: "node build.mjs",
      outputDirectory: "dist",
      framework: null,
    },
  }),
});

console.log(`Deployment ${deployment.id}: https://${deployment.url}`);

for (let attempt = 1; attempt <= 90; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const status = await api(`https://api.vercel.com/v13/deployments/${deployment.id}?teamId=${teamId}`);
  console.log(`${attempt}: ${status.readyState || status.state || status.status}`);
  if (status.readyState === "READY") {
    console.log(`Ready: https://${deployment.url}`);
    process.exit(0);
  }
  if (["ERROR", "CANCELED"].includes(status.readyState)) {
    throw new Error(`Deployment failed: ${status.readyState}`);
  }
}

throw new Error("Deployment polling timed out");
