import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";

import { ApiClient } from "@twurple/api";
import { EventSubWsListener } from "@twurple/eventsub-ws";
import {
  RefreshingAuthProvider,
  getTokenInfo,
  exchangeCode,
  generateCodeVerifier,
  generateCodeChallenge
} from "@twurple/auth";

const {
  PORT = "3000",
  PUBLIC_BASE_URL,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  BROADCASTER_LOGIN,
  SONG_REQUEST_REWARD_ID,
  TOKEN_FILE = "./tokens.json",
  MAX_DURATION_SECONDS = "480",
  PER_USER_COOLDOWN_SECONDS = "60"
} = process.env;

if (!PUBLIC_BASE_URL) throw new Error("Missing PUBLIC_BASE_URL in .env");
if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) throw new Error("Missing Twitch client credentials");
if (!BROADCASTER_LOGIN) throw new Error("Missing BROADCASTER_LOGIN");
if (!SONG_REQUEST_REWARD_ID) {
  console.warn("WARNING: SONG_REQUEST_REWARD_ID is empty. The bot will ignore redemptions until you set it.");
}

const maxDuration = parseInt(MAX_DURATION_SECONDS, 10);
const cooldownSec = parseInt(PER_USER_COOLDOWN_SECONDS, 10);

// -------------------- Simple in-memory queue --------------------
/**
 * queue item shape (spotify-ready):
 * {
 *   id, requestedBy, query,
 *   source: "youtube",
 *   title, durationSec,
 *   platformIds: { youtubeVideoId, spotifyTrackId: null }
 * }
 */
const queue = [];
let nowPlaying = null;

// Per-user cooldown tracking
const lastRequestAt = new Map(); // userId -> timestamp(ms)

function canRequest(userId) {
  const last = lastRequestAt.get(userId) ?? 0;
  const now = Date.now();
  return (now - last) >= cooldownSec * 1000;
}

// -------------------- YouTube resolver via yt-dlp --------------------
function ytSearchOne(queryOrUrl) {
  return new Promise((resolve, reject) => {
    // If user pasted a full URL, yt-dlp can handle it directly.
    const target = queryOrUrl.includes("youtube.com") || queryOrUrl.includes("youtu.be")
      ? queryOrUrl
      : `ytsearch1:${queryOrUrl}`;

    const args = [
      "--dump-single-json",
      "--no-playlist",
      "--no-warnings",
      target
    ];

    const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";

    proc.stdout.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr.on("data", (d) => (err += d.toString("utf8")));

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp failed (${code}): ${err || out}`));
      }
      try {
        const json = JSON.parse(out);
        // When using ytsearch, yt-dlp often returns an object with "entries"
        const item = json.entries?.[0] ?? json;
        const videoId = item.id;
        const title = item.title;
        const durationSec = Number(item.duration ?? 0);

        if (!videoId || !title) return reject(new Error("No result found"));
        resolve({ videoId, title, durationSec });
      } catch (e) {
        reject(new Error(`Failed to parse yt-dlp output: ${e.message}`));
      }
    });
  });
}

// -------------------- Overlay websocket broadcast --------------------
function makeState() {
  return {
    nowPlaying,
    queue: queue.slice(0, 10)
  };
}

const app = express();
app.use(express.json());

// Serve overlay page
app.get("/overlay", (req, res) => {
  res.type("html").send(fs.readFileSync(path.join(process.cwd(), "overlay.html"), "utf8"));
});

// Simple health
app.get("/health", (req, res) => res.json({ ok: true }));

const server = app.listen(parseInt(PORT, 10), () => {
  console.log(`HTTP listening on :${PORT}`);
  console.log(`Overlay URL: ${PUBLIC_BASE_URL}/overlay`);
});

const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: makeState() }));
});

// Overlay calls this when a track ends
app.post("/ended", (req, res) => {
  // Move to next
  nowPlaying = null;
  playNextIfIdle();
  res.json({ ok: true });
});

// Manual skip (you can protect this behind a key if you want)
app.post("/skip", (req, res) => {
  nowPlaying = null;
  playNextIfIdle();
  res.json({ ok: true });
});

function playNextIfIdle() {
  if (nowPlaying) return;
  const next = queue.shift();
  if (!next) {
    broadcast("state", makeState());
    return;
  }
  nowPlaying = next;
  broadcast("state", makeState());
  broadcast("play", nowPlaying);
}

// -------------------- Twitch Auth (OAuth) + EventSub WS --------------------
function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), "utf8");
}

async function ensureAuthAndStart() {
  // If no tokens yet, do a one-time OAuth via browser.
  let tokenData = loadToken();

  const appBase = new URL(PUBLIC_BASE_URL);
  const redirectUri = `${appBase.origin}/twitch/callback`;

  const scopes = [
    "channel:read:redemptions",
    "channel:manage:redemptions" // optional but recommended for fulfill/cancel
  ];

  // OAuth helper endpoints
  let codeVerifier = null;
  let codeChallenge = null;

  app.get("/twitch/login", (req, res) => {
    codeVerifier = generateCodeVerifier();
    codeChallenge = generateCodeChallenge(codeVerifier);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: TWITCH_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: scopes.join(" "),
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    });

    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
  });

  app.get("/twitch/callback", async (req, res) => {
    try {
      const code = req.query.code?.toString();
      if (!code) return res.status(400).send("Missing code");
      if (!codeVerifier) return res.status(400).send("Missing code verifier (restart login)");

      const token = await exchangeCode(TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, code, redirectUri, codeVerifier);
      saveToken(token);
      res.send("✅ Authorized. You can close this tab and restart the bot process.");
      console.log("Saved tokens to", TOKEN_FILE);
    } catch (e) {
      console.error(e);
      res.status(500).send(`Auth failed: ${e.message}`);
    }
  });

  if (!tokenData) {
    console.log("No tokens found.");
    console.log(`Open this URL in your browser to authorize: ${PUBLIC_BASE_URL}/twitch/login`);
    console.log("After authorizing, restart the bot (npm start).");
    return;
  }

  // Create auth provider with auto-refresh
  const authProvider = new RefreshingAuthProvider(
    {
      clientId: TWITCH_CLIENT_ID,
      clientSecret: TWITCH_CLIENT_SECRET,
      onRefresh: (newTokenData) => saveToken(newTokenData)
    },
    tokenData
  );

  // Quick sanity check
  const info = await getTokenInfo(authProvider);
  console.log("Token user:", info.userName, "scopes:", info.scopes);

  const apiClient = new ApiClient({ authProvider });

  const broadcaster = await apiClient.users.getUserByName(BROADCASTER_LOGIN);
  if (!broadcaster) throw new Error(`Broadcaster not found: ${BROADCASTER_LOGIN}`);

  console.log("Broadcaster ID:", broadcaster.id);

  // Start EventSub WS listener
  const listener = new EventSubWsListener({ apiClient });
  await listener.start();

  // Subscribe to redemption events
  listener.onChannelRewardRedemptionAdd(broadcaster.id, async (event) => {
    try {
      if (SONG_REQUEST_REWARD_ID && event.rewardId !== SONG_REQUEST_REWARD_ID) return;

      const userId = event.userId;
      const userName = event.userName;
      const input = (event.input ?? "").trim();

      if (!input) {
        // Cancel empty redemption (refund points)
        await apiClient.channelPoints.updateRedemptionStatusByIds(
          broadcaster.id,
          event.rewardId,
          [event.id],
          "CANCELED"
        );
        return;
      }

      if (!canRequest(userId)) {
        await apiClient.channelPoints.updateRedemptionStatusByIds(
          broadcaster.id,
          event.rewardId,
          [event.id],
          "CANCELED"
        );
        return;
      }

      // Resolve YouTube
      const { videoId, title, durationSec } = await ytSearchOne(input);

      if (durationSec && durationSec > maxDuration) {
        await apiClient.channelPoints.updateRedemptionStatusByIds(
          broadcaster.id,
          event.rewardId,
          [event.id],
          "CANCELED"
        );
        return;
      }

      // Prevent duplicates (same video already queued/playing)
      const already =
        (nowPlaying?.platformIds?.youtubeVideoId === videoId) ||
        queue.some((q) => q.platformIds.youtubeVideoId === videoId);

      if (already) {
        await apiClient.channelPoints.updateRedemptionStatusByIds(
          broadcaster.id,
          event.rewardId,
          [event.id],
          "CANCELED"
        );
        return;
      }

      lastRequestAt.set(userId, Date.now());

      const item = {
        id: `q_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        requestedBy: userName,
        query: input,
        source: "youtube",
        title,
        durationSec: durationSec || null,
        platformIds: { youtubeVideoId: videoId, spotifyTrackId: null }
      };

      queue.push(item);

      // Mark redemption as fulfilled (accepted into queue)
      await apiClient.channelPoints.updateRedemptionStatusByIds(
        broadcaster.id,
        event.rewardId,
        [event.id],
        "FULFILLED"
      );

      broadcast("state", makeState());
      playNextIfIdle();

      console.log(`+ queued: ${title} (by ${userName})`);
    } catch (e) {
      console.error("Redemption handler error:", e);
      // If something blew up, safest is cancel so viewer gets points back
      try {
        await apiClient.channelPoints.updateRedemptionStatusByIds(
          broadcaster.id,
          event.rewardId,
          [event.id],
          "CANCELED"
        );
      } catch {}
    }
  });

  console.log("✅ EventSub WS listening for channel point redemptions.");
}

ensureAuthAndStart().catch((e) => {
  console.error(e);
  process.exit(1);
});
