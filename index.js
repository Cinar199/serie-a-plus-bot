
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.OPENROUTER_API_KEY;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const SECRET = process.env.CONTROL_SECRET;
const MODEL = process.env.OPENROUTER_MODEL || "openrouter/auto";

// JSON ve form gövdelerini kabul et.
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));

let match = null;

function logError(message, error) {
  console.error(`[Serie A+] ${message}`, error?.message || error || "");
}

function authorized(req, res, next) {
  const authorization = req.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");

  if (!SECRET || token !== SECRET) {
    return res.status(401).json({ error: "Yetkisiz istek." });
  }

  next();
}

function readString(value, maxLength = 100) {
  return typeof value === "string" && value.length <= maxLength
    ? value.trim()
    : "";
}

function scoreboard(m) {
  return `${m.homeEmoji} **${m.home} ${m.homeScore} - ${m.awayScore} ${m.away}** ${m.awayEmoji}`;
}

async function discordMessage(content) {
  if (!WEBHOOK) {
    throw new Error("DISCORD_WEBHOOK_URL ayarlanmamış.");
  }

  const response = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Discord HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }
}

async function generateCommentary(m, eventDescription) {
  if (!API_KEY) {
    throw new Error("OPENROUTER_API_KEY ayarlanmamış.");
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "Sen Serie A+ futbol spikerisin. Türkçe, doğal ve heyecanlı " +
              "bir anlatım yap. Yalnızca verilen olayı anlat. Skoru ve " +
              "dakikayı değiştirme. Tek cümle, en fazla 30 kelime yaz."
          },
          {
            role: "user",
            content:
              `Dakika: ${m.minute}. Skor: ${m.homeScore}-${m.awayScore}. ` +
              `Olay: ${eventDescription}`
          }
        ],
        max_tokens: 100,
        temperature: 0.8
      })
    }
  );

  if (!response.ok) {
    throw new Error(`OpenRouter HTTP ${response.status}`);
  }

  const data = await response.json();
  const result = data.choices?.[0]?.message?.content?.trim();

  if (!result) {
    throw new Error("OpenRouter boş yanıt verdi.");
  }

  return result.slice(0, 1200);
}

async function publishEvent(m, description, isGoal = false) {
  let commentary;

  try {
    commentary = await generateCommentary(m, description);
  } catch (error) {
    logError("AI anlatımı üretilemedi:", error);
    commentary = description;
  }

  const heading = isGoal
    ? `### ⚽ GOL | ${m.minute}'`
    : `### <:duyuru:1489319985959669883> BİLGİ | ${m.minute}'`;

  const content =
    `${heading}\n\n` +
    `${scoreboard(m)}\n\n` +
    `> <:futbolcu:1504904247551201441> **${m.minute}'** | ${commentary}\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`;

  try {
    await discordMessage(content);
  } catch (error) {
    logError("Discord mesajı gönderilemedi:", error);
  }
}

function clearMatchTimers(m) {
  if (!m) return;

  clearInterval(m.clockTimer);
  clearTimeout(m.eventTimer);
  clearTimeout(m.halftimeTimer);
}

const events = [
  "Korner kullanılıyor, savunma topu uzaklaştırıyor.",
  "Orta sahada paslaşma mücadelesi yaşanıyor.",
  "Kanattan ceza sahasına orta yapılıyor.",
  "Kaleci gelen şutu kontrol ediyor.",
  "Tehlikeli bir serbest vuruş kazanılıyor.",
  "Savunma araya girerek atağı kesiyor.",
  "Ofsayt kararıyla oyun duruyor.",
  "Ceza sahası çevresinde etkili paslaşma yapılıyor.",
  "Uzak mesafeden şut çekiliyor, top auta gidiyor.",
  "Hakem faul düdüğünü çalıyor."
];

function randomEvent() {
  return events[Math.floor(Math.random() * events.length)];
}

function scheduleEvent(m, delay = 10000) {
  clearTimeout(m.eventTimer);

  m.eventTimer = setTimeout(async () => {
    if (match !== m || !m.running) return;

    if (m.paused) {
      scheduleEvent(m, 5000);
      return;
    }

    const isGoal = Math.random() < 0.09;

    if (isGoal) {
      const homeScores = Math.random() < 0.5;
      const scoringTeam = homeScores ? m.home : m.away;

      if (homeScores) m.homeScore++;
      else m.awayScore++;

      await publishEvent(
        m,
        `${scoringTeam} gol attı. Golün sevincini ve bitirici vuruşu anlat.`,
        true
      );

      scheduleEvent(m, 20000);
    } else {
      await publishEvent(m, randomEvent());
      scheduleEvent(m, 10000);
    }
  }, delay);
}

async function finishMatch(m) {
  if (match !== m || !m.running) return;

  m.running = false;
  clearMatchTimers(m);

  try {
    await discordMessage(
      `### 🏁 MAÇ SONU | 90'\n\n${scoreboard(m)}\n\n` +
      `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
    );
  } catch (error) {
    logError("Maç sonu mesajı gönderilemedi:", error);
  }
}

async function startHalftime(m) {
  m.paused = true;
  clearTimeout(m.eventTimer);

  try {
    await discordMessage(
      `### ⏸️ DEVRE ARASI | 45'\n\n${scoreboard(m)}\n\n` +
      `> Takımlar ilk yarıyı tamamladı. İkinci yarı 60 saniye sonra başlayacak.\n` +
      `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
    );
  } catch (error) {
    logError("Devre arası mesajı gönderilemedi:", error);
  }

  m.halftimeTimer = setTimeout(() => {
    if (match !== m || !m.running) return;

    m.paused = false;
    scheduleEvent(m, 10000);
  }, 60000);
}

// Form ve JSON isteklerinde aynı alanları kabul et.
app.get("/health", (req, res) => {
  res.json({ online: true, project: "Serie A+" });
});

// JSON ayrıştırma hataları da anlaşılır yanıt versin.
app.use((error, req, res, next) => {
  logError("İstek gövdesi ayrıştırılamadı:", error);

  if (res.headersSent) return next(error);

  res.status(400).json({
    error: "İstek gövdesi geçersiz.",
    type: error.type || "parse_error"
  });
});

app.get("/status", authorized, (req, res) => {
  if (!match) {
    return res.json({ active: false });
  }

  res.json({
    active: match.running,
    minute: match.minute,
    score: `${match.homeScore}-${match.awayScore}`,
    paused: match.paused
  });
});

app.post("/start", authorized, async (req, res) => {
  const body = req.body || {};

  const home = readString(body.home, 20);
  const away = readString(body.away, 20);
  const homeEmoji = readString(body.homeEmoji, 100);
  const awayEmoji = readString(body.awayEmoji, 100);

  if (!home || !away || !homeEmoji || !awayEmoji) {
    return res.status(400).json({
      error: "home, away, homeEmoji ve awayEmoji alanları zorunludur.",
      receivedFields: Object.keys(body)
    });
  }

  if (!WEBHOOK || !API_KEY) {
    return res.status(500).json({
      error: "Gerekli sunucu ortam değişkenleri eksik."
    });
  }

  if (match?.running) {
    return res.status(409).json({
      error: "Zaten devam eden bir maç var."
    });
  }

  if (match) clearMatchTimers(match);

  const m = {
    home,
    away,
    homeEmoji,
    awayEmoji,
    homeScore: 0,
    awayScore: 0,
    minute: 0,
    running: true,
    paused: false,
    halftimeDone: false,
    clockTimer: null,
    eventTimer: null,
    halftimeTimer: null
  };

  match = m;

  try {
    await discordMessage(
      `### 🏟️ SERIE A+ | MAÇ BAŞLADI\n\n${scoreboard(m)}\n\n` +
      `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
    );
  } catch (error) {
    m.running = false;
    logError("Başlangıç mesajı gönderilemedi:", error);

    return res.status(502).json({
      error: "Discord başlangıç mesajı gönderilemedi."
    });
  }

  m.clockTimer = setInterval(async () => {
    if (match !== m || !m.running || m.paused) return;

    m.minute++;

    if (m.minute === 45 && !m.halftimeDone) {
      m.halftimeDone = true;
      await startHalftime(m);
      return;
    }

    if (m.minute >= 90) {
      await finishMatch(m);
    }
  }, 5000);

  scheduleEvent(m, 10000);

  return res.json({
    started: true,
    home: m.home,
    away: m.away,
    message: "Serie A+ maçı başlatıldı."
  });
});

app.post("/stop", authorized, async (req, res) => {
  if (!match || !match.running) {
    return res.json({
      stopped: false,
      message: "Aktif maç yok."
    });
  }

  const m = match;
  m.running = false;
  clearMatchTimers(m);

  try {
    await discordMessage(
      `### ⏹️ MAÇ DURDURULDU | ${m.minute}'\n\n` +
      `${scoreboard(m)}\n\n` +
      `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
    );
  } catch (error) {
    logError("Durdurma mesajı gönderilemedi:", error);
  }

  return res.json({
    stopped: true,
    minute: m.minute
  });
});

app.listen(PORT, () => {
  console.log(`Serie A+ sunucusu ${PORT} portunda çalışıyor.`);
});
  
