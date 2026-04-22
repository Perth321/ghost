import {
  Client,
  GatewayIntentBits,
  Partials,
  AttachmentBuilder,
  ChannelType,
  type Guild,
  type VoiceChannel,
  type TextChannel,
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
const SCARY_AUDIO = join(ASSETS_DIR, "scary.mp3");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error("[ghost-bot] missing DISCORD_BOT_TOKEN");
  process.exit(1);
}

const VC_INTERVAL_MS = 20 * 60 * 1000;
const VC_STAY_MS = 25 * 1000;
const IMAGE_VISIBLE_MS = 30 * 1000;

function ensureScaryAudio(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (existsSync(SCARY_AUDIO)) return resolve();
    if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true });

    const args = [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=brown:amplitude=0.4:duration=25",
      "-af",
      "highpass=f=40,lowpass=f=550,tremolo=f=0.35:d=0.8,aecho=0.85:0.75:1100|1700:0.4|0.25,volume=1.6",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
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
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

function pickPopulatedVoiceChannel(guild: Guild): VoiceChannel | null {
  const candidates = guild.channels.cache
    .filter(
      (c): c is VoiceChannel =>
        c.type === ChannelType.GuildVoice &&
        c.members.filter((m) => !m.user.bot).size > 0,
    )
    .map((c) => c)
    .sort(
      (a, b) =>
        b.members.filter((m) => !m.user.bot).size -
        a.members.filter((m) => !m.user.bot).size,
    );
  return candidates[0] ?? null;
}

function pickSendableTextChannel(guild: Guild): TextChannel | null {
  const me = guild.members.me;
  if (!me) return null;
  const preferredNames = ["general", "ทั่วไป", "chat", "พูดคุย"];
  const all = guild.channels.cache.filter(
    (c): c is TextChannel =>
      c.type === ChannelType.GuildText &&
      c.permissionsFor(me)?.has(["SendMessages", "ViewChannel", "AttachFiles"]) === true,
  );
  for (const name of preferredNames) {
    const found = all.find((c) => c.name.toLowerCase().includes(name));
    if (found) return found;
  }
  if (guild.systemChannel && all.has(guild.systemChannel.id)) {
    return guild.systemChannel as TextChannel;
  }
  return all.first() ?? null;
}

async function hauntVoiceChannel(channel: VoiceChannel): Promise<void> {
  console.log(
    `[ghost-bot] haunting voice channel "${channel.name}" in "${channel.guild.name}"`,
  );

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    console.error("[ghost-bot] failed to connect to voice:", err);
    connection.destroy();
    return;
  }

  const player = createAudioPlayer();
  const resource = createAudioResource(SCARY_AUDIO, {
    inputType: StreamType.Arbitrary,
  });
  connection.subscribe(player);
  player.play(resource);

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, VC_STAY_MS);
    player.once(AudioPlayerStatus.Idle, () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  player.stop(true);
  connection.destroy();
  console.log(`[ghost-bot] left voice channel "${channel.name}"`);
}

async function runVoiceHaunt(): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      const vc = pickPopulatedVoiceChannel(guild);
      if (!vc) continue;
      await hauntVoiceChannel(vc);
    } catch (err) {
      console.error(`[ghost-bot] voice haunt error in ${guild.name}:`, err);
    }
  }
}

async function sendGhostImageToAllGuilds(): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      const ch = pickSendableTextChannel(guild);
      if (!ch) continue;
      const attachment = new AttachmentBuilder(GHOST_IMAGE, { name: "ghost.jpg" });
      const msg = await ch.send({
        content: "👁️",
        files: [attachment],
      });
      console.log(
        `[ghost-bot] sent ghost image in "${ch.name}" of "${guild.name}"`,
      );
      setTimeout(() => {
        msg.delete().catch((err) => {
          console.error("[ghost-bot] failed to delete ghost image:", err);
        });
      }, IMAGE_VISIBLE_MS);
    } catch (err) {
      console.error(`[ghost-bot] image haunt error in ${guild.name}:`, err);
    }
  }
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

client.once("clientReady", async () => {
  console.log(`[ghost-bot] online as ${client.user?.tag}`);

  setInterval(() => {
    runVoiceHaunt().catch((err) =>
      console.error("[ghost-bot] runVoiceHaunt error:", err),
    );
  }, VC_INTERVAL_MS);

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
