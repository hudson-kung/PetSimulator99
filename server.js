const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 3055);
const PUBLIC_DIR = path.join(__dirname, "public");
const ROBLOX_SERVERS_URL = "https://games.roblox.com/v1/games";
const PS99_RAP_URL = "https://ps99.biggamesapi.io/api/rap";
const PS99RAP_BASE_URL = "https://ps99rap.com";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1";
const ASSISTANT_MODEL_PROVIDER = (process.env.ASSISTANT_MODEL_PROVIDER || "auto").toLowerCase();
const DEFAULT_PLACE_ID = "15502339080";
const SERVER_CACHE_MS = 60000;
const RAP_CACHE_MS = 4 * 60 * 60 * 1000;
const serverCache = new Map();
let rapCache = null;
let catalogCache = null;
let ps99RapSearchCache = null;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { text };
    }

    if (!response.ok) {
      throw new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizePlaceId(value) {
  const text = String(value || DEFAULT_PLACE_ID).trim();
  return /^\d+$/.test(text) ? text : DEFAULT_PLACE_ID;
}

function sanitizeServerId(value) {
  const text = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
    ? text
    : "";
}

function buildJoinUri(placeId, serverId) {
  return `roblox://experiences/start?placeId=${encodeURIComponent(placeId)}&gameInstanceId=${encodeURIComponent(serverId)}`;
}

function launchRoblox(joinUri) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Start-Process -FilePath $args[0]",
      "--",
      joinUri
    ], {
      windowsHide: true,
      stdio: "ignore"
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Windows launcher exited with ${code}`));
    });
  });
}

function variantName(configData) {
  const parts = [];
  if (configData.sh) parts.push("Shiny");
  if (configData.pt === 1) parts.push("Golden");
  if (configData.pt === 2) parts.push("Rainbow");
  parts.push(configData.id || "Unknown");
  if (configData.tn) parts.push(`Tier ${configData.tn}`);
  return parts.join(" ");
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function assetIdFromThumbnail(value) {
  const match = String(value || "").match(/rbxassetid:\/\/(\d+)/i);
  return match ? match[1] : "";
}

function normalizeRapItem(item) {
  const configData = item.configData || {};
  const name = variantName(configData);
  const keyParts = [
    item.category,
    configData.id,
    configData.pt ? `pt${configData.pt}` : "",
    configData.sh ? "shiny" : "",
    configData.tn ? `tn${configData.tn}` : "",
    configData.cv ? `cv${configData.cv}` : ""
  ].filter(Boolean);

  return {
    key: keyParts.join(":"),
    category: item.category || "Unknown",
    name,
    baseName: configData.id || name,
    value: Number(item.value || 0),
    variant: {
      golden: configData.pt === 1,
      rainbow: configData.pt === 2,
      shiny: Boolean(configData.sh),
      tier: configData.tn || null,
      chroma: configData.cv || null
    },
    search: normalizeText(`${name} ${item.category}`),
    imageUrl: ""
  };
}

function scoreRapMatch(item, query) {
  if (!query) return item.value > 0 ? Math.min(item.value, 1000000000) / 1000000000 : 0;
  if (item.search === query) return 1000;
  if (item.search.startsWith(query)) return 850;
  if (item.search.includes(query)) return 650;

  const queryWords = query.split(" ").filter(Boolean);
  const itemWords = item.search.split(" ").filter(Boolean);
  const hits = queryWords.filter((word) => itemWords.includes(word)).length;
  const fuzzyHits = queryWords.filter((word) => !itemWords.includes(word) && itemWords.some((itemWord) => wordsClose(word, itemWord))).length;
  return hits || fuzzyHits ? 250 + hits * 90 + fuzzyHits * 45 : 0;
}

function estimateDemand(item) {
  const name = item.name || item.baseName || "";
  const value = Number(item.value || 0);
  let score = 18;

  if (item.category === "Pet") {
    score += 8;
    if (/^Titanic\b/.test(name)) score += 44;
    else if (/^Gargantuan\b/.test(name)) score += 40;
    else if (/^Huge\b/.test(name)) score += 30;
    else if (/Exclusive|Event|Secret/i.test(name)) score += 16;

    if (item.variant.shiny) score += 5;
    if (item.variant.rainbow) score += 4;
    if (item.variant.golden) score += 2;
  } else if (item.category === "Egg") {
    score += 26;
    if (/Exclusive/i.test(name)) score += 18;
    if (/Chroma|Titanic|Gargantuan|Huge/i.test(name)) score += 6;
  } else if (/Enchant|Potion|Charm/i.test(item.category)) {
    score += 20;
  } else {
    score += 10;
  }

  if (value >= 10000000000) score += 20;
  else if (value >= 1000000000) score += 16;
  else if (value >= 100000000) score += 12;
  else if (value >= 10000000) score += 8;
  else if (value >= 1000000) score += 4;

  score = Math.max(1, Math.min(100, Math.round(score)));
  const label = score >= 82 ? "Very high" : score >= 65 ? "High" : score >= 45 ? "Medium" : score >= 25 ? "Low" : "Very low";

  return {
    label,
    score,
    note: "Estimated from item type and RAP tier"
  };
}

async function fetchRapValues() {
  if (rapCache && Date.now() - rapCache.createdAt < RAP_CACHE_MS) {
    return { items: rapCache.items, source: "cache" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response;

    try {
      response = await fetch(PS99_RAP_URL, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "PS99ServerSniper/1.0"
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`BIG Games returned ${response.status}`);
    }

    const payload = await response.json();
    if (payload.status !== "ok" || !Array.isArray(payload.data)) {
      throw new Error("BIG Games returned an unexpected RAP response");
    }

    const items = payload.data
      .map(normalizeRapItem)
      .filter((item) => item.value > 0 && item.baseName !== "Unknown")
      .sort((a, b) => b.value - a.value);

    rapCache = { createdAt: Date.now(), items };
    return { items, source: "live" };
  } catch (error) {
    if (rapCache) {
      return { items: rapCache.items, source: "stale", warning: error.message };
    }
    throw error;
  }
}

async function fetchCollectionMetadata(collectionName, label) {
  const response = await fetch(`https://ps99.biggamesapi.io/api/collection/${collectionName}`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "PS99ServerSniper/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`BIG Games ${label} returned ${response.status}`);
  }

  const payload = await response.json();
  if (payload.status !== "ok" || !Array.isArray(payload.data)) {
    throw new Error(`BIG Games returned an unexpected ${label} response`);
  }

  return payload.data;
}

async function fetchCatalogMetadata() {
  if (catalogCache && Date.now() - catalogCache.createdAt < SERVER_CACHE_MS) {
    return catalogCache.items;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let pets = [];
    let eggs = [];

    try {
      [pets, eggs] = await Promise.all([
        fetchCollectionMetadata("Pets", "Pets"),
        fetchCollectionMetadata("Eggs", "Eggs")
      ]);
    } finally {
      clearTimeout(timeout);
    }

    const items = new Map();
    for (const pet of pets) {
      const configData = pet.configData || {};
      const assetId = assetIdFromThumbnail(configData.thumbnail) || assetIdFromThumbnail(configData.goldenThumbnail);
      const name = pet.configName || configData.name;
      if (name && assetId) {
        items.set(`Pet:${name}`, {
          displayName: name,
          imageUrl: `https://ps99.biggamesapi.io/image/${assetId}`,
          aliases: [name]
        });
      }
    }

    for (const egg of eggs) {
      const configData = egg.configData || {};
      const assetId = assetIdFromThumbnail(configData.icon) || assetIdFromThumbnail(configData.thumbnail) || assetIdFromThumbnail(configData.goldenThumbnail);
      const configName = egg.configName;
      const displayName = configData.name || configName;
      if (configName) {
        items.set(`Egg:${configName}`, {
          displayName,
          imageUrl: assetId ? `https://ps99.biggamesapi.io/image/${assetId}` : "",
          aliases: [configName, displayName, egg.category].filter(Boolean)
        });
      }
    }

    catalogCache = { createdAt: Date.now(), items };
    return items;
  } catch (error) {
    if (catalogCache) return catalogCache.items;
    return new Map();
  }
}

async function getValuesWithImages() {
  const [rapResult, catalogMetadata] = await Promise.all([fetchRapValues(), fetchCatalogMetadata()]);
  return {
    ...rapResult,
    items: rapResult.items.map((item) => {
      const metadata = catalogMetadata.get(`${item.category}:${item.baseName}`);
      const displayName = metadata?.displayName || item.name;
      const aliases = metadata?.aliases || [];
      return {
        ...item,
        name: displayName,
        rapName: item.name,
        search: normalizeText([displayName, item.name, item.baseName, item.category, ...aliases].join(" ")),
        imageUrl: metadata?.imageUrl || "",
        demand: estimateDemand({ ...item, name: displayName })
      };
    })
  };
}

function cleanAssistantQuery(message) {
  return normalizeText(message)
    .replace(/\b(yo|i|my|mean|found|find|should|buy|purchase|worth|deal|booth|seller|selling|what|are|is|the|some|that|have|to|go|and|value|values|rap|price|demand|of|for|a|an|how|much|worth|tell|me|about|please|show|does|it|cost|stock|chart|history|trend|current|past|future|expected|expect|predicted|predict|prediction|under|below|less|budget)\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:k|m|b|t)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const assistantIntentWords = [
  "what", "are", "some", "that", "have", "value", "values", "expected", "expect", "predicted", "go", "to",
  "cheap", "cheapest", "lowest", "low", "top", "highest", "best", "expensive",
  "huge", "huges", "titanic", "titanics", "rainbow", "golden", "shiny",
  "mutation", "mutations", "variant", "variants", "history", "trend", "chart",
  "stock", "rising", "falling", "up", "down", "found", "buy", "should",
  "deal", "booth", "profit", "skip", "increase", "under", "below", "less",
  "budget", "mean", "my", "demand"
];

const assistantTypoAliases = new Map(Object.entries({
  cheep: "cheap",
  cheps: "cheap",
  chep: "cheap",
  chepsst: "cheapest",
  cheepest: "cheapest",
  chepest: "cheapest",
  cheepst: "cheapest",
  titnic: "titanic",
  titnics: "titanics",
  titanicc: "titanic",
  hug: "huge",
  huges: "huges",
  valeu: "value",
  valu: "value",
  mutaton: "mutation",
  mutatons: "mutations",
  shniy: "shiny",
  goldn: "golden",
  rainbo: "rainbow"
}));

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }

  return previous[b.length];
}

function wordsClose(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const distance = levenshtein(a, b);
  return distance <= (Math.max(a.length, b.length) >= 8 ? 2 : 1);
}

function buildAssistantVocabulary(items) {
  const words = new Set(assistantIntentWords);
  for (const item of items) {
    for (const word of item.search.split(" ")) {
      if (word.length >= 3) words.add(word);
    }
  }
  return [...words];
}

function correctAssistantMessage(message, items) {
  const normalized = normalizeText(message);
  const vocabulary = buildAssistantVocabulary(items);
  const correctedWords = normalized.split(" ").map((word) => {
    if (assistantTypoAliases.has(word)) return assistantTypoAliases.get(word);
    if (word.length < 4 || vocabulary.includes(word) || /^\d+$/.test(word)) return word;

    let bestWord = word;
    let bestDistance = Infinity;
    for (const candidate of vocabulary) {
      if (Math.abs(candidate.length - word.length) > 2) continue;
      const distance = levenshtein(word, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestWord = candidate;
      }
    }

    const maxDistance = word.length >= 7 ? 2 : 1;
    return bestDistance <= maxDistance ? bestWord : word;
  });

  const corrected = correctedWords.join(" ");
  return {
    corrected,
    didCorrect: corrected !== normalized
  };
}

function summarizeChange(history) {
  if (!history.length) return null;
  const points = history.slice(-90);
  const first = points[0][1];
  const last = points[points.length - 1][1];
  const change = last - first;
  const percent = first ? change / first * 100 : 0;
  return { first, last, change, percent };
}

function predictValueFromHistory(history) {
  const points = history.filter(([, value]) => value > 0).slice(-45);
  if (points.length < 3) return null;

  const values = points.map(([, value]) => value);
  const first = values[0];
  const last = values[values.length - 1];
  const changes = [];

  for (let i = 1; i < values.length; i += 1) {
    changes.push((values[i] - values[i - 1]) / Math.max(values[i - 1], 1));
  }

  const recentChanges = changes.slice(-10);
  const avgChange = recentChanges.reduce((sum, value) => sum + value, 0) / recentChanges.length;
  const volatility = Math.sqrt(recentChanges.reduce((sum, value) => sum + Math.pow(value - avgChange, 2), 0) / recentChanges.length);
  const totalTrend = (last - first) / Math.max(first, 1);
  const blendedDaily = avgChange * 0.65 + (totalTrend / Math.max(points.length - 1, 1)) * 0.35;
  const cappedDaily = Math.max(-0.08, Math.min(0.08, blendedDaily));
  const predicted7 = Math.max(1, Math.round(last * Math.pow(1 + cappedDaily, 7)));
  const predicted30 = Math.max(1, Math.round(last * Math.pow(1 + cappedDaily, 30)));
  const direction = Math.abs(cappedDaily) < 0.003 ? "flat" : cappedDaily > 0 ? "up" : "down";
  const confidence = volatility < 0.015 ? "high" : volatility < 0.05 ? "medium" : "low";

  return {
    current: last,
    predicted7,
    predicted30,
    direction,
    confidence,
    dailyTrendPercent: cappedDaily * 100,
    volatilityPercent: volatility * 100
  };
}

function parseDiamondAmount(message) {
  const normalized = String(message || "").toLowerCase().replace(/,/g, "");
  const match = normalized.match(/\b(\d+(?:\.\d+)?)\s*(t|tril|trillion|b|bil|billion|m|mil|million|k|thousand)?\b/);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const suffix = match[2] || "";
  const multiplier = suffix.startsWith("t")
    ? 1000000000000
    : suffix.startsWith("b")
      ? 1000000000
      : suffix.startsWith("m")
        ? 1000000
        : suffix.startsWith("k") || suffix.startsWith("thousand")
          ? 1000
          : 1;

  return Math.round(amount * multiplier);
}

function buildModelPrompt(message, result) {
  const cards = (result.cards || []).slice(0, 8).map((item) => ({
    name: item.name,
    category: item.category,
    rap: item.value,
    demand: item.demand,
    regular: isRegularItem(item)
  }));

  return [
    {
      role: "system",
      content: [
        "You are the PS99 Sniper assistant inside a local web app.",
        "Answer casually and directly.",
        "Use only the provided RAP/value data. Do not invent live server prices, demand, or guarantees.",
        "If demand appears, call it estimated demand.",
        "Keep answers short: 1-4 sentences.",
        "Do not mention APIs, JSON, prompts, or model providers."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        userMessage: message,
        computedAnswer: result.answer,
        cards,
        historyUrl: result.historyUrl
      })
    }
  ];
}

async function askOllama(message, result) {
  const payload = await fetchJsonWithTimeout(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: buildModelPrompt(message, result),
      stream: false,
      options: {
        temperature: 0.25,
        num_predict: 220
      }
    })
  }, 9000);

  return payload?.message?.content?.trim() || "";
}

async function getOllamaModelStatus() {
  try {
    const payload = await fetchJsonWithTimeout(`${OLLAMA_URL}/api/tags`, {
      headers: { "Accept": "application/json" }
    }, 1500);
    const models = Array.isArray(payload.models)
      ? payload.models.map((model) => model.name).filter(Boolean)
      : [];

    return {
      id: "ollama",
      label: "Ollama",
      configured: true,
      available: true,
      model: OLLAMA_MODEL,
      url: OLLAMA_URL,
      models
    };
  } catch (error) {
    return {
      id: "ollama",
      label: "Ollama",
      configured: true,
      available: false,
      model: OLLAMA_MODEL,
      url: OLLAMA_URL,
      message: "Ollama is not reachable from this server."
    };
  }
}

async function getAssistantModelStatus() {
  const shouldCheckOllama = ASSISTANT_MODEL_PROVIDER === "ollama" || ASSISTANT_MODEL_PROVIDER === "auto";
  const ollama = shouldCheckOllama ? await getOllamaModelStatus() : null;
  let active = "rules";

  if (ASSISTANT_MODEL_PROVIDER === "ollama") {
    active = ollama?.available ? "ollama" : "rules";
  } else if (ASSISTANT_MODEL_PROVIDER === "rules") {
    active = "rules";
  } else {
    active = ollama?.available ? "ollama" : "rules";
  }

  const providers = [];
  if (ollama?.available || ASSISTANT_MODEL_PROVIDER === "ollama") {
    providers.push({
      id: "ollama",
      label: "Local model",
      configured: Boolean(ollama?.available),
      available: Boolean(ollama?.available),
      model: OLLAMA_MODEL,
      models: ollama?.models || []
    });
  }

  return {
    mode: ASSISTANT_MODEL_PROVIDER,
    active,
    providers,
    fallback: {
      id: "rules",
      label: "Rules fallback",
      available: true,
      message: "The value assistant still works, but answers are generated without an AI model."
    }
  };
}

async function improveAssistantAnswer(message, result) {
  if (ASSISTANT_MODEL_PROVIDER === "rules") {
    return { ...result, modelProvider: "rules" };
  }

  const providers = ASSISTANT_MODEL_PROVIDER === "ollama" || ASSISTANT_MODEL_PROVIDER === "auto"
    ? ["ollama"]
    : [];

  for (const provider of providers) {
    try {
      const answer = await askOllama(message, result);

      if (answer) {
        return {
          ...result,
          answer,
          modelProvider: provider
        };
      }
    } catch {
      // Fall back silently so value lookups keep working without a model.
    }
  }

  return { ...result, modelProvider: "rules" };
}

function itemChartUrl(item) {
  const chartName = item.category === "Pet" ? item.baseName : item.name;
  return `/item/${encodeURIComponent(chartName)}`;
}

function isRegularItem(item) {
  return !item.variant.golden && !item.variant.rainbow && !item.variant.shiny && !item.variant.tier && !item.variant.chroma;
}

async function findRisingRegularPets(items, prefix, limit, maxBudget = null) {
  const candidates = items
    .filter((item) => item.category === "Pet")
    .filter((item) => item.name.startsWith(prefix))
    .filter(isRegularItem)
    .filter((item) => item.value >= 10000000)
    .filter((item) => !maxBudget || item.value <= maxBudget)
    .sort((a, b) => b.value - a.value)
    .slice(0, 80);
  const results = [];
  const batchSize = 8;

  for (let start = 0; start < candidates.length && results.length < limit * 2; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    const checked = await Promise.allSettled(batch.map(async (item) => {
      const history = await fetchRapHistoryByName(item.name);
      const prediction = predictValueFromHistory(history.history);
      if (!prediction || prediction.predicted7 <= prediction.current) return null;

      const forecastPercent = prediction.current ? (prediction.predicted7 - prediction.current) / prediction.current * 100 : 0;
      if (forecastPercent < 0.25) return null;

      return {
        item,
        forecastPercent,
        prediction
      };
    }));

    for (const result of checked) {
      if (result.status === "fulfilled" && result.value) {
        results.push(result.value);
      }
    }
  }

  return results
    .sort((a, b) => b.forecastPercent - a.forecastPercent || b.item.value - a.item.value)
    .slice(0, limit);
}

async function answerValueQuestion(message) {
  const text = String(message || "").trim();
  const valuesResult = await getValuesWithImages();
  const correction = correctAssistantMessage(text, valuesResult.items);
  const normalized = correction.corrected;
  const wantsCheapest = /\b(cheap|cheapest|lowest|least expensive|low)\b/.test(normalized);
  const wantsExpensive = /\b(most expensive|highest|top|best)\b/.test(normalized);
  const wantsHuge = /\bhuge|huges\b/.test(normalized);
  const wantsTitanic = /\btitanic|titanics\b/.test(normalized);
  const wantsSpecificMutation = /\b(golden|rainbow|shiny|chroma)\b/.test(normalized);
  const wantsRisingList = /\b(expected|expect|future|predict|prediction|rise|rising|increase|up)\b/.test(normalized) && /\b(some|which|what|list|values|pets|huges|titanics)\b/.test(normalized);
  const wantsDemand = /\bdemand\b/.test(normalized);
  const offeredPrice = parseDiamondAmount(text);
  const wantsBudgetFilter = offeredPrice && /\b(under|below|less|budget)\b/.test(normalized);
  const wantsDealCheck = offeredPrice && /\b(should|buy|deal|profit|worth|found|booth|seller|selling)\b/.test(normalized);
  const requestedLimit = Math.max(1, Math.min(Number(normalized.match(/\btop\s+(\d+)\b/)?.[1] || normalized.match(/\b(\d+)\b/)?.[1] || 8), 20));

  if ((wantsRisingList && (wantsHuge || wantsTitanic)) || wantsBudgetFilter) {
    const prefix = wantsTitanic ? "Titanic" : "Huge";
    const rising = await findRisingRegularPets(valuesResult.items, prefix, requestedLimit, wantsBudgetFilter ? offeredPrice : null);
    const cards = rising.map((entry) => entry.item);
    const budgetText = wantsBudgetFilter ? ` under ${offeredPrice.toLocaleString()} diamonds` : "";

    return {
      answer: cards.length
        ? `${correction.didCorrect ? `I read that as "${normalized}". ` : ""}Regular ${prefix}s${budgetText} with the strongest 7 day upward forecast: ${rising.map((entry, index) => `${index + 1}. ${entry.item.name} (${entry.item.value.toLocaleString()} RAP, +${entry.forecastPercent.toFixed(1)}%)`).join("; ")}. These are trend estimates, not guaranteed.`
        : `I could not find regular ${prefix}s${budgetText} with a positive forecast right now.`,
      cards,
      historyUrl: cards[0] ? `/item/${encodeURIComponent(cards[0].baseName)}` : undefined
    };
  }

  if (wantsCheapest && wantsHuge) {
    const cheapHuges = valuesResult.items
      .filter((item) => item.category === "Pet")
      .filter((item) => /^Huge\b/.test(item.name))
      .filter((item) => !item.variant.golden && !item.variant.rainbow && !item.variant.shiny && !item.variant.tier && !item.variant.chroma)
      .filter((item) => item.value >= 10000000 && item.value < 1000000000)
      .sort((a, b) => a.value - b.value)
      .slice(0, requestedLimit);

    return {
      answer: `${correction.didCorrect ? `I read that as "${normalized}". ` : ""}Cheapest regular Huges I found start at ${cheapHuges[0]?.value?.toLocaleString() || "unknown"} RAP. Showing ${cheapHuges.length}.`,
      cards: cheapHuges,
      historyUrl: cheapHuges[0] ? `/item/${encodeURIComponent(cheapHuges[0].baseName)}` : undefined
    };
  }

  if (wantsCheapest && wantsTitanic) {
    const cheapTitanics = valuesResult.items
      .filter((item) => item.category === "Pet")
      .filter((item) => /^Titanic\b/.test(item.name))
      .filter((item) => !item.variant.golden && !item.variant.rainbow && !item.variant.shiny && !item.variant.tier && !item.variant.chroma)
      .filter((item) => item.value >= 1000000000 && item.value < 1000000000000)
      .sort((a, b) => a.value - b.value)
      .slice(0, requestedLimit);

    return {
      answer: `${correction.didCorrect ? `I read that as "${normalized}". ` : ""}Cheapest regular Titanics I found start at ${cheapTitanics[0]?.value?.toLocaleString() || "unknown"} RAP. Showing ${cheapTitanics.length}.`,
      cards: cheapTitanics,
      historyUrl: cheapTitanics[0] ? `/item/${encodeURIComponent(cheapTitanics[0].baseName)}` : undefined
    };
  }

  if (wantsExpensive) {
    const topPets = valuesResult.items
      .filter((item) => item.category === "Pet" && !item.variant.golden && !item.variant.rainbow && !item.variant.shiny && !item.variant.tier && !item.variant.chroma)
      .slice(0, requestedLimit);
    return {
      answer: `${correction.didCorrect ? `I read that as "${normalized}". ` : ""}Here are the top regular pets by RAP right now: ${topPets.map((item, index) => `${index + 1}. ${item.name} (${item.value.toLocaleString()})`).join("; ")}.`,
      cards: topPets
    };
  }

  const query = cleanAssistantQuery(normalized) || normalized;
  const baseQuery = query
    .replace(/\b(cheap|cheapest|lowest|least expensive|low|regular|golden|rainbow|shiny|stock|chart|history|trend|current|past|future|value|values|rap|price|demand|and|yo|i|my|mean|found|find|should|buy|purchase|worth|deal|booth|seller|selling|profit|skip|under|below|less|budget|expected|expect|predicted|predict|prediction)\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:k|m|b|t)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const matches = valuesResult.items
    .map((item) => ({ item, score: scoreRapMatch(item, query) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => {
      if (wantsCheapest) return a.item.value - b.item.value || b.score - a.score;
      const exactA = a.item.search === query ? 1 : 0;
      const exactB = b.item.search === query ? 1 : 0;
      return exactB - exactA || b.score - a.score || b.item.value - a.item.value;
    })
    .slice(0, 6)
    .map((match) => match.item);

  const baseMatches = valuesResult.items.filter((item) => item.search === `${baseQuery} pet` || normalizeHistoryName(item.baseName) === baseQuery);

  if (!matches.length) {
    return {
      answer: "I could not find a matching PS99 value. Try the exact pet or item name, like 'Huge Hot Cocoa Bear'.",
      cards: []
    };
  }

  const top = matches[0];
  const exactMatch = matches.find((item) => item.search === query) || top;
  const regularFamilyCandidates = valuesResult.items.filter((item) => {
    if (item.category !== "Pet") return false;
    const itemBase = normalizeHistoryName(item.baseName);
    const isRegular = !item.variant.golden && !item.variant.rainbow && !item.variant.shiny && !item.variant.tier && !item.variant.chroma;
    return isRegular && (
      itemBase === baseQuery ||
      itemBase.endsWith(` ${baseQuery}`) ||
      baseQuery.endsWith(` ${itemBase}`)
    );
  });
  const regularFamilyMatch = regularFamilyCandidates
    .sort((a, b) => {
      const scoreRegularCandidate = (item) => {
        if (wantsTitanic && /^Titanic\b/.test(item.name)) return 40;
        if (wantsHuge && /^Huge\b/.test(item.name)) return 40;
        if (/^Titanic\b/.test(item.name)) return 30;
        if (/^Huge\b/.test(item.name)) return 20;
        if (normalizeHistoryName(item.baseName) === baseQuery) return 10;
        return 0;
      };
      return scoreRegularCandidate(b) - scoreRegularCandidate(a) || b.value - a.value;
    })[0];
  const selected = wantsCheapest && baseMatches.length
    ? baseMatches.slice().sort((a, b) => a.value - b.value)[0]
    : !wantsSpecificMutation && regularFamilyMatch
      ? regularFamilyMatch
    : exactMatch;

  if (wantsDemand) {
    return {
      answer: `${selected.name} demand is ${selected.demand?.label || "unknown"} (${selected.demand?.score || "?"}/100). RAP is ${selected.value.toLocaleString()}. Demand is estimated, not an official live BIG Games stat.`,
      cards: [selected],
      historyUrl: itemChartUrl(selected)
    };
  }

  if (wantsDealCheck) {
    const profit = selected.value - offeredPrice;
    const profitPercent = offeredPrice ? profit / offeredPrice * 100 : 0;
    const decision = profit > selected.value * 0.08 ? "Buy it" : profit > 0 ? "Maybe buy it" : "Skip it";
    const reason = profit >= 0
      ? `That is ${profit.toLocaleString()} diamonds under RAP (${profitPercent.toFixed(1)}% potential margin).`
      : `That is ${Math.abs(profit).toLocaleString()} diamonds over RAP.`;

    return {
      answer: `${correction.didCorrect ? `I read that as "${normalized}". ` : ""}${decision}: ${selected.name} RAP is ${selected.value.toLocaleString()} and the booth price is ${offeredPrice.toLocaleString()}. ${reason}`,
      cards: [selected],
      historyUrl: itemChartUrl(selected)
    };
  }

  if (/\b(mutation|mutations|variant|variants)\b/.test(normalized)) {
    const variants = valuesResult.items
      .filter((item) => item.category === selected.category && item.baseName === selected.baseName)
      .sort((a, b) => a.value - b.value)
      .slice(0, 12);
    return {
      answer: `${selected.baseName} has ${variants.length} tracked variant${variants.length === 1 ? "" : "s"} in RAP. Cheapest shown is ${variants[0]?.name || "unknown"} at ${variants[0]?.value?.toLocaleString() || "unknown"} RAP.`,
      cards: variants,
      historyUrl: itemChartUrl(selected)
    };
  }

  if (/\b(history|trend|up|down|rising|falling|crash|chart)\b/.test(normalized)) {
    try {
      const history = await fetchRapHistoryByName(selected.name);
      const change = summarizeChange(history.history);
      if (change) {
        const direction = change.change >= 0 ? "up" : "down";
        return {
          answer: `${selected.name} is ${direction} ${Math.abs(change.percent).toFixed(1)}% over the recent chart window. Current RAP is ${change.last.toLocaleString()}, from ${change.first.toLocaleString()}.`,
          cards: [selected],
          historyUrl: itemChartUrl(selected)
        };
      }
    } catch {
      return {
        answer: `${correction.didCorrect ? `I read that as "${normalized}". ` : ""}${selected.name} is currently ${selected.value.toLocaleString()} RAP, but I could not load its history right now.`,
        cards: [selected],
        historyUrl: itemChartUrl(selected)
      };
    }
  }

  if (wantsCheapest) {
    const cheapestCards = baseMatches.length
      ? baseMatches.slice().sort((a, b) => a.value - b.value).slice(0, 6)
      : matches;
    return {
      answer: `${correction.didCorrect ? `I read that as "${normalized}". ` : ""}The cheapest close match I found is ${selected.name} at ${selected.value.toLocaleString()} RAP.`,
      cards: cheapestCards,
      historyUrl: itemChartUrl(selected)
    };
  }

  return {
    answer: `${correction.didCorrect ? `I read that as "${normalized}". ` : ""}${selected.name} is currently ${selected.value.toLocaleString()} RAP. I found ${matches.length} close match${matches.length === 1 ? "" : "es"} below.`,
    cards: matches,
    historyUrl: itemChartUrl(selected)
  };
}

function normalizeHistoryName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function fetchPs99RapSearch() {
  if (ps99RapSearchCache && Date.now() - ps99RapSearchCache.createdAt < RAP_CACHE_MS) {
    return ps99RapSearchCache;
  }

  const response = await fetch(`${PS99RAP_BASE_URL}/api/search`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "PS99ServerSniper/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`PS99RAP search returned ${response.status}`);
  }

  const payload = await response.json();
  const byName = new Map();

  for (const [id, name] of Object.entries(payload || {})) {
    byName.set(normalizeHistoryName(name), id);
  }

  ps99RapSearchCache = { createdAt: Date.now(), byName };
  return ps99RapSearchCache;
}

async function fetchRapHistoryByName(name) {
  const search = await fetchPs99RapSearch();
  const normalizedName = normalizeHistoryName(name);
  const id = search.byName.get(normalizedName) || String(name || "").trim().replace(/\s+/g, "_");

  const response = await fetch(`${PS99RAP_BASE_URL}/api/item/${encodeURIComponent(id)}/rap_history`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "PS99ServerSniper/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`PS99RAP history returned ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.success || !Array.isArray(payload.data)) {
    throw new Error("PS99RAP returned an unexpected history response");
  }

  return {
    id,
    name,
    history: payload.data
      .map(([timestamp, rap]) => [Number(timestamp), Number(rap)])
      .filter(([timestamp, rap]) => timestamp && Number.isFinite(rap))
  };
}

async function fetchServers(placeId, requestedPages) {
  const pages = Math.max(1, Math.min(Number(requestedPages || 2), 5));
  const cacheKey = `${placeId}:${pages}`;
  const cached = serverCache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < SERVER_CACHE_MS) {
    return { servers: cached.servers, source: "cache" };
  }

  const results = [];
  let cursor = "";

  try {
    for (let page = 0; page < pages; page += 1) {
      const url = new URL(`${ROBLOX_SERVERS_URL}/${placeId}/servers/Public`);
      url.searchParams.set("sortOrder", "Desc");
      url.searchParams.set("excludeFullGames", "false");
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let response;

      try {
        response = await fetch(url, {
          headers: {
            "Accept": "application/json",
            "User-Agent": "PS99ServerSniper/1.0"
          },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new Error(`Roblox returned ${response.status}`);
      }

      const payload = await response.json();
      if (Array.isArray(payload.data)) results.push(...payload.data);
      if (!payload.nextPageCursor) break;
      cursor = payload.nextPageCursor;
    }

    const seen = new Set();
    const servers = results.filter((server) => {
      if (!server.id || seen.has(server.id)) return false;
      seen.add(server.id);
      return true;
    }).map((server) => {
      const playing = Number(server.playing || 0);
      const maxPlayers = Number(server.maxPlayers || 0);
      const openSlots = Math.max(maxPlayers - playing, 0);
      const occupancy = maxPlayers ? playing / maxPlayers : 0;
      const scoutScore = Math.round((openSlots > 0 ? 35 : 0) + occupancy * 45 + Math.min(openSlots, 8) * 2.5);

      return {
        id: server.id,
        playing,
        maxPlayers,
        openSlots,
        fps: server.fps,
        ping: server.ping,
        scoutScore,
      joinUri: buildJoinUri(placeId, server.id),
      robloxUrl: `https://www.roblox.com/games/${placeId}/Trading-Plaza`
    };
  }).sort((a, b) => b.scoutScore - a.scoutScore);

    serverCache.set(cacheKey, { createdAt: Date.now(), servers });
    return { servers, source: "live" };
  } catch (error) {
    if (cached) {
      return { servers: cached.servers, source: "stale", warning: error.message };
    }
    throw error;
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const appRoutes = new Set(["/", "/values", "/servers", "/how", "/assistant"]);
  const requestedPath = appRoutes.has(url.pathname) || url.pathname.startsWith("/item/")
    ? "/index.html"
    : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, placeId: DEFAULT_PLACE_ID });
    return;
  }

  if (url.pathname === "/api/servers") {
    try {
      const placeId = sanitizePlaceId(url.searchParams.get("placeId"));
      const pages = url.searchParams.get("pages");
      const result = await fetchServers(placeId, pages);
      sendJson(res, 200, {
        ok: true,
        placeId,
        count: result.servers.length,
        fetchedAt: new Date().toISOString(),
        source: result.source,
        warning: result.warning,
        servers: result.servers
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        message: "Could not load Roblox servers right now.",
        detail: error.message
      });
    }
    return;
  }

  if (url.pathname === "/api/values") {
    try {
      const query = normalizeText(url.searchParams.get("q"));
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const pageSize = Math.max(12, Math.min(Number(url.searchParams.get("pageSize") || url.searchParams.get("limit") || 48), 96));
      const category = String(url.searchParams.get("category") || "").trim();
      const regularOnly = url.searchParams.get("regularOnly") === "true";
      const variantsOf = String(url.searchParams.get("variantsOf") || "").trim();
      const result = await getValuesWithImages();
      const filtered = result.items
        .filter((item) => !category || item.category.toLowerCase() === category.toLowerCase())
        .filter((item) => !regularOnly || (!item.variant.golden && !item.variant.rainbow && !item.variant.shiny && !item.variant.tier && !item.variant.chroma))
        .filter((item) => !variantsOf || item.baseName.toLowerCase() === variantsOf.toLowerCase())
        .map((item) => ({ item, score: scoreRapMatch(item, query) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score || b.item.value - a.item.value)
        .map((match) => match.item);
      const start = (page - 1) * pageSize;
      const matches = filtered.slice(start, start + pageSize);

      sendJson(res, 200, {
        ok: true,
        source: result.source,
        warning: result.warning,
        count: matches.length,
        total: filtered.length,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
        fetchedAt: rapCache ? new Date(rapCache.createdAt).toISOString() : new Date().toISOString(),
        values: matches
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        message: "Could not load PS99 RAP values right now.",
        detail: error.message
      });
    }
    return;
  }

  if (url.pathname === "/api/values/stats") {
    try {
      const result = await fetchRapValues();
      sendJson(res, 200, {
        ok: true,
        source: result.source,
        warning: result.warning,
        count: result.items.length,
        fetchedAt: rapCache ? new Date(rapCache.createdAt).toISOString() : new Date().toISOString()
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        message: "Could not load PS99 RAP values right now.",
        detail: error.message
      });
    }
    return;
  }

  if (url.pathname === "/api/history") {
    try {
      const name = String(url.searchParams.get("name") || "").trim();
      if (!name) {
        sendJson(res, 400, { ok: false, message: "Missing item name." });
        return;
      }

      const result = await fetchRapHistoryByName(name);
      sendJson(res, 200, {
        ok: true,
        source: "ps99rap",
        ...result
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        message: "Could not load price history right now.",
        detail: error.message
      });
    }
    return;
  }

  if (url.pathname === "/api/predict") {
    try {
      const name = String(url.searchParams.get("name") || "").trim();
      if (!name) {
        sendJson(res, 400, { ok: false, message: "Missing item name." });
        return;
      }

      const history = await fetchRapHistoryByName(name);
      const prediction = predictValueFromHistory(history.history);
      if (!prediction) {
        sendJson(res, 404, { ok: false, message: "Not enough RAP history to predict this item." });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        source: "ps99rap",
        id: history.id,
        name,
        prediction
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        message: "Could not predict future value right now.",
        detail: error.message
      });
    }
    return;
  }

  if (url.pathname === "/api/assistant") {
    try {
      const rawBody = req.method === "POST" ? await readRequestBody(req) : "{}";
      const body = JSON.parse(rawBody || "{}");
      const message = String(body.message || url.searchParams.get("message") || "").trim();

      if (!message) {
        sendJson(res, 400, { ok: false, message: "Ask a value question first." });
        return;
      }

      const result = await improveAssistantAnswer(message, await answerValueQuestion(message));
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        message: "The value assistant could not answer right now.",
        detail: error.message
      });
    }
    return;
  }

  if (url.pathname === "/api/model-status") {
    try {
      sendJson(res, 200, { ok: true, ...(await getAssistantModelStatus()) });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        message: "Could not check model status right now.",
        detail: error.message
      });
    }
    return;
  }

  if (url.pathname === "/api/join") {
    const placeId = sanitizePlaceId(url.searchParams.get("placeId"));
    const serverId = sanitizeServerId(url.searchParams.get("serverId"));

    if (!serverId) {
      sendJson(res, 400, {
        ok: false,
        message: "Missing or invalid Roblox server ID."
      });
      return;
    }

    const joinUri = buildJoinUri(placeId, serverId);

    try {
      await launchRoblox(joinUri);
      sendJson(res, 200, {
        ok: true,
        message: "Roblox launch requested.",
        joinUri
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        message: "Windows could not launch Roblox from this app.",
        detail: error.message,
        joinUri
      });
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`PS99 Server Sniper running at http://localhost:${PORT}`);
});
