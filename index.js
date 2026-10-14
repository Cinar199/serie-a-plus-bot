const express = require("express");
const crypto = require("crypto");

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

const app = express();

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

const PORT = process.env.PORT || 3000;
const CONTROL_SECRET = process.env.CONTROL_SECRET;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "openrouter/auto";

const matches = new Map();

const TEAMS = [
  "SSC Vincia",
  "AC Milan",
  "Internazionale Milan",
  "Juventus FC",
  "Vincia FC",
  "ACF Fiorentina",
  "AS Roma",
  "SS Lazio",
  "Genoa CFC",
  "Hajduk Split",
  "BSC Young Boys",
  "FC Basel",
  "US Torino",
  "Como 1907",
  "SS Carthage",
  "RB Salzburg",
  "SK Sturm Graz",
  "AS Monaco"
];

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      overall INTEGER NOT NULL CHECK (overall BETWEEN 1 AND 100),
      age INTEGER NOT NULL CHECK (age BETWEEN 1 AND 100),
      team VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("PostgreSQL oyuncu tablosu hazır.");
}

/* YETKİ KONTROLÜ */

function authorize(req, res, next) {
  const authorization = req.get("Authorization") || "";

  if (
    !CONTROL_SECRET ||
    authorization !== `Bearer ${CONTROL_SECRET}`
  ) {
    return res.status(401).json({
      success: false,
      error: "Yetkisiz istek."
    });
  }

  next();
}

/* MAÇ VE TAKIM YARDIMCILARI */

function getMatch(id) {
  if (typeof id !== "string") return null;
  return matches.get(id.trim().toUpperCase()) || null;
}

function getTeam(game, side) {
  const value = String(side || "").toLowerCase();

  if (["ev", "home"].includes(value)) {
    return game.homeTeam;
  }

  if (["dep", "deplasman", "away"].includes(value)) {
    return game.awayTeam;
  }

  return null;
}

function scoreText(game) {
  return (
    `${game.homeTeam.emoji} **${game.homeTeam.name} ` +
    `${game.homeScore} - ${game.awayScore} ` +
    `${game.awayTeam.name}** ${game.awayTeam.emoji}`
  );
}

function matchHeader(game) {
  return `🆔 Maç ID: \`${game.id}\``;
}

function isRunning(game) {
  return matches.get(game.id) === game && game.running;
}

/* DISCORD MESAJI */

async function sendDiscord(channelId, content) {
  if (!DISCORD_BOT_TOKEN) {
    console.error("DISCORD_BOT_TOKEN tanımlanmamış.");
    return false;
  }

  if (!/^\d{17,20}$/.test(String(channelId))) {
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
          allowed_mentions: { parse: [] }
        })
      }
    );

    if (!response.ok) {
      console.error(
        "Discord API hatası:",
        response.status,
        await response.text()
      );
      return false;
    }

    return true;
  } catch (error) {
    console.error("Discord bağlantı hatası:", error.message);
    return false;
  }
}

async function sendGameDiscord(game, content) {
  return sendDiscord(
    game.channelId,
    `${matchHeader(game)}\n${content}`
  );
}

/* YAPAY ZEKÂLI SPİKER */

async function aiCommentary(prompt, fallback) {
  if (!OPENROUTER_API_KEY) return fallback;

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
                "Sen Serie A+ Türkçe futbol spikerisin. " +
                "Kısa, doğal ve heyecanlı anlat. " +
                "Verilen oyuncu adlarını ve skoru değiştirme. " +
                "Yeni olay veya bilgi uydurma."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          max_tokens: 120,
          temperature: 0.7
        })
      }
    );

    if (!response.ok) {
      console.error(
        "OpenRouter hatası:",
        response.status,
        await response.text()
      );
      return fallback;
    }

    const data = await response.json();

    return (
      data.choices?.[0]?.message?.content?.trim() ||
      fallback
    );
  } catch (error) {
    console.error("AI bağlantı hatası:", error.message);
    return fallback;
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function announce(game, content) {
  if (!isRunning(game)) return;

  await sendGameDiscord(
    game,
    `### 📢 BİLGİ | ${game.minute}'\n\n` +
    `${scoreText(game)}\n\n` +
    `${content}\n\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );
}

function activePlayers(team) {
  return team.players.filter(player => player.active);
}

/* OTOMATİK MAÇ OLAYLARI */

async function automaticEvent(game) {
  const home = game.homeTeam;
  const away = game.awayTeam;

  const homePlayers = activePlayers(home);
  const awayPlayers = activePlayers(away);

  if (!homePlayers.length || !awayPlayers.length) return;

  const attackingHome = Math.random() < 0.5;
  const team = attackingHome ? home : away;
  const opponent = attackingHome ? away : home;
  const players = attackingHome ? homePlayers : awayPlayers;

  const player = players[
    Math.floor(Math.random() * players.length)
  ];

  const event = Math.random();

  if (event < 0.15) {
    if (attackingHome) {
      game.homeScore++;
    } else {
      game.awayScore++;
    }

    const commentary = await aiCommentary(
      `${game.minute}. dakika. Golü atan: ${player.name}. ` +
      `Takım: ${team.name}. Güncel skor: ` +
      `${home.name} ${game.homeScore}-${game.awayScore} ${away.name}.`,
      `⚽ GOOOOL! ${player.name} ağları havalandırıyor!`
    );

    await announce(
      game,
      `⚽ **GOOOOL!** ${commentary}\n` +
      `Golü atan: **${player.name}**`
    );

    return;
  }

  if (event < 0.35) {
    const commentary = await aiCommentary(
      `${game.minute}. dakika. ${player.name}, ${team.name} oyuncusu. ` +
      "Hücum gelişiyor, kısa Türkçe futbol anlatımı yap.",
      `${player.name} topu ileri taşıyor!`
    );

    await announce(game, `> ${team.emoji} ${commentary}`);
    return;
  }

  if (event < 0.50) {
    await announce(
      game,
      `> ${team.emoji} **${player.name}** şutunu çekti! ` +
      "Kaleci topu kontrol etti."
    );
    return;
  }

  if (event < 0.60) {
    player.yellow++;

    if (player.yellow >= 2) {
      player.active = false;
      player.red = true;

      await announce(
        game,
        `> 🟥 **${player.name}** ikinci sarı karttan kırmızı kart gördü!`
      );
    } else {
      await announce(
        game,
        `> 🟨 **${player.name}** sarı kart gördü.`
      );
    }

    return;
  }

  const defenders = activePlayers(opponent);

  if (!defenders.length) return;

  const defender = defenders[
    Math.floor(Math.random() * defenders.length)
  ];

  await announce(
    game,
    `> 🛡️ **${defender.name}** rakip atağını engelledi.`
  );
}

/* MAÇI ÇALIŞTIR */

async function runMatch(game) {
  if (!isRunning(game)) return;

  await sendGameDiscord(
    game,
    `### 📢 BİLGİ | MAÇ BAŞLADI\n\n` +
    `${scoreText(game)}\n\n` +
    `> 🏟️ İlk düdük çaldı!\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );

  while (isRunning(game) && game.minute < 90) {
    await wait(5000);

    if (!isRunning(game)) return;

    game.minute++;

    if (game.minute === 45) {
      await sendGameDiscord(
        game,
        `### 📢 BİLGİ | DEVRE ARASI\n\n` +
        `${scoreText(game)}\n\n` +
        `> ⏸️ İlk yarı sona erdi. İkinci yarı 60 saniye sonra başlayacak.`
      );

      await wait(60000);

      if (!isRunning(game)) return;

      await sendGameDiscord(
        game,
        `### 📢 BİLGİ | İKİNCİ YARI\n\n` +
        `${scoreText(game)}\n\n` +
        `> ▶️ İkinci yarı başladı!`
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

  const report = await aiCommentary(
    `Maç bitti. ${game.homeTeam.name} ${game.homeScore}-` +
    `${game.awayScore} ${game.awayTeam.name}. ` +
    "Kısa Türkçe maç sonu değerlendirmesi yaz.",
    `🏁 Maç sona erdi! Sonuç: ${game.homeTeam.name} ` +
    `${game.homeScore}-${game.awayScore} ${game.awayTeam.name}.`
  );

  await sendGameDiscord(
    game,
    `### 📢 BİLGİ | MAÇ SONU\n\n` +
    `${scoreText(game)}\n\n` +
    `> ${report}\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
  );
}

/* OYUNCU LİSTESİNİ OKU */

function parsePlayers(value) {
  if (Array.isArray(value)) {
    return value.map(name => String(name).trim());
  }

  if (typeof value !== "string") {
    return [];
  }

  const text = value.trim();

  if (!text) return [];

  // JSON dizisi metin olarak gelirse destekle.
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text);

      if (Array.isArray(parsed)) {
        return parsed.map(name => String(name).trim());
      }
    } catch (_) {
      // Dizi JSON değilse aşağıdaki ayraçlar denenir.
    }
  }

  // BDFD'den gelen |, satır sonu veya ; ayraçlarını destekle.
  return text
    .split(/[|\n\r;]+/)
    .map(name => name.trim())
    .filter(Boolean);
}

/* ANA SAYFA */

app.get("/", (req, res) => {
  res.json({
    project: "Serie A+",
    online: true,
    health: "/health"
  });
});

/* SAĞLIK KONTROLÜ */

app.get("/health", (req, res) => {
  res.json({
    online: true,
    project: "Serie A+",
    multiMatch: true
  });
});


/* SERIE A+ TAKIM LİSTESİ */

app.get("/teams", (req, res) => {
  res.json({
    success: true,
    count: TEAMS.length,
    teams: TEAMS
  });
});

/* MAÇ DURUMU */

app.get("/status", (req, res) => {
  const id = req.query.matchId;

  if (id) {
    const game = getMatch(String(id));

    if (!game) {
      return res.status(404).json({
        success: false,
        error: "Maç bulunamadı."
      });
    }

    return res.json({
      success: true,
      matchId: game.id,
      running: game.running,
      started: game.started,
      finished: game.finished,
      minute: game.minute,
      channelId: game.channelId,
      home: game.homeTeam.name,
      away: game.awayTeam.name,
      score: {
        home: game.homeScore,
        away: game.awayScore
      }
    });
  }

  return res.json({
    success: true,
    activeMatches: [...matches.values()]
      .filter(game => game.running)
      .map(game => ({
        matchId: game.id,
        home: game.homeTeam.name,
        away: game.awayTeam.name,
        channelId: game.channelId,
        minute: game.minute,
        score: `${game.homeScore}-${game.awayScore}`,
        started: game.started
      }))
  });
});

/* MAÇ OLUŞTUR */

app.post("/start", authorize, async (req, res) => {
  const {
    home,
    away,
    homeEmoji,
    awayEmoji,
    channelId
  } = req.body || {};

  if (
    ![home, away, homeEmoji, awayEmoji].every(
      value => typeof value === "string" && value.trim()
    )
  ) {
    return res.status(400).json({
      success: false,
      error: "home, away, homeEmoji ve awayEmoji zorunludur."
    });
  }

  if (!/^\d{17,20}$/.test(String(channelId || ""))) {
    return res.status(400).json({
      success: false,
      error: "Geçerli bir Discord kanal ID'si girilmelidir."
    });
  }

  let id;

  do {
    id = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (matches.has(id));

  const game = {
    id,
    channelId: String(channelId),
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
    `> 📋 Kadrolar bekleniyor. Maç ID: \`${id}\``
  );

  return res.json({
    success: true,
    matchId: id,
    channelId: game.channelId,
    waitingForLineups: true,
    messageSent: sent
  });
});

/* KADRO GİR */

app.post("/lineup", authorize, async (req, res) => {
  const { matchId, side, players, substitutes } = req.body || {};

  const game = getMatch(matchId);

  if (!game || !game.running || game.started) {
    return res.status(400).json({
      success: false,
      error: "Aktif ve kadro bekleyen maç bulunamadı."
    });
  }

  const team = getTeam(game, side);

  if (!team) {
    return res.status(400).json({
      success: false,
      error: "Taraf ev veya dep olmalıdır."
    });
  }

  const playerList = parsePlayers(players);

  if (
    playerList.length !== 11 ||
    playerList.some(name => typeof name !== "string" || !name.trim())
  ) {
    console.error("Kadro oyuncu sayısı hatalı:", {
      matchId,
      side,
      receivedType: typeof players,
      receivedCount: playerList.length,
      receivedPlayers: playerList
    });

    return res.status(400).json({
      success: false,
      error: "Tam olarak 11 oyuncu adı girilmelidir.",
      receivedCount: playerList.length,
      hint: "Oyuncuları | karakteriyle ayırarak gönder."
    });
  }

  let substituteList = [];

  if (typeof substitutes === "string") {
    substituteList = substitutes
      .split(",")
      .map(name => name.trim())
      .filter(Boolean);
  } else if (Array.isArray(substitutes)) {
    substituteList = substitutes.map(name => String(name).trim());
  } else if (substitutes !== undefined && substitutes !== null) {
    return res.status(400).json({
      success: false,
      error: "Yedek oyuncular geçersiz."
    });
  }

  const allNames = [...playerList, ...substituteList]
    .map(name => name.trim().toLocaleLowerCase("tr"));

  if (new Set(allNames).size !== allNames.length) {
    return res.status(400).json({
      success: false,
      error: "Kadrodaki oyuncu isimleri benzersiz olmalıdır."
    });
  }

  team.players = playerList.map(name => ({
    name: name.trim(),
    active: true,
    yellow: 0,
    red: false
  }));

  team.players.push(
    ...substituteList.map(name => ({
      name: name.trim(),
      active: false,
      yellow: 0,
      red: false
    }))
  );

  const messageSent = await sendGameDiscord(
    game,
    `### 📢 BİLGİ | KADRO KAYDEDİLDİ\n\n` +
    `${team.emoji} **${team.name}**\n` +
    team.players
      .map((player, index) =>
        `${index + 1}. ${player.name}` +
        `${player.active ? "" : " (Yedek)"}`
      )
      .join("\n")
  );

  const homeReady =
    game.homeTeam.players.filter(player => player.active).length === 11;

  const awayReady =
    game.awayTeam.players.filter(player => player.active).length === 11;

  if (homeReady && awayReady) {
    game.started = true;

    runMatch(game).catch(error => {
      console.error(`Maç ${game.id} hatası:`, error);
    });

    return res.json({
      success: true,
      matchStarted: true,
      matchId: game.id,
      team: team.name,
      playerCount: playerList.length,
      substituteCount: substituteList.length,
      messageSent
    });
  }

  return res.json({
    success: true,
    matchStarted: false,
    matchId: game.id,
    team: team.name,
    playerCount: playerList.length,
    substituteCount: substituteList.length,
    messageSent,
    message: "Kadro kaydedildi. Diğer takımın kadrosu bekleniyor."
  });
});

/* OYUNCU DEĞİŞİKLİĞİ */

app.post("/substitution", authorize, async (req, res) => {
  const { matchId, side, outPlayer, inPlayer } = req.body || {};
  const game = getMatch(matchId);

  if (!game || !game.running || !game.started) {
    return res.status(400).json({
      success: false,
      error: "Aktif maç bulunamadı."
    });
  }

  const team = getTeam(game, side);

  if (
    !team ||
    typeof outPlayer !== "string" ||
    typeof inPlayer !== "string"
  ) {
    return res.status(400).json({
      success: false,
      error: "Taraf ve oyuncu isimleri zorunludur."
    });
  }

  const outgoing = team.players.find(
    player =>
      player.active &&
      player.name.toLocaleLowerCase("tr") ===
      outPlayer.trim().toLocaleLowerCase("tr")
  );

  const incoming = team.players.find(
    player =>
      !player.active &&
      !player.red &&
      player.name.toLocaleLowerCase("tr") ===
      inPlayer.trim().toLocaleLowerCase("tr")
  );

  if (!outgoing || !incoming) {
    return res.status(400).json({
      success: false,
      error: "Çıkan oyuncu sahada, giren oyuncu yedek olmalıdır."
    });
  }

  outgoing.active = false;
  incoming.active = true;

  await announce(
    game,
    `> 🔄 **${outgoing.name}** çıktı, **${incoming.name}** oyuna girdi.`
  );

  return res.json({
    success: true,
    matchId: game.id
  });
});

/* KART */

app.post("/card", authorize, async (req, res) => {
  const { matchId, side, player: playerName, type } = req.body || {};
  const game = getMatch(matchId);

  if (!game || !game.running || !game.started) {
    return res.status(400).json({
      success: false,
      error: "Aktif maç bulunamadı."
    });
  }

  const team = getTeam(game, side);

  if (
    !team ||
    typeof playerName !== "string" ||
    !["sari", "kirmizi"].includes(type)
  ) {
    return res.status(400).json({
      success: false,
      error: "Taraf, oyuncu ve kart türü zorunludur."
    });
  }

  const player = team.players.find(
    item =>
      item.active &&
      item.name.toLocaleLowerCase("tr") ===
      playerName.trim().toLocaleLowerCase("tr")
  );

  if (!player) {
    return res.status(400).json({
      success: false,
      error: "Oyuncu sahada bulunamadı."
    });
  }

  let message;

  if (type === "kirmizi" || player.yellow >= 1) {
    player.red = true;
    player.active = false;
    message = `🟥 **${player.name}** kırmızı kart gördü!`;
  } else {
    player.yellow++;
    message = `🟨 **${player.name}** sarı kart gördü.`;
  }

  await announce(game, `> ${team.emoji} ${message}`);

  return res.json({
    success: true,
    matchId: game.id
  });
});

/* MAÇ DURDUR */

app.post("/stop", authorize, async (req, res) => {
  const { matchId } = req.body || {};
  const game = getMatch(matchId);

  if (!game || !game.running) {
    return res.status(404).json({
      success: false,
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

  return res.json({
    success: true,
    stopped: true,
    matchId: game.id
  });
});

/* JSON VE SUNUCU HATALARI */

app.use((err, req, res, next) => {
  console.error("İstek hatası:", err.message);

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      error: "Geçersiz JSON gövdesi."
    });
  }

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({
    success: false,
    error: "Sunucu tarafında beklenmeyen hata."
  });
});


/* VERİTABANINI HAZIRLA VE SUNUCUYU BAŞLAT */

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Serie A+ botu ${PORT} portunda çalışıyor.`);
    });
  })
  .catch(error => {
    console.error("Veritabanı başlatılamadı:", error.message);
    process.exit(1);
  });
