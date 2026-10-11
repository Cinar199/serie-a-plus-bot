const express = require("express");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const CONTROL_SECRET = process.env.CONTROL_SECRET;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "openrouter/auto";

let match = null;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function authorized(req, res, next) {
  const auth = req.get("Authorization") || "";
  if (!CONTROL_SECRET || auth !== `Bearer ${CONTROL_SECRET}`) {
    return res.status(401).json({ error: "Yetkisiz istek." });
  }
  next();
}

async function sendDiscord(content) {
  if (!WEBHOOK_URL) {
    console.error("DISCORD_WEBHOOK_URL tanımlanmamış.");
    return;
  }

  const response = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: String(content).slice(0, 1900),
      allowed_mentions: { parse: [] }
    })
  });

  if (!response.ok) {
    const details = await response.text();
    console.error("Discord webhook hatası:", response.status, details);
  }
}

async function aiCommentary(instruction, fallback) {
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
                "Sen Serie A+ futbol maç anlatıcısısın. Türkçe, doğal, heyecanlı ve kısa anlat. Verilen takım, oyuncu, dakika ve skoru değiştirme. Olmayan oyuncu veya olay uydurma. En fazla iki cümle yaz."
            },
            { role: "user", content: instruction }
          ],
          max_tokens: 120,
          temperature: 0.8
        })
      }
    );

    const data = await response.json();
    const result = data.choices?.[0]?.message?.content?.trim();
    return result || fallback;
  } catch (error) {
    console.error("OpenRouter hatası:", error.message);
    return fallback;
  }
}

function teamFor(side) {
  if (!match) return null;
  if (["ev", "home"].includes(String(side).toLowerCase())) {
    return match.homeTeam;
  }
  if (["dep", "deplasman", "away"].includes(String(side).toLowerCase())) {
    return match.awayTeam;
  }
  return null;
}

function activePlayers(team) {
  return team.players.filter((player) => player.active);
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function scoreText() {
  return `${match.homeTeam.emoji} ${match.homeTeam.name} ${match.homeScore} - ${match.awayScore} ${match.awayTeam.name} ${match.awayTeam.emoji}`;
}

function matchIsCurrent(current) {
  return match === current && current.running;
}

async function announceEvent(current, instruction, fallback) {
  if (!matchIsCurrent(current)) return;
  const commentary = await aiCommentary(instruction, fallback);
  if (matchIsCurrent(current)) await sendDiscord(commentary);
}

async function automaticEvent(current) {
  const home = current.homeTeam;
  const away = current.awayTeam;
  const homePlayers = activePlayers(home);
  const awayPlayers = activePlayers(away);

  if (!homePlayers.length || !awayPlayers.length) {
    await announceEvent(
      current,
      `${current.minute}. dakika. ${scoreText()}. Kısa maç anlatımı yaz.`,
      `⏱️ ${current.minute}. dakika | ${scoreText()}`
    );
    return;
  }

  const attackingHome = Math.random() < 0.5;
  const team = attackingHome ? home : away;
  const opponent = attackingHome ? away : home;
  const attackers = attackingHome ? homePlayers : awayPlayers;

  // Gol olasılığı
  if (Math.random() < 0.14) {
    const scorer = randomItem(attackers);
    if (attackingHome) current.homeScore++;
    else current.awayScore++;

    const fallback =
      `⚽ GOOOOOL! ${team.emoji} ${team.name} adına ${scorer.name} ` +
      `topu ağlara gönderiyor! Skor: ${scoreText()}`;

    const commentary = await aiCommentary(
      `${current.minute}. dakika. GOL! Golü atan oyuncu ${scorer.name}. ` +
      `Gol atan takım ${team.name}. Güncel skor: ${scoreText()}. ` +
      `Bu bilgileri koruyarak Türkçe, heyecanlı bir gol anlatımı yaz.`,
      fallback
    );

    if (matchIsCurrent(current)) {
      // Oyuncu adı ve skor her durumda kesin olarak gösterilir.
      await sendDiscord(
        `⚽ **GOOOOL! ${team.emoji} ${team.name}**\n` +
        `${commentary}\n🥅 Golü atan: **${scorer.name}**\n📊 **${scoreText()}**`
      );
      await sleep(20000);
    }
    return;
  }

  // Otomatik sarı kart olayı
  if (Math.random() < 0.10) {
    const player = randomItem(attackers);
    player.yellow++;

    if (player.yellow >= 2) {
      player.active = false;
      player.red = true;

      await announceEvent(
        current,
        `${current.minute}. dakika. ${player.name}, ${team.name} oyuncusu. ` +
        `İkinci sarıdan kırmızı kart gördü. Skor ${scoreText()}.`,
        `🟥 ${current.minute}'. ${player.name}, ikinci sarı kartın ardından kırmızı kart gördü! ${scoreText()}`
      );
    } else {
      await announceEvent(
        current,
        `${current.minute}. dakika. ${player.name}, ${team.name} oyuncusu, sarı kart gördü. Skor ${scoreText()}.`,
        `🟨 ${current.minute}'. ${player.name} sarı kart gördü. ${scoreText()}`
      );
    }
    return;
  }

  await announceEvent(
    current,
    `${current.minute}. dakika. ${team.name} hücum yapıyor, ${opponent.name} savunmada. ` +
    `Skor ${scoreText()}. Kısa Türkçe futbol anlatımı yaz.`,
    `⚽ ${current.minute}'. ${team.name} rakip kalede etkili olmaya çalışıyor. ${scoreText()}`
  );
}

async function runMatch(current) {
  if (!matchIsCurrent(current)) return;

  await sendDiscord(
    `📋 **KADROLAR TAMAM! MAÇ BAŞLIYOR**\n${scoreText()}\n` +
    `🏟️ İlk düdük çaldı!`
  );

  while (matchIsCurrent(current) && current.minute < 90) {
    await sleep(5000);
    if (!matchIsCurrent(current)) return;

    current.minute++;

    if (current.minute === 45) {
      await sendDiscord(
        `⏸️ **DEVRE ARASI**\n${scoreText()}\n` +
        `İlk 45 dakika tamamlandı. İkinci yarı 60 saniye sonra başlayacak.`
      );

      await sleep(60000);
      if (!matchIsCurrent(current)) return;

      await sendDiscord(`▶️ **İKİNCİ YARI BAŞLADI!**\n${scoreText()}`);
      continue;
    }

    if (current.minute % 2 === 0 || current.minute === 90) {
      await automaticEvent(current);
    }
  }

  if (!matchIsCurrent(current)) return;

  current.running = false;
  current.finished = true;

  const report = await aiCommentary(
    `Maç sona erdi. Ev sahibi ${current.homeTeam.name}, deplasman ${current.awayTeam.name}. ` +
    `Son skor: ${scoreText()}. Türkçe kısa maç sonu raporu yaz; skoru değiştirme.`,
    `🏁 **MAÇ SONU**\n${scoreText()}\nKarşılaşma sona erdi!`
  );

  await sendDiscord(`🏁 **MAÇ SONU RAPORU**\n${report}\n📊 **${scoreText()}**`);
}

app.get("/health", (req, res) => {
  res.json({ online: true, project: "Serie A+" });
});

app.get("/status", (req, res) => {
  if (!match) return res.json({ running: false, message: "Aktif maç yok." });

  res.json({
    running: match.running,
    waitingForLineups: !match.started,
    minute: match.minute,
    score: {
      home: match.homeScore,
      away: match.awayScore
    },
    home: match.homeTeam.name,
    away: match.awayTeam.name
  });
});

app.post("/start", authorized, async (req, res) => {
  const { home, away, homeEmoji, awayEmoji } = req.body || {};

  if (![home, away, homeEmoji, awayEmoji].every(
    (value) => typeof value === "string" && value.trim()
  )) {
    return res.status(400).json({
      error: "home, away, homeEmoji ve awayEmoji alanları zorunludur."
    });
  }

  if (match?.running) {
    return res.status(409).json({ error: "Zaten devam eden bir maç var." });
  }

  match = {
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

  await sendDiscord(
    `📝 **MAÇ OLUŞTURULDU**\n${scoreText()}\n` +
    `Maçı başlatmak için önce /kadrogir ile iki takımın 11 oyuncusunu girin.`
  );

  res.json({
    started: true,
    waitingForLineups: true,
    home: home.trim(),
    away: away.trim(),
    message: "Maç oluşturuldu; kadrolar bekleniyor."
  });
});

app.post("/lineup", authorized, async (req, res) => {
  if (!match?.running || match.started) {
    return res.status(400).json({
      error: "Önce maç oluşturulmalı; maç başladıysa kadro değiştirilemez."
    });
  }

  const { side, players } = req.body || {};
  const team = teamFor(side);

  if (!team) {
    return res.status(400).json({ error: "taraf ev veya dep olmalıdır." });
  }

  if (!Array.isArray(players) || players.length !== 11 ||
      players.some((name) => typeof name !== "string" || !name.trim())) {
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
    `📋 **KADRO KAYDEDİLDİ**\n${team.emoji} ${team.name}\n` +
    team.players.map((p, i) => `${i + 1}. ${p.name}`).join("\n")
  );

  if (match.homeTeam.players.length === 11 &&
      match.awayTeam.players.length === 11) {
    match.started = true;
    runMatch(match).catch((error) =>
      console.error("Maç akışı hatası:", error)
    );
    return res.json({
      saved: true,
      matchStarted: true,
      message: "İki kadro tamamlandı; maç anlatımı başladı."
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
