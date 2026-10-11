
const express = require("express");

const app = express();
app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const SECRET = process.env.CONTROL_SECRET;
const MODEL = process.env.OPENROUTER_MODEL || "openrouter/auto";

let match = null;

function authorized(req, res, next) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!SECRET || token !== SECRET) {
    return res.status(401).json({ error: "Yetkisiz istek." });
  }
  next();
}

function clearTimers(m) {
  if (!m) return;
  clearInterval(m.clockTimer);
  clearTimeout(m.eventTimer);
  clearTimeout(m.halftimeTimer);
}

async function discordMessage(content) {
  if (!WEBHOOK) throw new Error("Discord webhook ayarlanmamış.");

  const response = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });

  if (!response.ok) {
    throw new Error(`Discord webhook hatası: ${response.status}`);
  }
}

function scoreboard(m) {
  return `${m.homeEmoji} **${m.home} ${m.homeScore} - ${m.awayScore} ${m.away}** ${m.awayEmoji}`;
}

async function commentary(eventDescription) {
  if (!API_KEY) throw new Error("OpenRouter API anahtarı ayarlanmamış.");

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "Sen Serie A+ futbol spikerisin. Türkçe, doğal, heyecanlı ve " +
              "kısa maç anlatımı yaz. Yalnızca verilen olayı anlat. " +
              "Skoru veya dakikayı değiştirme. Tek cümle, en fazla 30 kelime. " +
              "Markdown kullanma, tırnak işareti ekleme."
          },
          {
            role: "user",
            content: `Maçın ${match.minute}. dakikası. Olay: ${eventDescription}`
          }
        ],
        max_tokens: 100,
        temperature: 0.8
      })
    }
  );

  if (!response.ok) {
    throw new Error(`OpenRouter hatası: ${response.status}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content?.trim();

  if (!text) throw new Error("AI boş yanıt verdi.");
  return text.replace(/^["']|["']$/g, "").slice(0, 1200);
}

async function publishEvent(m, description, isGoal = false) {
  let text;

  try {
    text = await commentary(description);
  } catch (error) {
    console.error(error.message);
    text = description;
  }

  const header = isGoal
    ? `### ⚽ GOL | ${m.minute}'`
    : `### <:duyuru:1489319985959669883> BİLGİ | ${m.minute}'`;

  const content =
    `${header}\n\n` +
    `${scoreboard(m)}\n\n` +
    `> <:futbolcu:1504904247551201441> **${m.minute}'** | ${text}\n` +
    `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`;

  try {
    await discordMessage(content);
  } catch (error) {
    console.error("Discord mesajı gönderilemedi:", error.message);
  }
}

const normalEvents = [
  "Korner kullanılıyor, savunma topu uzaklaştırıyor.",
  "Orta sahada paslaşma ve oyun kurma mücadelesi.",
  "Kanattan hızlı hücum ve ceza sahasına orta.",
  "Kaleci gelen şutu kontrol ediyor.",
  "Tehlikeli bir serbest vuruş kazanılıyor.",
  "Savunma araya girerek atağı kesiyor.",
  "Ofsayt kararıyla oyun duruyor.",
  "Ceza sahası çevresinde etkili bir paslaşma.",
  "Uzak mesafeden şut, top auta gidiyor.",
  "Hakem faul düdüğünü çalıyor."
];

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function scheduleEvent(m, delay = 10000) {
  clearTimeout(m.eventTimer);

  m.eventTimer = setTimeout(async () => {
    if (match !== m || !m.running) return;

    if (m.paused) {
      scheduleEvent(m, 5000);
      return;
    }

    // Yaklaşık %9 gol ihtimali.
    const isGoal = Math.random() < 0.09;

    if (isGoal) {
      const homeScores = Math.random() < 0.5;
      const team = homeScores ? m.home : m.away;

      if (homeScores) m.homeScore++;
      else m.awayScore++;

      await publishEvent(
        m,
        `${team} gol attı! Gol sevincini ve atağın bitirişini anlat.`,
        true
      );

      scheduleEvent(m, 20000);
    } else {
      await publishEvent(m, randomItem(normalEvents));
      scheduleEvent(m, 10000);
    }
  }, delay);
}

async function finishMatch(m) {
  if (!m.running) return;

  m.running = false;
  clearTimers(m);

  try {
    await discordMessage(
      `### 🏁 MAÇ SONU | 90'\n\n${scoreboard(m)}\n\n` +
      `-# <:spiker:1552793209803898950> Serie A+ Canlı Anlatım`
    );
  } catch (error) {
    console.error(error.message);
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
    console.error(error.message);
  }

  m.halftimeTimer = setTimeout(() => {
    if (match !== m || !m.running) return;

    m.paused = false;
    scheduleEvent(m, 10000);
  }, 60000);
}

app.get("/health", (req, res) => {
  res.json({ online: true, project: "Serie A+" });
});

app.get("/status", authorized, (req, res) => {
  if (!match) return res.json({ active: false });

  res.json({
    active: match.running,
    minute: match.minute,
    score: `${match.homeScore}-${match.awayScore}`,
    paused: match.paused
  });
});

app.post("/start", authorized, async (req, res) => {
  const { home, away, homeEmoji, awayEmoji } = req.body || {};

  if (
    typeof home !== "string" ||
    typeof away !== "string" ||
    typeof homeEmoji !== "string" ||
    typeof awayEmoji !== "string" ||
    !home.trim() ||
    !away.trim() ||
    home.length > 20 ||
    away.length > 20 ||
    homeEmoji.length > 100 ||
    awayEmoji.length > 100
  ) {
    return res.status(400).json({
      error: "home, away, homeEmoji ve awayEmoji alanları gerekli."
    });
  }

  if (!WEBHOOK || !API_KEY) {
    return res.status(500).json({
      error: "Sunucu ortam değişkenleri eksik."
    });
  }

  if (match?.running) {
    return res.status(409).json({ error: "Zaten bir maç devam ediyor." });
  }

  if (match) clearTimers(match);

  const m = {
    home: home.trim(),
    away: away.trim(),
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
    return res.status(502).json({ error: "Başlangıç mesajı gönderilemedi." });
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

  res.json({ started: true, home, away });
});

app.post("/stop", authorized, async (req, res) => {
  if (!match || !match.running) {
    return res.json({ stopped: false, message: "Aktif maç yok." });
  }

  const m = match;
  m.running = false;
  clearTimers(m);

  try {
    await discordMessage(
      `### ⏹️ MAÇ DURDURULDU | ${m.minute}'\n\n${scoreboard(m)}\n` +
      `-# Serie A+ Canlı Anlatım`
    );
  } catch (error) {
    console.error(error.message);
  }

  res.json({ stopped: true, minute: m.minute });
});

app.listen(PORT, () => {
  console.log(`Serie A+ sunucusu ${PORT} portunda çalışıyor.`);
});
