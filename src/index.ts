import {
  Client,
  GatewayIntentBits,
  Partials,
  AttachmentBuilder,
  ChannelType,
  Events,
  type Guild,
  type VoiceChannel,
  type TextChannel,
  type Message,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} from "@discordjs/voice";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const FFMPEG_BIN = "ffmpeg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ASSETS_DIR = join(__dirname, "..", "assets");
const GHOST_IMAGE = join(ASSETS_DIR, "ghost.jpg");
const KIM_IMAGE = join(ASSETS_DIR, "kim.jpg");
const KIM_TARGET = (process.env.KIM_TARGET || "kim").toLowerCase();
const SCARY_AUDIO = join(ASSETS_DIR, "scary.mp3");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error("[ghost-bot] missing DISCORD_BOT_TOKEN");
  process.exit(1);
}

// Voice haunt: random interval 10–20 minutes
const VC_INTERVAL_MIN_MS = 10 * 60 * 1000;
const VC_INTERVAL_MAX_MS = 20 * 60 * 1000;
const VC_FULL_STAY_MS = 25 * 1000; // when channel has people
const VC_PEEK_STAY_MS = 4 * 1000;  // empty channel — quick pop in & leave

// Random text image haunt: every 15–45 minutes pick an active text channel
const IMG_INTERVAL_MIN_MS = 15 * 60 * 1000;
const IMG_INTERVAL_MAX_MS = 45 * 60 * 1000;
const IMAGE_VISIBLE_MS = 30 * 1000;

// "Active channel" = had a non-bot message in the last N minutes
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

const SCARY_CAPTIONS = [
  "👁️",
  "อยู่ข้างหลังนายแน่ะ...",
  "หันมาสิ",
  "...",
  "ฉันเห็นนายนะ",
  "อย่าปิดไฟ",
  "เธอได้ยินมั้ย",
];

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom<T>(arr: T[]): T | null {
  if (arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)] ?? null;
}

function ensureScaryAudio(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (existsSync(SCARY_AUDIO)) return resolve();
    if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true });

    const args = [
      "-y",
      "-f", "lavfi",
      "-i", "anoisesrc=color=brown:amplitude=0.4:duration=25",
      "-af", "highpass=f=40,lowpass=f=550,tremolo=f=0.35:d=0.8,aecho=0.85:0.75:1100|1700:0.4|0.25,volume=1.6",
      "-ac", "2",
      "-ar", "48000",
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      SCARY_AUDIO,
    ];

    const proc = spawn(FFMPEG_BIN, args, { stdio: "ignore" });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// Tracks last activity timestamp per text channel id
const lastActivity = new Map<string, number>();

function botCanUseVoice(channel: VoiceChannel): boolean {
  const me = channel.guild.members.me;
  if (!me) return false;
  const perms = channel.permissionsFor(me);
  return perms?.has(["ViewChannel", "Connect", "Speak"]) === true;
}

function listAccessibleVoiceChannels(guild: Guild): VoiceChannel[] {
  return [
    ...guild.channels.cache
      .filter((c): c is VoiceChannel => c.type === ChannelType.GuildVoice)
      .values(),
  ].filter(botCanUseVoice);
}

function pickRandomVoiceChannel(
  guild: Guild,
): { channel: VoiceChannel; populated: boolean } | null {
  const all = listAccessibleVoiceChannels(guild);
  if (all.length === 0) return null;
  const populated = all.filter(
    (c) => c.members.filter((m) => !m.user.bot).size > 0,
  );

  // 70% chance to pick populated room when possible, otherwise any
  if (populated.length > 0 && Math.random() < 0.7) {
    const ch = pickRandom(populated);
    return ch ? { channel: ch, populated: true } : null;
  }
  const ch = pickRandom(all);
  if (!ch) return null;
  return {
    channel: ch,
    populated: ch.members.filter((m) => !m.user.bot).size > 0,
  };
}

function botCanSendInText(ch: TextChannel): boolean {
  const me = ch.guild.members.me;
  if (!me) return false;
  return (
    ch.permissionsFor(me)?.has([
      "ViewChannel",
      "SendMessages",
      "AttachFiles",
    ]) === true
  );
}

function pickActiveTextChannel(guild: Guild): TextChannel | null {
  const now = Date.now();
  const all = [
    ...guild.channels.cache
      .filter((c): c is TextChannel => c.type === ChannelType.GuildText)
      .values(),
  ].filter(botCanSendInText);

  const active = all.filter((c) => {
    const t = lastActivity.get(c.id);
    return t !== undefined && now - t <= ACTIVE_WINDOW_MS;
  });

  if (active.length > 0) return pickRandom(active);
  // fallback to any sendable channel
  return pickRandom(all);
}

async function hauntVoiceChannel(
  channel: VoiceChannel,
  populated: boolean,
): Promise<void> {
  const stay = populated ? VC_FULL_STAY_MS : VC_PEEK_STAY_MS;
  console.log(
    `[ghost-bot] ${populated ? "haunting" : "peeking"} "${channel.name}" in "${channel.guild.name}" for ${stay / 1000}s`,
  );

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: !populated, // muted on peek visits — no point playing to empty room
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    console.error("[ghost-bot] voice connect failed:", err);
    connection.destroy();
    return;
  }

  let player: ReturnType<typeof createAudioPlayer> | null = null;
  if (populated) {
    player = createAudioPlayer();
    const resource = createAudioResource(SCARY_AUDIO, {
      inputType: StreamType.Arbitrary,
    });
    connection.subscribe(player);
    player.play(resource);
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, stay);
    if (player) {
      player.once(AudioPlayerStatus.Idle, () => {
        clearTimeout(timeout);
        resolve();
      });
    }
  });

  if (player) player.stop(true);
  connection.destroy();
  console.log(`[ghost-bot] left "${channel.name}"`);
}

async function runVoiceHauntOnce(): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      const pick = pickRandomVoiceChannel(guild);
      if (!pick) continue;
      await hauntVoiceChannel(pick.channel, pick.populated);
    } catch (err) {
      console.error(`[ghost-bot] voice haunt error in ${guild.name}:`, err);
    }
  }
}

async function sendGhostImageRandom(): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      const ch = pickActiveTextChannel(guild);
      if (!ch) continue;
      const attachment = new AttachmentBuilder(GHOST_IMAGE, { name: "ghost.jpg" });
      const caption = pickRandom(SCARY_CAPTIONS) ?? "👁️";
      const msg = await ch.send({ content: caption, files: [attachment] });
      console.log(
        `[ghost-bot] sent ghost image in "${ch.name}" of "${guild.name}"`,
      );
      setTimeout(() => {
        msg.delete().catch((err) =>
          console.error("[ghost-bot] delete image error:", err),
        );
      }, IMAGE_VISIBLE_MS);
    } catch (err) {
      console.error(`[ghost-bot] image haunt error in ${guild.name}:`, err);
    }
  }
}

async function sendGhostImageToAllGuilds(): Promise<void> {
  // Used for the scheduled midnight / 1 AM bombardment — picks any sendable channel
  for (const guild of client.guilds.cache.values()) {
    try {
      const ch = pickActiveTextChannel(guild);
      if (!ch) continue;
      const attachment = new AttachmentBuilder(GHOST_IMAGE, { name: "ghost.jpg" });
      const msg = await ch.send({
        content: "👁️",
        files: [attachment],
      });
      console.log(
        `[ghost-bot] [scheduled] sent ghost image in "${ch.name}" of "${guild.name}"`,
      );
      setTimeout(() => {
        msg.delete().catch((err) =>
          console.error("[ghost-bot] delete image error:", err),
        );
      }, IMAGE_VISIBLE_MS);
    } catch (err) {
      console.error(`[ghost-bot] scheduled image error in ${guild.name}:`, err);
    }
  }
}

function scheduleRandomLoop(
  minMs: number,
  maxMs: number,
  fn: () => Promise<void>,
  label: string,
): void {
  const tick = () => {
    const delay = randomBetween(minMs, maxMs);
    console.log(
      `[ghost-bot] next ${label} in ${Math.round(delay / 1000 / 60)} min`,
    );
    setTimeout(async () => {
      try {
        await fn();
      } catch (err) {
        console.error(`[ghost-bot] ${label} task error:`, err);
      }
      tick();
    }, delay);
  };
  tick();
}

function msUntilNext(hour: number, minute = 0): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDailyAt(hour: number, fn: () => Promise<void> | void): void {
  const ms = msUntilNext(hour);
  console.log(
    `[ghost-bot] next ${hour}:00 haunt in ${Math.round(ms / 1000 / 60)} min`,
  );
  setTimeout(async () => {
    try {
      await fn();
    } catch (err) {
      console.error("[ghost-bot] scheduled task error:", err);
    }
    setInterval(
      () => {
        Promise.resolve(fn()).catch((err) =>
          console.error("[ghost-bot] interval task error:", err),
        );
      },
      24 * 60 * 60 * 1000,
    );
  }, ms);
}

client.on(Events.MessageCreate, (msg: Message) => {
  if (msg.author.bot) return;
  if (!msg.guildId) return;
  if (msg.channel.type !== ChannelType.GuildText) return;
  lastActivity.set(msg.channelId, Date.now());
});


async function dmKim(): Promise<void> {
  const captions = [
    "เจอกันคืนนี้นะ kim 👁️",
    "kim... หันมาสิ",
    "อยู่ข้างหลังเธอแล้ว kim",
    "อย่าปิดไฟนะ kim",
    "kim ฉันเห็นเธอ",
  ];
  const seen = new Set<string>();
  for (const [, guild] of client.guilds.cache) {
    try {
      const members = await guild.members.fetch();
      const matches = members.filter((m) => {
        if (m.user.bot) return false;
        const u = m.user.username?.toLowerCase() ?? "";
        const g = m.user.globalName?.toLowerCase() ?? "";
        const n = m.displayName?.toLowerCase() ?? "";
        return u.includes(KIM_TARGET) || g.includes(KIM_TARGET) || n.includes(KIM_TARGET);
      });
      for (const [, member] of matches) {
        if (seen.has(member.id)) continue;
        seen.add(member.id);
        try {
          const file = new AttachmentBuilder(KIM_IMAGE);
          const caption = pickRandom(captions) ?? "👁️";
          await member.send({ content: caption, files: [file] });
          console.log(`[ghost-bot] DM sent to ${member.user.tag} (kim match)`);
        } catch (err) {
          console.error(`[ghost-bot] failed to DM ${member.user.tag}:`, err);
        }
      }
    } catch (err) {
      console.error(`[ghost-bot] failed to fetch members for guild ${guild.name}:`, err);
    }
  }
  if (seen.size === 0) {
    console.log("[ghost-bot] no member matching kim found in any guild");
  }
}

client.once("clientReady", async () => {
  console.log(`[ghost-bot] online as ${client.user?.tag}`);

  dmKim().catch((err) => console.error("[ghost-bot] dmKim error:", err));

  scheduleRandomLoop(
    VC_INTERVAL_MIN_MS,
    VC_INTERVAL_MAX_MS,
    runVoiceHauntOnce,
    "voice haunt",
  );

  scheduleRandomLoop(
    IMG_INTERVAL_MIN_MS,
    IMG_INTERVAL_MAX_MS,
    sendGhostImageRandom,
    "image haunt",
  );

  scheduleDailyAt(0, sendGhostImageToAllGuilds);
  scheduleDailyAt(1, sendGhostImageToAllGuilds);
});

client.on("error", (err) => console.error("[ghost-bot] client error:", err));
process.on("unhandledRejection", (err) =>
  console.error("[ghost-bot] unhandledRejection:", err),
);

(async () => {
  try {
    await ensureScaryAudio();
    console.log("[ghost-bot] scary audio ready");
  } catch (err) {
    console.error("[ghost-bot] failed to prepare scary audio:", err);
  }
  await client.login(TOKEN);
})();
