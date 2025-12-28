// index.js (ESM) - Twitch Channel Points Song Request (YouTube via yt-dlp) + OBS overlay
import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { spawn } from "child_process";

import { ApiClient } from "@twurple/api";
import { RefreshingAuthProvider, exchangeCode, getTokenInfo } from "@twurple/auth";

// -------------------- ENV --------------------
const {
  PORT = "3000",
  PUBLIC_BASE_URL,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  BROADCASTER_LOGIN,
  SONG_REQUEST_REWARD_ID = "", // optional (leave empty to log it once)
  TOKEN_FILE = "./tokens.json",
  MAX_DURATION_SECONDS = "480",
  PER_USER_COOLDOWN_SECONDS = "60",
} = process.env;

if (!PUBLIC_BASE_URL) throw new Error("Missing PUBLIC_BASE_URL in .env");
if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) throw new Error("Missing Twitch client credentials in .env");
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

// Always fetch the newest access token from disk (in case it refreshed)
function getLatestAccessToken() {
  const t = loadToken();
  return t?.accessToken || null;
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
    const args = ["--dump-single-json", "--no-playlist", "--no-warnings", target];

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
  if (!fs.existsSync(overlayPath)) return res.status(500).send("overlay.html not found next to index.js");
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
  return { nowPlaying, queue: queue.slice(0, 10) };
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

    const token = await exchangeCode(TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, code, redirectUri);
    token.obtainmentTimestamp = Date.now();

    saveToken(token);
    console.log("Saved tokens to", TOKEN_FILE);

    res.send("✅ Authorized. You can close this tab and restart the bot process.");
  } catch (e) {
    console.error("Auth failed:", e);
    res.status(500).send(`Auth failed: ${e.message}`);
  }
});

// -------------------- TWITCH EVENTSUB WS (native) --------------------
async function startTwitch() {
  const tokenData = loadToken();

  if (!tokenData) {
    console.log("No tokens found.");
    console.log(`Open this URL in your browser to authorize: ${PUBLIC_BASE_URL}/twitch/login`);
    console.log("After authorizing, restart the bot (npm start).");
    return;
  }

  const tokenStr = tokenData.accessToken;

  // validate token properly (access token string!)
  const info = await getTokenInfo(tokenStr);
  console.log("Token scopes:", info.scopes);

  // ✅ multi-user RefreshingAuthProvider mode
  const authProvider = new RefreshingAuthProvider({
    clientId: TWITCH_CLIENT_ID,
    clientSecret: TWITCH_CLIENT_SECRET,
    onRefresh: (userId, newTokenData) => {
      // we only store one broadcaster token file, so just overwrite it
      saveToken(newTokenData);
    },
  });

  // ✅ register this token as a user token in the provider
  // This gives Twurple the required "user context" so channelPoints calls work.
  const broadcasterUserId = await authProvider.addUserForToken(tokenData, scopes);

  // ✅ Create ApiClient with the broadcaster user context
  const apiClient = new ApiClient({ authProvider });

  // confirm broadcaster matches login
  const broadcaster = await apiClient.users.getUserByName(BROADCASTER_LOGIN);
  if (!broadcaster) throw new Error(`Broadcaster not found: ${BROADCASTER_LOGIN}`);
  console.log("Broadcaster ID:", broadcaster.id);

  if (broadcasterUserId !== broadcaster.id) {
    console.warn(
      `Warning: token user (${broadcasterUserId}) != broadcaster user (${broadcaster.id}). Make sure you authorized the correct Twitch account.`
    );
  }

  // Connect to Twitch EventSub WebSocket (native)
  await connectEventSubWs({
    apiClient,
    broadcasterId: broadcaster.id,
    tokenStr,
  });
}

async function connectEventSubWs({ apiClient, broadcasterId, tokenStr }) {
  const ws = new WebSocket("wss://eventsub.wss.twitch.tv/ws");

  ws.on("open", () => console.log("EventSub WS connected."));
  ws.on("close", (code, reason) => console.error("EventSub WS closed:", code, reason?.toString?.() || ""));
  ws.on("error", (err) => console.error("EventSub WS error:", err));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }

    const type = msg?.metadata?.message_type;

    if (type === "session_welcome") {
      const sessionId = msg.payload.session.id;
      console.log("EventSub session id:", sessionId);

      const latest = getLatestAccessToken() || tokenStr;

      await createRedemptionSubscription({
        tokenStr: latest,
        broadcasterId,
        sessionId,
      });

      console.log("✅ Subscribed to channel point redemption events.");
      return;
    }

    if (type === "notification") {
      const subType = msg?.payload?.subscription?.type;
      if (subType === "channel.channel_points_custom_reward_redemption.add") {
        const ev = msg.payload.event;
        await handleRedemptionEvent({ apiClient, broadcasterId, ev });
      }
      return;
    }

    if (type === "session_reconnect") {
      console.log("EventSub told us to reconnect:", msg.payload.session.reconnect_url);
      ws.close();
      return;
    }

    if (type === "revocation") {
      console.warn("EventSub subscription revoked:", msg?.payload?.subscription);
      return;
    }
  });
}

async function createRedemptionSubscription({ tokenStr, broadcasterId, sessionId }) {
  const body = {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    condition: { broadcaster_user_id: broadcasterId },
    transport: { method: "websocket", session_id: sessionId },
  };

  const r = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
    method: "POST",
    headers: {
      "Client-Id": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${tokenStr}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Failed to create EventSub subscription: ${r.status} ${text}`);
  }
}

async function handleRedemptionEvent({ apiClient, broadcasterId, ev }) {
  const redemptionId = ev.id;
  const userId = ev.user_id;
  const userName = ev.user_name;
  const input = (ev.user_input ?? "").trim();
  const rewardId = ev.reward?.id;
  const rewardTitle = ev.reward?.title;

  console.log("REWARD NAME:", rewardTitle);
  console.log("REWARD ID:", rewardId);
  console.log("INPUT:", input);

  if (SONG_REQUEST_REWARD_ID && rewardId !== SONG_REQUEST_REWARD_ID) return;

  const setStatus = async (status) => {
    await apiClient.channelPoints.updateRedemptionStatusByIds(
      broadcasterId,
      rewardId,
      [redemptionId],
      status
    );
  };

  if (!input) return setStatus("CANCELED");
  if (!canRequest(userId)) return setStatus("CANCELED");

  let resolved;
  try {
    resolved = await ytSearchOne(input);
  } catch {
    return setStatus("CANCELED");
  }

  const { videoId, title, durationSec } = resolved;

  if (durationSec && durationSec > maxDuration) return setStatus("CANCELED");

  const already =
    nowPlaying?.platformIds?.youtubeVideoId === videoId ||
    queue.some((q) => q.platformIds.youtubeVideoId === videoId);

  if (already) return setStatus("CANCELED");

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

  await setStatus("FULFILLED");

  broadcast("state", makeState());
  playNextIfIdle();

  console.log(`+ queued: ${title} (by ${userName})`);
}

startTwitch().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
