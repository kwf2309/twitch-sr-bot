// index.js (ESM)
import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";

import { ApiClient } from "@twurple/api";
import { EventSubWsListener } from "@twurple/eventsub-ws";
import { RefreshingAuthProvider, exchangeCode, getTokenInfo } from "@twurple/auth";

// -------------------- ENV --------------------
const {
  PORT = "3000",
  PUBLIC_BASE_URL,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  BROADCASTER_LOGIN,
  SONG_REQUEST_REWARD_ID = "",
  TOKEN_FILE = "./tokens.json",
  MAX_DURATION_SECONDS = "480",
  PER_USER_COOLDOWN_SECONDS = "60",
} = process.env;

if (!PUBLIC_BASE_URL) throw new Error("Missing PUBLIC_BASE_URL in .env");
if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) throw new Error("Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET in .env");
if (!BROADCASTER_LOGIN) throw new Error("Missing BROADCASTER_LOGIN in .env");

const maxDuration = parseInt(MAX_DURATION_SECONDS, 10);
const cooldownSec = parseInt(PER_USER_COOLDOWN_SECONDS, 10);

// -------------------- TOKEN STORAGE --------------------
function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), "utf8");
}

// -------------------- SIMPLE QUEUE --------------------
const queue = [];
let nowPlaying = null;

// per-user cooldown tracking
const lastRequestAt = new Map(); // userId -> ms timestamp
function canRequest(userId) {
  const last = lastRequestAt.get(userId) ?? 0;
  return Date.now() - last >= cooldownSec * 1000;
}

// -------------------- YOUTUBE RESOLVER (yt-dlp) --------------------
function ytSearchOne(queryOrUrl) {
  return new Promise((resolve, reject) => {
    const looksLikeUrl =
      queryOrUrl.includes("youtube.com") ||
      queryOrUrl.includes("youtu.be") ||
      queryOrUrl.startsWith("http://") ||
      queryOrUrl.startsWith("https://");

    const target = looksLikeUrl ? queryOrUrl : `ytsearch1:${queryOrUrl}`;

    const args = [
      "--dump-single-json",
      "--no-playlist",
      "--no-warnings",
      target,
    ];

    const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";

    proc.stdout.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr.on("data", (d) => (err += d.toString("utf8")));

    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`yt-dlp failed (${code}): ${err || out}`));

      try {
        const json = JSON.parse(out);
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

// -------------------- EXPRESS + OVERLAY WS --------------------
const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/overlay", (req, res) => {
  const overlayPath = path.join(process.cwd(), "overlay.html");
  if (!fs.existsSync(overlayPath)) {
    return res.status(500).send("overlay.html not found next to index.js");
  }
  res.type("html").send(fs.readFileSync(overlayPath, "utf8"));
});

// overlay tells us when video ended
app.post("/ended", (req, res) => {
  nowPlaying = null;
  playNextIfIdle();
  res.json({ ok: true });
});

// manual skip (optional)
app.post("/skip", (req, res) => {
  nowPlaying = null;
  playNextIfIdle();
  res.json({ ok: true });
});

const server = app.listen(parseInt(PORT, 10), () => {
  console.log(`HTTP listening on :${PORT}`);
  console.log(`Overlay URL: ${PUBLIC_BASE_URL}/overlay`);
});

const wss = new WebSocketServer({ server, path: "/ws" });

function makeState() {
  return {
    nowPlaying,
    queue: queue.slice(0, 10),
  };
}

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", payload: makeState() }));
});

function playNextIfIdle() {
  if (nowPlaying) {
    broadcast("state", makeState());
    return;
  }
  const next = queue.shift();
  nowPlaying = next || null;

  broadcast("state", makeState());
  if (nowPlaying) broadcast("play", nowPlaying);
}

// -------------------- TWITCH OAUTH ROUTES --------------------
const redirectUri = `${new URL(PUBLIC_BASE_URL).origin}/twitch/callback`;
const scopes = ["channel:read:redemptions", "channel:manage:redemptions"];

app.get("/twitch/login", (req, res) => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
  });

  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
});

app.get("/twitch/callback", async (req, res) => {
  try {
    const code = req.query.code?.toString();
    if (!code) return res.status(400).send("Missing code");

    const token = await exchangeCode(
      TWITCH_CLIENT_ID,
      TWITCH_CLIENT_SECRET,
      code,
      redirectUri
    );

    // Twurple wants an obtainmentTimestamp for refresh logic
    token.obtainmentTimestamp = Date.now();

    saveToken(token);
    console.log("Saved tokens to", TOKEN_FILE);

    res.send("✅ Authorized. You can close this tab and restart the bot process.");
  } catch (e) {
    console.error("Auth failed:", e);
    res.status(500).send(`Auth failed: ${e.message}`);
  }
});

// -------------------- TWITCH EVENTSUB (WS) --------------------
async function startTwitch() {
  const tokenData = loadToken();

  if (!tokenData) {
    console.log("No tokens found.");
    console.log(`Open this URL in your browser to authorize: ${PUBLIC_BASE_URL}/twitch/login`);
    console.log("After authorizing, restart the bot (npm start).");
    return;
  }

  // validate token properly (access token string!)
  try {
    const info = await getTokenInfo(tokenData.accessToken);
    console.log("Token scopes:", info.scopes);
  } catch (e) {
    console.error("Token validate failed. Delete tokens.json and re-authorize.");
    throw e;
  }

  const authProvider = new RefreshingAuthProvider(
    {
      clientId: TWITCH_CLIENT_ID,
      clientSecret: TWITCH_CLIENT_SECRET,
      onRefresh: (newTokenData) => saveToken(newTokenData),
    },
    tokenData
  );

  const apiClient = new ApiClient({ authProvider });

  const broadcaster = await apiClient.users.getUserByName(BROADCASTER_LOGIN);
  if (!broadcaster) throw new Error(`Broadcaster not found: ${BROADCASTER_LOGIN}`);

  console.log("Broadcaster ID:", broadcaster.id);

  const listener = new EventSubWsListener({ apiClient });
  await listener.start();

  console.log("Subscribing to channel point redemption events...");

  await listener.subscribeToChannelPointsCustomRewardRedemptionAddEvents(
    broadcaster.id,
    (event) => {
     handleRedemption(event).catch((e) => console.error("Redemption error:", e));
   }
  );

  console.log("✅ Subscribed. Waiting for channel point redemptions...");


  // -------- Redemption handler (shared) --------
  async function handleRedemption(event) {
    const userId = event.userId;
    const userName = event.userName;
    const input = (event.input ?? "").trim();

    // reward debug (helps you grab the reward id)
    console.log("REWARD NAME:", event.rewardTitle);
    console.log("REWARD ID:", event.rewardId);
    console.log("INPUT:", input);

    // If you haven't set SONG_REQUEST_REWARD_ID yet, keep it open so you can see it.
    // Once you set it, only the chosen reward will be accepted.
    if (SONG_REQUEST_REWARD_ID && event.rewardId !== SONG_REQUEST_REWARD_ID) {
      return;
    }

    // empty input => refund
    if (!input) {
      await apiClient.channelPoints.updateRedemptionStatusByIds(
        broadcaster.id,
        event.rewardId,
        [event.id],
        "CANCELED"
      );
      return;
    }

    // cooldown => refund
    if (!canRequest(userId)) {
      await apiClient.channelPoints.updateRedemptionStatusByIds(
        broadcaster.id,
        event.rewardId,
        [event.id],
        "CANCELED"
      );
      return;
    }

    // resolve youtube
    let resolved;
    try {
      resolved = await ytSearchOne(input);
    } catch {
      await apiClient.channelPoints.updateRedemptionStatusByIds(
        broadcaster.id,
        event.rewardId,
        [event.id],
        "CANCELED"
      );
      return;
    }

    const { videoId, title, durationSec } = resolved;

    // duration cap => refund
    if (durationSec && durationSec > maxDuration) {
      await apiClient.channelPoints.updateRedemptionStatusByIds(
        broadcaster.id,
        event.rewardId,
        [event.id],
        "CANCELED"
      );
      return;
    }

    // duplicates => refund
    const already =
      nowPlaying?.platformIds?.youtubeVideoId === videoId ||
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
      platformIds: { youtubeVideoId: videoId, spotifyTrackId: null },
    };

    queue.push(item);

    // accept redemption
    await apiClient.channelPoints.updateRedemptionStatusByIds(
      broadcaster.id,
      event.rewardId,
      [event.id],
      "FULFILLED"
    );

    broadcast("state", makeState());
    playNextIfIdle();

    console.log(`+ queued: ${title} (by ${userName})`);
  }

  // -------- Subscribe to redemption events (AUTO-DETECT for Twurple) --------
  // Twurple WS listener has had naming differences across versions/builds.
  // We detect the best available handler.
  const candidates = [
    "onChannelRewardRedemptionAdd",
    "onChannelPointsCustomRewardRedemptionAdd",
    "onChannelChannelPointsCustomRewardRedemptionAdd",
    "onChannelChannelPointsCustomRewardRedemptionAddV2",
  ];

  const found = candidates.find((name) => typeof listener[name] === "function");

  if (found) {
    console.log(`Using listener.${found}() for redemptions`);
    listener[found](broadcaster.id, (event) => {
      handleRedemption(event).catch((e) => console.error("Redemption error:", e));
    });
  } else {
    // Fallback: print available methods so you can see what your build supports
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(listener)).sort();
    console.error("Could not find a redemption handler method on EventSubWsListener.");
    console.error("Available listener methods:\n" + methods.join("\n"));
    throw new Error("EventSubWsListener redemption handler method not available in this build.");
  }

  console.log("✅ EventSub WS listener started. Waiting for channel point redemptions...");
}

startTwitch().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
