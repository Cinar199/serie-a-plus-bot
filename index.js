const express = require("express");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const CONTROL_SECRET = process.env.CONTROL_SECRET;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "openrouter/auto";

const matches = new Map();

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------
// YETKİ KONTROLÜ
// --------------------------------------------------

function authorized(req, res, next) {
  const auth = req.get("Authorization") || "";

  if (!CONTROL_SECRET || auth !== `Bearer ${CONTROL_SECRET}`) {
    return res.status(401).json({
      error: "Yetkisiz istek."
    });
  }

  next();
}

// --------------------------------------------------
// DISCORD KANAL KONTROLÜ
// --------------------------------------------------

function validChannelId(value) {
  return (
    typeof value === "string" &&
    /^\d{17,20}$/.test(value.trim())
  );
}

// --------------------------------------------------
// DISCORD MESAJ GÖNDERME
// Her maç kendi kanalına mesaj gönderir.
// --------------------------------------------------

async function sendDiscord(channelId, content) {
  if (!DISCORD_BOT_TOKEN) {
    console.error("DISCORD_BOT_TOKEN tanımlanmamış.");
    return false;
  }

  if (!validChannelId(channelId)) {
    console.error("Geçersiz Discord kanal ID'si.");
    return false;
  }

  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content: String(content).slice(0, 1900),
          allowed_mentions: {
            parse: []
          }
        })
      }
    );

    if (!response.ok) {
      const details = await response.text();

      console.error(
        "Discord mesaj hatası:",
        response.status,
        details
      );

      return false;
    }

    return true;
  } catch (error) {
    console.error(
      "Discord bağlantı hatası:",
      error.message
    );

    return false;
  }
}

// Her maçın kendi kanalına mesaj gönderir.
async function sendGameDiscord(game, content) {
  return sendDiscord(
    game.channelId,
    `${matchTag(game)}\n${content}`
  );
}

// --------------------------------------------------
// YAPAY ZEKÂ SPİKERİ
// --------------------------------------------------

async function aiCommentary(instruction, fallback) {
  if (!OPENROUTER_API_KEY) {
    return fallback;
  }

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [
            {
              role: "system",
              content:
                "Sen Serie A+ futbol spikerisin. Türkçe, doğal ve heyecanlı anlat. " +
                "Verilen takım, oyuncu, dakika ve skoru değiştirme. " +
                "Yeni oyuncu veya olay uydurma. En fazla iki cümle yaz."
            },
            {
              role: "user",
              content: instruction
            }
          ],
          max_tokens: 120,
          temperature: 0.8
        })
      }
    );

    const data = await response.json();

    return (
      data.choices?.[0]?.message?.content?.trim() ||
      fallback
    );
  } catch (error) {
    console.error(
      "OpenRouter hatası:",
      error.message
    );

    return fallback;
  }
}

// --------------------------------------------------
// MAÇ YARDIMCI FONKSİYONLARI
// --------------------------------------------------

function getMatch(matchId) {
  if (
    typeof matchId !== "string" ||
    !matchId.trim()
  ) {
    return null;
  }

  return (
    matches.get(matchId.trim().toUpperCase()) ||
    null
  );
}

function teamFor(game, side) {
  if (!game) return null;

  const value = String(side || "").toLowerCase();

  if (["ev", "home"].includes(value)) {
    return game.homeTeam;
  }

  if (
    ["dep", "deplasman", "away"].includes(value)
  ) {
    return game.awayTeam;
  }

  return null;
}

function activePlayers(team) {
  return team.players.filter(
    (player) => player.active
  );
}

function randomItem(items) {
  if (!items.length) return null;

  return items[
    Math.floor(Math.random() * items.length)
  ];
}

function scoreText(game) {
  return (
    `${game.homeTeam.emoji} **${game.homeTeam.name} ${game.homeScore} - ` +
    `${game.awayScore} ${game.awayTeam.name}** ${game.awayTeam.emoji}`
  );
}

function matchTag(game) {
  return `🆔 \`${game.id}\``;
}

function isRunning(game) {
  return (
    matches.get(game.id) === game &&
    game.running
  );
}

// --------------------------------------------------
// ORTAK MAÇ OLAYI MESAJI
// --------------------------------------------------

async function sendMatchEvent(
  game,
  team,
  description
) {
  if (!isRunning(game)) return;

  const message =
    `### 📢 BİLGİ | ${game.minute}'\n\n` +
    `${scoreText(game)}\n\n` +
    `> ${team.emoji} <:futbolcu:1504904247551201441> ` +
    `**${game.minute}'** | ${description}\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`;

  await sendGameDiscord(game, message);
}

async function announceEvent(
  game,
  team,
  instruction,
  fallback
) {
  if (!isRunning(game)) return;

  const commentary = await aiCommentary(
    instruction,
    fallback
  );

  if (isRunning(game)) {
    await sendMatchEvent(
      game,
      team,
      commentary
    );
  }
}

// --------------------------------------------------
// OTOMATİK MAÇ OLAYLARI
// --------------------------------------------------

async function automaticEvent(game) {
  const home = game.homeTeam;
  const away = game.awayTeam;

  const homePlayers = activePlayers(home);
  const awayPlayers = activePlayers(away);

  if (
    !homePlayers.length ||
    !awayPlayers.length
  ) {
    return;
  }

  const attackingHome = Math.random() < 0.5;

  const team = attackingHome ? home : away;
  const opponent = attackingHome ? away : home;

  const attackers = attackingHome
    ? homePlayers
    : awayPlayers;

  const player = randomItem(attackers);
  const event = Math.random();

  if (!player) return;

  // GOL
  if (event < 0.14) {
    if (attackingHome) {
      game.homeScore++;
    } else {
      game.awayScore++;
    }

    const fallback =
      `⚽ **GOOOOL!** ${player.name} golü attı!`;

    const commentary = await aiCommentary(
      `${game.minute}. dakika. Golü atan oyuncu: ${player.name}. ` +
      `Takım: ${team.name}. Güncel skor: ${home.name} ` +
      `${game.homeScore} - ${game.awayScore} ${away.name}. ` +
      `Heyecanlı Türkçe gol anlatımı yaz. ` +
      `Oyuncu adını ve skoru değiştirme.`,
      fallback
    );

    await sendMatchEvent(
      game,
      team,
      `⚽ **GOOOOL!** ${commentary} | Golü atan: **${player.name}**`
    );

    await sleep(20000);
    return;
  }

  // KORNER
  if (event < 0.34) {
    await announceEvent(
      game,
      team,
      `${game.minute}. dakika. ${player.name}, ${team.name} oyuncusu. ` +
      `Korner kullanılıyor, savunma topu uzaklaştırıyor.`,
      `**${player.name}** korneri kullandı, savunma topu uzaklaştırdı.`
    );

    return;
  }

  // ATAK
  if (event < 0.65) {
    await announceEvent(
      game,
      team,
      `${game.minute}. dakika. ${player.name} topu ileri taşıyor. ` +
      `${opponent.name} savunması baskı yapıyor.`,
      `**${player.name}** topu ileri taşıyor, ` +
      `${opponent.name} savunması baskı yapıyor.`
    );

    return;
  }

  // SARI KART VE İKİNCİ SARI
  if (event < 0.75) {
    player.yellow++;

    if (player.yellow >= 2) {
      player.active = false;
      player.red = true;

      await sendMatchEvent(
        game,
        team,
        `🟥 **${player.name}** ikinci sarı karttan kırmızı kart gördü!`
      );
    } else {
      await sendMatchEvent(
        game,
        team,
        `🟨 **${player.name}** sarı kart gördü.`
      );
    }

    return;
  }

  // KALECİ KURTARIŞI
  if (event < 0.88) {
    await announceEvent(
      game,
      team,
      `${game.minute}. dakika. ${player.name} kaleyi yokluyor.`,
      `**${player.name}** şutunu çekti, kaleci topu kurtardı!`
    );

    return;
  }

  // SAVUNMA
  const defenders = activePlayers(opponent);
  const defender = randomItem(defenders);

  if (!defender) return;

  await sendMatchEvent(
    game,
    opponent,
    `**${defender.name}** rakip atağını karşıladı ve topu uzaklaştırdı.`
  );
}

// --------------------------------------------------
// MAÇ MOTORU
// Her maç bağımsız çalışır.
// --------------------------------------------------

async function runMatch(game) {
  if (!isRunning(game)) return;

  await sendGameDiscord(
    game,
    `### 📢 BİLGİ | MAÇ BAŞLADI\n\n` +
    `${scoreText(game)}\n\n` +
    `> 🏟️ İlk düdük çaldı!\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  while (
    isRunning(game) &&
    game.minute < 90
  ) {
    await sleep(5000);

    if (!isRunning(game)) return;

    game.minute++;

    // DEVRE ARASI
    if (game.minute === 45) {
      await sendGameDiscord(
        game,
        `### 📢 BİLGİ | DEVRE ARASI\n\n` +
        `${scoreText(game)}\n\n` +
        `> ⏸️ İlk 45 dakika tamamlandı. ` +
        `İkinci yarı 60 saniye sonra başlayacak.\n` +
        `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
      );

      await sleep(60000);

      if (!isRunning(game)) return;

      await sendGameDiscord(
        game,
        `### 📢 BİLGİ | İKİNCİ YARI\n\n` +
        `${scoreText(game)}\n\n` +
        `> ▶️ İkinci yarı başladı!\n` +
        `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
      );

      continue;
    }

    if (game.minute % 2 === 0) {
      await automaticEvent(game);
    }
  }

  if (!isRunning(game)) return;

  game.running = false;
  game.finished = true;

  const fallback =
    `🏁 Karşılaşma sona erdi. Son skor: ` +
    `${game.homeTeam.name} ${game.homeScore} - ` +
    `${game.awayScore} ${game.awayTeam.name}.`;

  const report = await aiCommentary(
    `Maç sona erdi. Ev sahibi ${game.homeTeam.name}, ` +
    `deplasman ${game.awayTeam.name}. Son skor: ` +
    `${game.homeScore}-${game.awayScore}. ` +
    `Türkçe kısa maç sonu raporu yaz. Skoru değiştirme.`,
    fallback
  );

  await sendGameDiscord(
    game,
    `### 📢 BİLGİ | MAÇ SONU\n\n` +
    `${scoreText(game)}\n\n` +
    `> ${report}\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );
}

// --------------------------------------------------
// SAĞLIK KONTROLÜ
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    online: true,
    project: "Serie A+",
    multiMatch: true,
    channelSelection: true
  });
});

// --------------------------------------------------
// MAÇ DURUMU
// --------------------------------------------------

app.get("/status", (req, res) => {
  const id = req.query.matchId;

  if (id) {
    const game = getMatch(String(id));

    if (!game) {
      return res.status(404).json({
        error: "Maç bulunamadı."
      });
    }

    return res.json({
      matchId: game.id,
      channelId: game.channelId,
      running: game.running,
      waitingForLineups:
        game.running && !game.started,
      finished: game.finished,
      minute: game.minute,
      score: {
        home: game.homeScore,
        away: game.awayScore
      },
      home: game.homeTeam.name,
      away: game.awayTeam.name
    });
  }

  res.json({
    activeMatches: [...matches.values()]
      .filter((game) => game.running)
      .map((game) => ({
        matchId: game.id,
        channelId: game.channelId,
        home: game.homeTeam.name,
        away: game.awayTeam.name,
        running: game.running,
        waitingForLineups: !game.started,
        minute: game.minute,
        score: `${game.homeScore}-${game.awayScore}`
      }))
  });
});

// --------------------------------------------------
// MAÇ BAŞLAT / OLUŞTUR
// Aynı anda birden fazla maç açılabilir.
// --------------------------------------------------

app.post("/start", authorized, async (req, res) => {
  const {
    home,
    away,
    homeEmoji,
    awayEmoji,
    channelId
  } = req.body || {};

  if (
    ![home, away, homeEmoji, awayEmoji].every(
      (value) =>
        typeof value === "string" &&
        value.trim()
    )
  ) {
    return res.status(400).json({
      error:
        "home, away, homeEmoji ve awayEmoji alanları zorunludur."
    });
  }

  if (!validChannelId(channelId)) {
    return res.status(400).json({
      error:
        "Geçerli bir Discord kanal ID'si gönderilmelidir."
    });
  }

  let id;

  do {
    id = crypto.randomBytes(3)
      .toString("hex")
      .toUpperCase();
  } while (matches.has(id));

  const game = {
    id,
    channelId: channelId.trim(),
    running: true,
    started: false,
    finished: false,
    minute: 0,
    homeScore: 0,
    awayScore: 0,

    homeTeam: {
      name: home.trim(),
      emoji: homeEmoji.trim(),
      players: []
    },

    awayTeam: {
      name: away.trim(),
      emoji: awayEmoji.trim(),
      players: []
    }
  };

  // Maçı diğer maçlardan bağımsız kaydet.
  matches.set(id, game);

  const sent = await sendGameDiscord(
    game,
    `### 📢 BİLGİ | MAÇ OLUŞTURULDU\n\n` +
    `${scoreText(game)}\n\n` +
    `> 📋 Kadroları girmek için maç ID'si: \`${id}\`\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  return res.status(200).json({
    success: true,
    started: false,
    waitingForLineups: true,
    matchId: id,
    channelId: game.channelId,
    home: game.homeTeam.name,
    away: game.awayTeam.name,
    messageSent: sent,
    message: sent
      ? "Maç oluşturuldu; kadrolar bekleniyor."
      : "Maç oluşturuldu ancak Discord kanalına mesaj gönderilemedi. Botun kanal izinlerini kontrol et."
  });
});

// --------------------------------------------------
// KADRO GİR
// Şu an 11 oyuncu kabul edilir.
// --------------------------------------------------

app.post("/lineup", authorized, async (req, res) => {
  const {
    matchId,
    side,
    players
  } = req.body || {};

  const game = getMatch(matchId);

  if (
    !game ||
    !game.running ||
    game.started
  ) {
    return res.status(400).json({
      error:
        "Maç bulunamadı, durduruldu veya kadrolar zaten tamamlandı."
    });
  }

  const team = teamFor(game, side);

  if (!team) {
    return res.status(400).json({
      error: "taraf ev veya dep olmalıdır."
    });
  }

  if (
    !Array.isArray(players) ||
    players.length !== 11 ||
    players.some(
      (name) =>
        typeof name !== "string" ||
        !name.trim()
    )
  ) {
    return res.status(400).json({
      error: "Tam olarak 11 oyuncu adı girilmelidir."
    });
  }

  team.players = players.map((name) => ({
    name: name.trim(),
    active: true,
    yellow: 0,
    red: false
  }));

  await sendGameDiscord(
    game,
    `### 📢 BİLGİ | KADRO KAYDEDİLDİ\n\n` +
    `${team.emoji} **${team.name}**\n` +
    team.players
      .map(
        (player, index) =>
          `${index + 1}. ${player.name}`
      )
      .join("\n") +
    `\n-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  if (
    game.homeTeam.players.length === 11 &&
    game.awayTeam.players.length === 11
  ) {
    game.started = true;

    runMatch(game).catch((error) => {
      console.error(
        `Maç ${game.id} hatası:`,
        error
      );
    });

    return res.json({
      success: true,
      saved: true,
      matchStarted: true,
      matchId: game.id,
      channelId: game.channelId,
      message: "İki kadro tamamlandı; maç başladı."
    });
  }

  return res.json({
    success: true,
    saved: true,
    matchStarted: false,
    matchId: game.id,
    channelId: game.channelId,
    message:
      "Kadro kaydedildi. Diğer takımın kadrosu bekleniyor."
  });
});

// --------------------------------------------------
// OYUNCU DEĞİŞİKLİĞİ
// Giren oyuncunun kayıtlı ve yedek olması gerekir.
// --------------------------------------------------

app.post("/substitution", authorized, async (req, res) => {
  const {
    matchId,
    side,
    outPlayer,
    inPlayer
  } = req.body || {};

  const game = getMatch(matchId);

  if (
    !game ||
    !game.running ||
    !game.started
  ) {
    return res.status(400).json({
      error: "Aktif maç bulunamadı."
    });
  }

  const team = teamFor(game, side);

  if (
    !team ||
    typeof outPlayer !== "string" ||
    typeof inPlayer !== "string" ||
    !outPlayer.trim() ||
    !inPlayer.trim()
  ) {
    return res.status(400).json({
      error:
        "matchId, taraf, cikan ve giren alanları zorunludur."
    });
  }

  const outgoing = team.players.find(
    (player) =>
      player.active &&
      player.name.toLowerCase() ===
        outPlayer.trim().toLowerCase()
  );

  const incoming = team.players.find(
    (player) =>
      !player.active &&
      !player.red &&
      player.name.toLowerCase() ===
        inPlayer.trim().toLowerCase()
  );

  if (!outgoing) {
    return res.status(400).json({
      error: "Çıkan oyuncu sahada değil."
    });
  }

  if (!incoming) {
    return res.status(400).json({
      error:
        "Giren oyuncu kadroda bulunmalı ve yedek olmalıdır."
    });
  }

  outgoing.active = false;
  incoming.active = true;

  await sendGameDiscord(
    game,
    `### 📢 BİLGİ | ${game.minute}'\n\n` +
    `${scoreText(game)}\n\n` +
    `> ${team.emoji} <:futbolcu:1504904247551201441> ` +
    `**${game.minute}'** | 🔄 **${outgoing.name}** çıktı, ` +
    `**${incoming.name}** oyuna girdi.\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  return res.json({
    success: true,
    matchId: game.id
  });
});

// --------------------------------------------------
// ELLE KART VER
// --------------------------------------------------

app.post("/card", authorized, async (req, res) => {
  const {
    matchId,
    side,
    player: playerName,
    type
  } = req.body || {};

  const game = getMatch(matchId);

  if (
    !game ||
    !game.running ||
    !game.started
  ) {
    return res.status(400).json({
      error: "Aktif maç bulunamadı."
    });
  }

  const team = teamFor(game, side);

  if (
    !team ||
    typeof playerName !== "string" ||
    !playerName.trim() ||
    !["sari", "kirmizi"].includes(type)
  ) {
    return res.status(400).json({
      error:
        "matchId, taraf, oyuncu ve tur (sari/kirmizi) gereklidir."
    });
  }

  const player = team.players.find(
    (p) =>
      p.active &&
      p.name.toLowerCase() ===
        playerName.trim().toLowerCase()
  );

  if (!player) {
    return res.status(400).json({
      error:
        "Oyuncu bu takımda sahada bulunamadı."
    });
  }

  let message;

  if (
    type === "kirmizi" ||
    player.yellow >= 1
  ) {
    player.red = true;
    player.active = false;

    message =
      `🟥 **${player.name}** kırmızı kart gördü ve oyun dışı kaldı!`;
  } else {
    player.yellow++;

    message =
      `🟨 **${player.name}** sarı kart gördü.`;
  }

  await sendGameDiscord(
    game,
    `### 📢 BİLGİ | ${game.minute}'\n\n` +
    `${scoreText(game)}\n\n` +
    `> ${team.emoji} <:futbolcu:1504904247551201441> ` +
    `**${game.minute}'** | ${message}\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  return res.json({
    success: true,
    matchId: game.id
  });
});

// ---------------ing(id));

    if (!game) {
      return res.status(404).json({
        error: "Maç bulunamadı."
      });
    }

    return res.json({
      matchId: game.id,
      channelId: game.channelId,
      running: game.running,
      waitingForLineups: game.running && !game.started,
      finished: game.finished,
      minute: game.minute,
      score: {
        home: game.homeScore,
        away: game.awayScore
      },
      home: game.homeTeam.name,
      away: game.awayTeam.name
    });
  }

  res.json({
    activeMatches: [...matches.values()]
      .filter((game) => game.running)
      .map((game) => ({
        matchId: game.id,
        channelId: game.channelId,
        home: game.homeTeam.name,
        away: game.awayTeam.name,
        running: game.running,
        waitingForLineups: !game.started,
        minute: game.minute,
        score: `${game.homeScore}-${game.awayScore}`
      }))
  });
});

// Yeni maç oluşturur ve seçilen kanala bağlar.
app.post("/start", authorized, async (req, res) => {
  const {
    home,
    away,
    homeEmoji,
    awayEmoji,
    channelId
  } = req.body || {};

  if (
    ![home, away, homeEmoji, awayEmoji].every(
      (value) => typeof value === "string" && value.trim()
    )
  ) {
    return res.status(400).json({
      error: "home, away, homeEmoji ve awayEmoji zorunludur."
    });
  }

  if (!validChannelId(channelId)) {
    return res.status(400).json({
      error: "Geçerli bir Discord kanal ID'si girilmelidir."
    });
  }

  const id = crypto.randomBytes(3).toString("hex").toUpperCase();

  const game = {
    id,
    channelId: channelId.trim(),
    running: true,
    started: false,
    finished: false,
    minute: 0,
    homeScore: 0,
    awayScore: 0,
    homeTeam: {
      name: home.trim(),
      emoji: homeEmoji.trim(),
      players: []
    },
    awayTeam: {
      name: away.trim(),
      emoji: awayEmoji.trim(),
      players: []
    }
  };

  matches.set(id, game);

  const sent = await sendGameDiscord(
    game,
    `### 📢 BİLGİ | MAÇ OLUŞTURULDU\n\n` +
    `${scoreText(game)}\n\n` +
    `> 📋 Kadroları girmek için maç ID'si: \`${id}\`\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  res.json({
    started: true,
    waitingForLineups: true,
    matchId: id,
    channelId: game.channelId,
    home: game.homeTeam.name,
    away: game.awayTeam.name,
    messageSent: sent,
    message: sent
      ? "Maç oluşturuldu; kadrolar bekleniyor."
      : "Maç oluşturuldu ancak kanala mesaj gönderilemedi. Bot izinlerini kontrol et."
  });
});

// Maça 11 oyunculuk kadro kaydeder.
app.post("/lineup", authorized, async (req, res) => {
  const { matchId, side, players } = req.body || {};
  const game = getMatch(matchId);

  if (!game || !game.running || game.started) {
    return res.status(400).json({
      error: "Maç bulunamadı, durduruldu veya kadrolar tamamlandı."
    });
  }

  const team = teamFor(game, side);

  if (!team) {
    return res.status(400).json({
      error: "taraf ev veya dep olmalıdır."
    });
  }

  if (
    !Array.isArray(players) ||
    players.length !== 11 ||
    players.some(
      (name) => typeof name !== "string" || !name.trim()
    )
  ) {
    return res.status(400).json({
      error: "Tam olarak 11 oyuncu adı girilmelidir."
    });
  }

  team.players = players.map((name) => ({
    name: name.trim(),
    active: true,
    yellow: 0,
    red: false
  }));

  await sendGameDiscord(
    game,
    `### 📢 BİLGİ | KADRO KAYDEDİLDİ\n\n` +
    `${team.emoji} **${team.name}**\n` +
    team.players
      .map((player, index) => `${index + 1}. ${player.name}`)
      .join("\n") +
    `\n-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  if (
    game.homeTeam.players.length === 11 &&
    game.awayTeam.players.length === 11
  ) {
    game.started = true;

    runMatch(game).catch((error) =>
      console.error(`Maç ${game.id} hatası:`, error)
    );

    return res.json({
      saved: true,
      matchStarted: true,
      matchId: game.id,
      channelId: game.channelId,
      message: "İki kadro tamamlandı; maç başladı."
    });
  }

  res.json({
    saved: true,
    matchStarted: false,
    matchId: game.id,
    channelId: game.channelId,
    message: "Kadro kaydedildi. Diğer takımın kadrosu bekleniyor."
  });
});

// Oyuncu değişikliği
app.post("/substitution", authorized, async (req, res) => {
  const { matchId, side, outPlayer, inPlayer } = req.body || {};
  const game = getMatch(matchId);

  if (!game || !game.running || !game.started) {
    return res.status(400).json({
      error: "Aktif maç bulunamadı."
    });
  }

  const team = teamFor(game, side);

  if (!team || !outPlayer?.trim() || !inPlayer?.trim()) {
    return res.status(400).json({
      error: "matchId, taraf, cikan ve giren zorunludur."
    });
  }

  const outgoing = team.players.find(
    (player) =>
      player.active &&
      player.name.toLowerCase() === outPlayer.trim().toLowerCase()
  );

  const incoming = team.players.find(
    (player) =>
      !player.active &&
      !player.red &&
      player.name.toLowerCase() === inPlayer.trim().toLowerCase()
  );

  if (!outgoing) {
    return res.status(400).json({
      error: "Çıkan oyuncu sahada değil."
    });
  }

  if (!incoming) {
    return res.status(400).json({
      error: "Giren oyuncu kadroda bulunmalı ve yedek olmalıdır."
    });
  }

  outgoing.active = false;
  incoming.active = true;

  await sendGameDiscord(
    game,
    `### 📢 BİLGİ | ${game.minute}'\n\n` +
    `${scoreText(game)}\n\n` +
    `> ${team.emoji} <:futbolcu:1504904247551201441> ` +
    `**${game.minute}'** | 🔄 **${outgoing.name}** çıktı, ` +
    `**${incoming.name}** oyuna girdi.\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  res.json({ success: true, matchId: game.id });
});

// Elle kart verme
app.post("/card", authorized, async (req, res) => {
  const {
    matchId,
    side,
    player: playerName,
    type
  } = req.body || {};

  const game = getMatch(matchId);

  if (!game || !game.running || !game.started) {
    return res.status(400).json({
      error: "Aktif maç bulunamadı."
    });
  }

  const team = teamFor(game, side);

  if (
    !team ||
    typeof playerName !== "string" ||
    !playerName.trim() ||
    !["sari", "kirmizi"].includes(type)
  ) {
    return res.status(400).json({
      error: "matchId, taraf, oyuncu ve tur (sari/kirmizi) gereklidir."
    });
  }

  const player = team.players.find(
    (p) =>
      p.active &&
      p.name.toLowerCase() === playerName.trim().toLowerCase()
  );

  if (!player) {
    return res.status(400).json({
      error: "Oyuncu bu takımda sahada bulunamadı."
    });
  }

  let message;

  if (type === "kirmizi" || player.yellow >= 1) {
    player.red = true;
    player.active = false;
    message =
      `🟥 **${player.name}** kırmızı kart gördü ve oyun dışı kaldı!`;
  } else {
    player.yellow++;
    message = `🟨 **${player.name}** sarı kart gördü.`;
  }

  await sendGameDiscord(
    game,
    `### 📢 BİLGİ | ${game.minute}'\n\n` +
    `${scoreText(game)}\n\n` +
    `> ${team.emoji} <:futbolcu:1504904247551201441> ` +
    `**${game.minute}'** | ${message}\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  res.json({ success: true, matchId: game.id });
});

// Yalnızca belirtilen maçı durdurur.
app.post("/stop", authorized, async (req, res) => {
  const game = getMatch(req.body?.matchId);

  if (!game || !game.running) {
    return res.status(404).json({
      stopped: false,
      error: "Bu ID ile devam eden maç bulunamadı."
    });
  }

  game.running = false;

  await sendGameDiscord(
    game,
    `### 📢 BİLGİ | MAÇ DURDURULDU\n\n` +
    `${scoreText(game)}\n\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  res.json({ stopped: true, matchId: game.id });
});

app.use((err, req, res, next) => {
  console.error("İstek hatası:", err.message);

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      error: "İstek gövdesi geçersiz.",
      type: err.type
    });
  }

  res.status(500).json({ error: "Sunucu hatası." });
});

app.listen(PORT, () => {
  console.log(`Serie A+ botu ${PORT} portunda çalışıyor.`);
}); } = req.body || {};

  if (![home, away, homeEmoji, awayEmoji].every(
    (value) => typeof value === "string" && value.trim()
  )) {
    return res.status(400).json({
      error: "home, away, homeEmoji ve awayEmoji alanları zorunludur."
    });
  }

  const id = crypto.randomBytes(3).toString("hex").toUpperCase();

  const game = {
    id,
    running: true,
    started: false,
    finished: false,
    minute: 0,
    homeScore: 0,
    awayScore: 0,
    homeTeam: {
      name: home.trim(),
      emoji: homeEmoji.trim(),
      players: []
    },
    awayTeam: {
      name: away.trim(),
      emoji: awayEmoji.trim(),
      players: []
    }
  };

  matches.set(id, game);

  await sendDiscord(
    `${matchTag(game)}\n` +
    `### 📢 BİLGİ | MAÇ OLUŞTURULDU\n\n${scoreText(game)}\n\n` +
    `> 📋 Kadroları girmek için maç ID'si: \`${id}\`\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  res.json({
    started: true,
    waitingForLineups: true,
    matchId: id,
    home: game.homeTeam.name,
    away: game.awayTeam.name,
    message: "Maç oluşturuldu; kadrolar bekleniyor."
  });
});

// Maça 11 oyunculuk kadro kaydeder.
app.post("/lineup", authorized, async (req, res) => {
  const { matchId, side, players } = req.body || {};
  const game = getMatch(matchId);

  if (!game || !game.running || game.started) {
    return res.status(400).json({
      error: "Maç bulunamadı, durduruldu veya kadrolar zaten tamamlandı."
    });
  }

  const team = teamFor(game, side);

  if (!team) {
    return res.status(400).json({ error: "taraf ev veya dep olmalıdır." });
  }

  if (
    !Array.isArray(players) ||
    players.length !== 11 ||
    players.some((name) => typeof name !== "string" || !name.trim())
  ) {
    return res.status(400).json({
      error: "Tam olarak 11 oyuncu adı girilmelidir."
    });
  }

  team.players = players.map((name) => ({
    name: name.trim(),
    active: true,
    yellow: 0,
    red: false
  }));

  await sendDiscord(
    `${matchTag(game)}\n` +
    `### 📢 BİLGİ | KADRO KAYDEDİLDİ\n\n` +
    `${team.emoji} **${team.name}**\n` +
    team.players.map((p, i) => `${i + 1}. ${p.name}`).join("\n") +
    `\n-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  if (
    game.homeTeam.players.length === 11 &&
    game.awayTeam.players.length === 11
  ) {
    game.started = true;

    runMatch(game).catch((error) =>
      console.error(`Maç ${game.id} hatası:`, error)
    );

    return res.json({
      saved: true,
      matchStarted: true,
      matchId: game.id,
      message: "İki kadro tamamlandı; maç başladı."
    });
  }

  res.json({
    saved: true,
    matchStarted: false,
    matchId: game.id,
    message: "Kadro kaydedildi. Diğer takımın kadrosu bekleniyor."
  });
});

// Oyuncu değişikliği
app.post("/substitution", authorized, async (req, res) => {
  const { matchId, side, outPlayer, inPlayer } = req.body || {};
  const game = getMatch(matchId);

  if (!game || !game.running || !game.started) {
    return res.status(400).json({ error: "Aktif maç bulunamadı." });
  }

  const team = teamFor(game, side);

  if (!team || !outPlayer?.trim() || !inPlayer?.trim()) {
    return res.status(400).json({
      error: "matchId, taraf, cikan ve giren alanları zorunludur."
    });
  }

  const outgoing = team.players.find(
    (p) => p.active &&
      p.name.toLowerCase() === outPlayer.trim().toLowerCase()
  );

  const incoming = team.players.find(
    (p) => !p.active && !p.red &&
      p.name.toLowerCase() === inPlayer.trim().toLowerCase()
  );

  if (!outgoing) {
    return res.status(400).json({
      error: "Çıkan oyuncu sahada değil."
    });
  }

  if (!incoming) {
    return res.status(400).json({
      error: "Giren oyuncu kadroda bulunmalı ve yedek olmalıdır."
    });
  }

  outgoing.active = false;
  incoming.active = true;

  await sendDiscord(
    `${matchTag(game)}\n` +
    `### 📢 BİLGİ | ${game.minute}'\n\n${scoreText(game)}\n\n` +
    `> ${team.emoji} <:futbolcu:1504904247551201441> ` +
    `**${game.minute}'** | 🔄 **${outgoing.name}** çıktı, ` +
    `**${incoming.name}** oyuna girdi.\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  res.json({ success: true, matchId: game.id });
});

// Elle kart verme
app.post("/card", authorized, async (req, res) => {
  const { matchId, side, player: playerName, type } = req.body || {};
  const game = getMatch(matchId);

  if (!game || !game.running || !game.started) {
    return res.status(400).json({ error: "Aktif maç bulunamadı." });
  }

  const team = teamFor(game, side);

  if (
    !team ||
    !playerName?.trim() ||
    !["sari", "kirmizi"].includes(type)
  ) {
    return res.status(400).json({
      error: "matchId, taraf, oyuncu ve tur (sari/kirmizi) gereklidir."
    });
  }

  const player = team.players.find(
    (p) => p.active &&
      p.name.toLowerCase() === playerName.trim().toLowerCase()
  );

  if (!player) {
    return res.status(400).json({
      error: "Oyuncu bu takımda sahada bulunamadı."
    });
  }

  let message;

  if (type === "kirmizi" || player.yellow >= 1) {
    player.red = true;
    player.active = false;
    message = `🟥 **${player.name}** kırmızı kart gördü ve oyun dışı kaldı!`;
  } else {
    player.yellow++;
    message = `🟨 **${player.name}** sarı kart gördü.`;
  }

  await sendDiscord(
    `${matchTag(game)}\n` +
    `### 📢 BİLGİ | ${game.minute}'\n\n${scoreText(game)}\n\n` +
    `> ${team.emoji} <:futbolcu:1504904247551201441> ` +
    `**${game.minute}'** | ${message}\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  res.json({ success: true, matchId: game.id });
});

// Yalnızca belirtilen maçı durdurur.
app.post("/stop", authorized, async (req, res) => {
  const game = getMatch(req.body?.matchId);

  if (!game || !game.running) {
    return res.status(404).json({
      stopped: false,
      error: "Bu ID ile devam eden maç bulunamadı."
    });
  }

  game.running = false;

  await sendDiscord(
    `${matchTag(game)}\n` +
    `### 📢 BİLGİ | MAÇ DURDURULDU\n\n${scoreText(game)}\n\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  res.json({ stopped: true, matchId: game.id });
});

app.use((err, req, res, next) => {
  console.error("İstek hatası:", err.message);

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      error: "İstek gövdesi geçersiz.",
      type: err.type
    });
  }

  res.status(500).json({ error: "Sunucu hatası." });
});

app.listen(PORT, () => {
  console.log(`Serie A+ botu ${PORT} portunda çalışıyor.`);
});  message: "İki kadro tamamlandı; maç anlatımı başladı."
    });
  }

  res.json({
    saved: true,
    matchStarted: false,
    message: "Kadro kaydedildi. Diğer takımın kadrosu bekleniyor."
  });
});

app.post("/substitution", authorized, async (req, res) => {
  if (!match?.running || !match.started) {
    return res.status(400).json({ error: "Aktif maç bulunamadı." });
  }

  const { side, outPlayer, inPlayer } = req.body || {};
  const team = teamFor(side);

  if (!team || !outPlayer?.trim() || !inPlayer?.trim()) {
    return res.status(400).json({
      error: "taraf, cikan ve giren alanları zorunludur."
    });
  }

  const outgoing = team.players.find(
    (p) => p.active && p.name.toLowerCase() === outPlayer.trim().toLowerCase()
  );
  const incoming = team.players.find(
    (p) => !p.active && !p.red &&
      p.name.toLowerCase() === inPlayer.trim().toLowerCase()
  );

  if (!outgoing) {
    return res.status(400).json({
      error: "Çıkan oyuncu sahada bulunamadı."
    });
  }

  if (!incoming) {
    return res.status(400).json({
      error: "Giren oyuncu kadroda, yedek durumda olmalıdır."
    });
  }

  outgoing.active = false;
  incoming.active = true;

  const text =
    `🔄 **OYUNCU DEĞİŞİKLİĞİ | ${match.minute}'.**\n` +
    `${team.emoji} ${team.name}\n⬅️ Çıkan: **${outgoing.name}**\n` +
    `➡️ Giren: **${incoming.name}**\n${scoreText()}`;

  await sendDiscord(text);
  res.json({ success: true, message: "Oyuncu değişikliği yapıldı." });
});

app.post("/card", authorized, async (req, res) => {
  if (!match?.running || !match.started) {
    return res.status(400).json({ error: "Aktif maç bulunamadı." });
  }

  const { side, player: playerName, type } = req.body || {};
  const team = teamFor(side);

  if (!team || !playerName?.trim() || !["sari", "kirmizi"].includes(type)) {
    return res.status(400).json({
      error: "taraf, oyuncu ve tur (sari/kirmizi) alanları gereklidir."
    });
  }

  const player = team.players.find(
    (p) => p.active &&
      p.name.toLowerCase() === playerName.trim().toLowerCase()
  );

  if (!player) {
    return res.status(400).json({
      error: "Oyuncu bu takımda sahada bulunamadı."
    });
  }

  let cardText;

  if (type === "kirmizi" || player.yellow >= 1) {
    player.red = true;
    player.active = false;
    cardText = `🟥 **KIRMIZI KART!** ${player.name}, ${team.name} oyuncusu, oyun dışı!`;
  } else {
    player.yellow++;
    cardText = `🟨 **SARI KART!** ${player.name}, ${team.name} oyuncusu sarı kart gördü.`;
  }

  await sendDiscord(
    `${cardText}\n⏱️ ${match.minute}'. dakika\n${scoreText()}`
  );

  res.json({ success: true, message: "Kart işlendi." });
});

app.post("/stop", authorized, async (req, res) => {
  if (!match?.running) {
    return res.json({ stopped: true, message: "Aktif maç yok." });
  }

  const oldMatch = match;
  oldMatch.running = false;

  await sendDiscord(
    `⏹️ **MAÇ DURDURULDU**\n${scoreText()}`
  );

  res.json({ stopped: true, message: "Maç durduruldu." });
});

app.use((err, req, res, next) => {
  console.error("İstek hatası:", err.message);

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      error: "İstek gövdesi geçersiz.",
      type: err.type
    });
  }

  res.status(500).json({ error: "Sunucu hatası." });
});

app.listen(PORT, () => {
  console.log(`Serie A+ botu ${PORT} portunda çalışıyor.`);
});
