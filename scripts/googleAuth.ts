/**
 * One-time Google OAuth consent for a profile's Gmail account.
 *
 *   npm run google-auth -- --profile vikrant
 *
 * Reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from .env, opens the consent
 * URL in your default browser (log in with the Gmail account this profile
 * SENDS from), and writes the token to data/google-token-<profile>.json.
 * Re-run any time to re-consent; the file is overwritten.
 */
import "dotenv/config";
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { config } from "../src/config.js";

const SCOPES = config.google.scopes.join(" ");

const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    console.error(
      `${name} is not set in .env — create a Desktop-app OAuth client in Google Cloud Console\n` +
        `(APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app)\n` +
        `and paste both values into .env first.`,
    );
    process.exit(1);
  }
  return v;
}

/**
 * How to hand a URL to the desktop's default browser, per platform.
 *
 * Explicitly NOT via `cmd /c start`: cmd.exe reads `&` as a command separator, so an
 * OAuth URL arrived truncated at its first parameter and Google rejected the request
 * with "Required parameter is missing: response_type". Quoting around that is
 * fiddly and easy to get wrong again; spawning the handler directly means the URL is
 * one argv entry with no shell left to reinterpret it.
 */
function browserCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (process.platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

function openBrowser(url: string): void {
  const { command, args } = browserCommand(url);
  // detached+unref so the browser-launcher child never keeps our event loop
  // alive (a lingering child handle triggers a libuv assert on Windows exit)
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  // A machine with no handler registered must not take the consent flow down with
  // it — the URL is printed above precisely so this stays optional.
  child.on("error", (err) => {
    console.log(
      `(couldn't open a browser automatically: ${err.message} — use the URL above)`,
    );
  });
  child.unref();
}

async function main(): Promise<void> {
  const profileId = argValue("--profile") ?? "default";
  const clientId = requiredEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requiredEnv("GOOGLE_CLIENT_SECRET");

  const server = createServer();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no server port");
  const redirectUri = `http://127.0.0.1:${address.port}`;

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    "&response_type=code" +
    `&scope=${encodeURIComponent(SCOPES)}` +
    "&access_type=offline" +
    "&prompt=consent";

  console.log(`\nConsenting profile: ${profileId}`);
  console.log(`Log in with the Gmail account this profile SENDS from.\n`);
  console.log(`If the browser doesn't open, visit:\n\n${authUrl}\n`);
  openBrowser(authUrl);

  const code = await new Promise<string>((res, rej) => {
    server.on("request", (req, resp) => {
      const url = new URL(req.url ?? "/", redirectUri);
      const c = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      resp.writeHead(200, { "content-type": "text/html" });
      resp.end(
        c
          ? "<h2>job-hunter: consent captured. you can close this tab.</h2>"
          : `<h2>job-hunter: consent failed (${err ?? "no code"}). check the terminal.</h2>`,
      );
      if (c) res(c);
      else rej(new Error(`consent denied: ${err ?? "no code in callback"}`));
    });
  });
  await new Promise<void>((res) => server.close(() => res()));

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    throw new Error(
      `token exchange failed: ${tokenResp.status} ${await tokenResp.text()}`,
    );
  }
  const parsed = TokenResponseSchema.parse(await tokenResp.json());

  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  const tokenPath = resolve(
    process.cwd(),
    `data/google-token-${profileId}.json`,
  );
  writeFileSync(
    tokenPath,
    JSON.stringify(
      {
        refresh_token: parsed.refresh_token,
        access_token: parsed.access_token,
        expiry: Date.now() + parsed.expires_in * 1000,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`\nToken written: ${tokenPath}`);
  console.log(
    `Verify the account: the drafts for profile "${profileId}" will be created in the`,
  );
  console.log(`Gmail account you just logged in with.`);
  // no process.exit() — a hard exit races tsx/esbuild's async handles on
  // Windows (libuv assert in win/async.c); let the drained loop end naturally
}

main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
