const state = {
  servers: [],
  valueMatches: [],
  valueSearchTimer: null,
  valueQuery: "",
  valuePage: 1,
  valueTotalPages: 1,
  valuePageSize: 48,
  selectedPet: null,
  mutations: [],
  selectedMutationName: "",
  itemLoadId: 0
};

const elements = {
  pages: [...document.querySelectorAll("[data-page]")],
  pageLinks: [...document.querySelectorAll("[data-page-link]")],
  placeId: document.querySelector("#placeId"),
  scanPages: document.querySelector("#pages"),
  minSlots: document.querySelector("#minSlots"),
  refreshButton: document.querySelector("#refreshButton"),
  serverSearch: document.querySelector("#serverSearch"),
  status: document.querySelector("#status"),
  serverList: document.querySelector("#serverList"),
  lastUpdated: document.querySelector("#lastUpdated"),
  serverCount: document.querySelector("#serverCount"),
  dealForm: document.querySelector("#dealForm"),
  itemName: document.querySelector("#itemName"),
  valueResults: document.querySelector("#valueResults"),
  selectedValue: document.querySelector("#selectedValue"),
  itemDetailTitle: document.querySelector("#itemDetailTitle"),
  mutationPanel: document.querySelector("#mutationPanel"),
  prevValues: document.querySelector("#prevValues"),
  nextValues: document.querySelector("#nextValues"),
  valuePageInfo: document.querySelector("#valuePageInfo"),
  modelStatus: document.querySelector("#modelStatus"),
  assistantForm: document.querySelector("#assistantForm"),
  assistantInput: document.querySelector("#assistantInput"),
  assistantMessages: document.querySelector("#assistantMessages")
};

elements.pageLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    navigateTo(link.getAttribute("href"));
  });
});
window.addEventListener("popstate", () => showPage(pageFromPath(location.pathname)));
elements.refreshButton.addEventListener("click", refreshServers);
elements.serverSearch.addEventListener("input", renderServers);
elements.minSlots.addEventListener("input", renderServers);
elements.itemName.addEventListener("input", queueValueSearch);
elements.dealForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.valuePage = 1;
  searchValues(elements.itemName.value.trim());
});
elements.prevValues.addEventListener("click", () => {
  if (state.valuePage <= 1) return;
  state.valuePage -= 1;
  searchValues(state.valueQuery);
});
elements.nextValues.addEventListener("click", () => {
  if (state.valuePage >= state.valueTotalPages) return;
  state.valuePage += 1;
  searchValues(state.valueQuery);
});
elements.assistantForm.addEventListener("submit", askAssistant);

loadValueStats();
loadModelStatus();
const initialPage = pageFromPath(location.pathname);
showPage(initialPage);
if (initialPage === "values") {
  searchValues("");
}

async function refreshServers() {
  elements.refreshButton.disabled = true;
  elements.status.textContent = "Loading Roblox public servers...";

  const params = new URLSearchParams({
    placeId: elements.placeId.value.trim(),
    pages: elements.scanPages.value
  });

  try {
    const response = await fetch(`/api/servers?${params}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.detail || payload.message || "Server fetch failed");
    }

    state.servers = payload.servers;
    elements.lastUpdated.textContent = new Date(payload.fetchedAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });
    elements.serverCount.textContent = `${payload.count} servers`;
    elements.status.textContent = payload.warning
      ? `Showing cached servers because ${payload.warning.toLowerCase()}.`
      : `Sorted by joinable, active servers first (${payload.source}).`;
    renderServers();
  } catch (error) {
    elements.status.textContent = `${error.message}. Try again in a minute.`;
    state.servers = [];
    renderServers();
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function pageFromPath(pathname) {
  if (pathname === "/values") return "values";
  if (pathname === "/servers") return "servers";
  if (pathname === "/how") return "how";
  if (pathname === "/assistant") return "assistant";
  if (pathname.startsWith("/item/")) return "item";
  return "home";
}

function navigateTo(pathname) {
  history.pushState({}, "", pathname);
  showPage(pageFromPath(pathname));
}

function showPage(pageName) {
  elements.pages.forEach((page) => {
    page.hidden = page.dataset.page !== pageName;
  });

  elements.pageLinks.forEach((link) => {
    link.classList.toggle("active", link.dataset.pageLink === pageName || (pageName === "item" && link.dataset.pageLink === "values"));
  });

  if ((pageName === "home" || pageName === "servers") && !state.servers.length) {
    refreshServers();
  }

  if (pageName === "item") {
    const petName = decodeURIComponent(location.pathname.replace(/^\/item\//, ""));
    if (!petName.trim()) {
      navigateTo("/values");
      return;
    }
    document.title = `${petName} | Pet Simulator Tools`;
    loadPetDetail(petName);
    return;
  }

  if (pageName === "assistant") {
    loadModelStatus();
  }

  document.title = pageName === "home"
    ? "Pet Simulator Tools"
    : `${pageName[0].toUpperCase()}${pageName.slice(1)} | Pet Simulator Tools`;
}

async function loadModelStatus() {
  if (!elements.modelStatus) return;

  elements.modelStatus.className = "model-status";
  elements.modelStatus.textContent = "Checking model...";

  try {
    const response = await fetch("/api/model-status");
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.detail || payload.message || "Model check failed");
    }

    const activeProvider = payload.providers?.find((provider) => provider.id === payload.active);
    if (activeProvider) {
      elements.modelStatus.innerHTML = `
        <span>Model</span>
        <strong>${escapeHtml(activeProvider.label)}</strong>
        <small>${escapeHtml(activeProvider.model)}</small>
      `;
      elements.modelStatus.classList.add("ready");
      return;
    }

    elements.modelStatus.innerHTML = `
      <span>Model</span>
      <strong>Rules fallback</strong>
    `;
    elements.modelStatus.classList.add("warning");
  } catch (error) {
    elements.modelStatus.innerHTML = `
      <span>Model</span>
      <strong>Status unavailable</strong>
      <small>Refresh the page in a minute.</small>
    `;
    elements.modelStatus.classList.add("warning");
  }
}

async function askAssistant(event) {
  event.preventDefault();
  const message = elements.assistantInput.value.trim();
  if (!message) return;

  appendAssistantMessage("user", message);
  elements.assistantInput.value = "";
  const loading = appendAssistantMessage("bot", "Checking values...");

  try {
    const response = await fetch("/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.detail || payload.message || "Assistant failed");
    }

    loading.remove();
    appendAssistantResult(payload);
  } catch (error) {
    loading.textContent = error.message;
  }
}

function appendAssistantMessage(role, text) {
  const message = document.createElement("div");
  message.className = `assistant-message ${role}`;
  message.textContent = text;
  elements.assistantMessages.appendChild(message);
  elements.assistantMessages.scrollTop = elements.assistantMessages.scrollHeight;
  return message;
}

function appendAssistantResult(payload) {
  const providerLabel = payload.modelProvider === "ollama"
      ? "AI model"
      : "Rules fallback";
  const wrapper = document.createElement("div");
  wrapper.className = "assistant-message bot";
  wrapper.innerHTML = `
    <div>${escapeHtml(payload.answer)}</div>
    ${payload.historyUrl ? `<a class="assistant-link" href="${payload.historyUrl}">Open chart</a>` : ""}
    ${payload.cards?.length ? `<div class="assistant-cards">${payload.cards.map(renderAssistantCard).join("")}</div>` : ""}
    <div class="assistant-provider">Answered by ${escapeHtml(providerLabel)}</div>
  `;
  wrapper.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigateTo(link.getAttribute("href"));
    });
  });
  elements.assistantMessages.appendChild(wrapper);
  elements.assistantMessages.scrollTop = elements.assistantMessages.scrollHeight;
}

function renderAssistantCard(item) {
  return `
    <article class="assistant-card">
      ${item.imageUrl ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.name)}">` : ""}
      <div>
        <strong>${escapeHtml(item.name)}</strong>
        ${item.demand ? `<span>Demand: ${escapeHtml(item.demand.label)} (${item.demand.score}/100)</span>` : ""}
        <span>${escapeHtml(item.category)} · ${formatDiamonds(item.value)} RAP</span>
      </div>
    </article>
  `;
}

function renderServers() {
  const query = elements.serverSearch.value.trim().toLowerCase();
  const minSlots = Number(elements.minSlots.value || 0);
  const servers = state.servers.filter((server) => {
    const matchesQuery = !query || server.id.toLowerCase().includes(query);
    const matchesSlots = server.openSlots >= minSlots;
    return matchesQuery && matchesSlots;
  });

  elements.serverList.innerHTML = "";

  if (!servers.length) {
    elements.serverList.innerHTML = `<div class="status">No servers match those filters.</div>`;
    return;
  }

  for (const server of servers) {
    const card = document.createElement("article");
    card.className = "server-card";
    card.innerHTML = `
      <div class="server-top">
        <div>
          <div class="server-id">${server.id}</div>
          <div class="server-meta">
            <span class="chip">${server.playing}/${server.maxPlayers} players</span>
            <span class="chip">${server.openSlots} open slots</span>
            <span class="chip">${formatMetric("Ping", server.ping, "ms")}</span>
            <span class="chip">${formatMetric("FPS", server.fps, "")}</span>
          </div>
        </div>
        <span class="badge">Score ${server.scoutScore}</span>
      </div>
      <div class="server-actions">
        <button class="primary" data-action="join" data-id="${server.id}">Join server</button>
        <button class="ghost" data-action="copy" data-id="${server.id}">Copy ID</button>
      </div>
    `;
    elements.serverList.appendChild(card);
  }

  elements.serverList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.id;
      if (button.dataset.action === "join") {
        await joinServer(button, id);
      } else {
        await navigator.clipboard.writeText(id);
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = "Copy ID";
        }, 900);
      }
    });
  });
}

async function joinServer(button, serverId) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Launching...";

  const params = new URLSearchParams({
    placeId: elements.placeId.value.trim(),
    serverId
  });

  try {
    const response = await fetch(`/api/join?${params}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.detail || payload.message || "Launch failed");
    }

    button.textContent = "Opened Roblox";
  } catch (error) {
    await navigator.clipboard.writeText(serverId);
    button.textContent = "Copied ID";
    elements.status.textContent = `${error.message}. Server ID copied so you can paste it manually.`;
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 1600);
  }
}

async function loadValueStats() {
  try {
    const response = await fetch("/api/values/stats");
    const payload = await response.json();
    if (payload.ok) {
      elements.selectedValue.textContent = `Loaded ${payload.count.toLocaleString()} official RAP entries (${payload.source}). Search an item to filter the list.`;
    }
  } catch {
    elements.selectedValue.textContent = "RAP lookup is not loaded yet.";
  }
}

function queueValueSearch() {
  clearTimeout(state.valueSearchTimer);
  const query = elements.itemName.value.trim();

  if (query.length < 2) {
    state.valueQuery = "";
    state.valuePage = 1;
    searchValues("");
    return;
  }

  state.valuePage = 1;
  state.valueSearchTimer = setTimeout(() => searchValues(query), 220);
}

async function searchValues(query) {
  state.valueQuery = query;
  elements.valueResults.innerHTML = `<div class="status">Searching RAP...</div>`;

  try {
    const params = new URLSearchParams({
      q: query,
      regularOnly: "true",
      page: String(state.valuePage),
      pageSize: String(state.valuePageSize)
    });
    const response = await fetch(`/api/values?${params}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.detail || payload.message || "RAP search failed");
    }

    state.valueMatches = payload.values;
    state.valueTotalPages = payload.totalPages;
    elements.selectedValue.textContent = `${payload.total.toLocaleString()} regular RAP values (${payload.source}). Search pets, eggs, enchants, booths, and more.`;
    elements.mutationPanel.hidden = true;
    renderPager(payload);
    renderValueMatches();
  } catch (error) {
    elements.valueResults.innerHTML = `<div class="status">${escapeHtml(error.message)}</div>`;
  }
}

function renderPager(payload) {
  elements.valuePageInfo.textContent = `Page ${payload.page.toLocaleString()} of ${payload.totalPages.toLocaleString()}`;
  elements.prevValues.disabled = payload.page <= 1;
  elements.nextValues.disabled = payload.page >= payload.totalPages;
}

function renderValueMatches() {
  elements.valueResults.innerHTML = "";

  if (!state.valueMatches.length) {
    elements.valueResults.innerHTML = `<div class="status">No RAP values found.</div>`;
    return;
  }

  for (const item of state.valueMatches) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "value-card";
    card.innerHTML = `
      <div class="pet-image">
        ${item.imageUrl ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.name)}">` : `<span>?</span>`}
      </div>
      <div>
        <strong>${escapeHtml(item.name)}</strong>
        <div class="server-meta">
          <span class="chip">${escapeHtml(item.category)}</span>
          ${item.variant.shiny ? `<span class="chip">Shiny</span>` : ""}
          ${item.variant.golden ? `<span class="chip">Golden</span>` : ""}
          ${item.variant.rainbow ? `<span class="chip">Rainbow</span>` : ""}
          ${item.variant.tier ? `<span class="chip">Tier ${item.variant.tier}</span>` : ""}
          ${item.demand ? `<span class="chip demand-chip">Demand ${escapeHtml(item.demand.label)}</span>` : ""}
        </div>
      </div>
      <span class="badge">${formatDiamonds(item.value)}</span>
    `;
    card.addEventListener("click", () => navigateTo(`/item/${encodeURIComponent(item.name)}`));
    elements.valueResults.appendChild(card);
  }
}

async function loadPetDetail(baseName) {
  const loadId = state.itemLoadId + 1;
  state.itemLoadId = loadId;
  const item = { baseName };
  state.selectedPet = item;
  state.selectedMutationName = "";
  state.mutations = [];
  elements.itemDetailTitle.textContent = baseName;
  elements.mutationPanel.hidden = false;
  elements.mutationPanel.innerHTML = `<div class="status">Loading mutations for ${escapeHtml(baseName)}...</div>`;

  const params = new URLSearchParams({
    category: "Pet",
    variantsOf: baseName,
    page: "1",
    pageSize: "96"
  });

  try {
    const response = await fetch(`/api/values?${params}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.detail || payload.message || "Mutation lookup failed");
    }

    if (state.itemLoadId !== loadId || state.selectedPet?.baseName !== baseName) {
      return;
    }

    state.mutations = payload.values;
    const regular = state.mutations.find(isRegularMutation) || state.mutations[0];
    if (regular) {
      renderMutations(item);
      selectMutation(regular.name);
    } else {
      renderSingleItemHistory(item);
      selectMutation(baseName);
    }
  } catch (error) {
    if (state.itemLoadId !== loadId) return;
    elements.mutationPanel.innerHTML = `<div class="status">${escapeHtml(error.message)}</div>`;
  }
}

function renderSingleItemHistory(item) {
  elements.mutationPanel.innerHTML = `
    <div class="mutation-head">
      <div>
        <p class="eyebrow">RAP item</p>
        <h2>${escapeHtml(item.baseName)}</h2>
      </div>
      <a class="ghost cta" href="/values" data-page-link="values">Back to values</a>
    </div>
    <div id="priceHistory" class="price-history">
      <div class="status">Loading RAP history for ${escapeHtml(item.baseName)}...</div>
    </div>
  `;

  elements.mutationPanel.querySelectorAll("[data-page-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigateTo(link.getAttribute("href"));
    });
  });
}

function renderMutations(item) {
  const mutationButtons = state.mutations.map((mutation) => `
    <button class="mutation-option" type="button" data-mutation="${escapeHtml(mutation.name)}">
      <span>${mutationLabel(mutation)}</span>
      <strong>${formatDiamonds(mutation.value)}</strong>
    </button>
  `).join("");

  elements.mutationPanel.innerHTML = `
    <div class="mutation-head">
      <div>
        <p class="eyebrow">Mutations</p>
        <h2>${escapeHtml(item.baseName)}</h2>
      </div>
      <a class="ghost cta" href="/values" data-page-link="values">Back to values</a>
    </div>
    <div class="mutation-options">${mutationButtons || `<div class="status">No mutations found.</div>`}</div>
    <div id="priceHistory" class="price-history">
      <div class="status">Select a mutation to load price history.</div>
    </div>
  `;

  elements.mutationPanel.querySelectorAll("[data-page-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigateTo(link.getAttribute("href"));
    });
  });

  document.querySelectorAll(".mutation-option").forEach((button) => {
    button.addEventListener("click", () => selectMutation(button.dataset.mutation));
  });
}

function isRegularMutation(item) {
  return !item.variant.shiny && !item.variant.golden && !item.variant.rainbow && !item.variant.chroma && !item.variant.tier;
}

function mutationLabel(item) {
  const labels = [];
  if (item.variant.shiny) labels.push("Shiny");
  if (item.variant.golden) labels.push("Golden");
  if (item.variant.rainbow) labels.push("Rainbow");
  if (item.variant.chroma) labels.push(`Chroma ${item.variant.chroma}`);
  if (item.variant.tier) labels.push(`Tier ${item.variant.tier}`);
  return labels.length ? labels.join(" ") : "Regular";
}

async function selectMutation(name) {
  state.selectedMutationName = name;
  const loadId = state.itemLoadId;
  document.querySelectorAll(".mutation-option").forEach((button) => {
    button.classList.toggle("active", button.dataset.mutation === name);
  });

  const historyEl = document.querySelector("#priceHistory");
  if (!historyEl) return;
  historyEl.innerHTML = `<div class="status">Loading RAP history for ${escapeHtml(name)}...</div>`;

  try {
    const [historyResult, predictionResult] = await Promise.all([
      fetch(`/api/history?name=${encodeURIComponent(name)}`),
      fetch(`/api/predict?name=${encodeURIComponent(name)}`).catch(() => null)
    ]);

    const payload = await historyResult.json();
    if (!historyResult.ok || !payload.ok) {
      throw new Error(payload.detail || payload.message || "History lookup failed");
    }

    if (state.itemLoadId !== loadId || state.selectedMutationName !== name) {
      return;
    }

    let prediction = null;
    if (predictionResult) {
      const predictionPayload = await predictionResult.json().catch(() => null);
      if (predictionResult.ok && predictionPayload?.ok) {
        prediction = predictionPayload.prediction;
      }
    }

    renderPriceHistory(payload, prediction);
  } catch (error) {
    historyEl.innerHTML = `<div class="status">${escapeHtml(error.message)}</div>`;
  }
}

function renderPriceHistory(payload, prediction) {
  const historyEl = document.querySelector("#priceHistory");
  const points = payload.history.slice(-90);

  if (!points.length) {
    historyEl.innerHTML = `<div class="status">No RAP history found for this mutation.</div>`;
    return;
  }

  const values = points.map(([, value]) => value);
  const first = values[0];
  const last = values[values.length - 1];
  const change = last - first;
  const changePercent = first ? change / first * 100 : 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const forecastPoints = prediction ? buildForecastPoints(points, prediction) : [];

  historyEl.innerHTML = `
    <div class="history-head">
      <div>
        <p class="eyebrow">RAP history and prediction</p>
        <h2>${escapeHtml(payload.name)}</h2>
      </div>
      <div class="${change >= 0 ? "profit" : "loss"}">
        ${change >= 0 ? "+" : "-"}${formatDiamonds(Math.abs(change))} (${changePercent.toFixed(1)}%)
      </div>
    </div>
    ${buildSparkline(points, forecastPoints)}
    <div id="historyTooltip" class="history-tooltip">Touch or hover the chart to inspect a point.</div>
    <div class="history-stats">
      <span>Current <strong>${formatDiamonds(last)}</strong></span>
      <span>Low <strong>${formatDiamonds(min)}</strong></span>
      <span>High <strong>${formatDiamonds(max)}</strong></span>
      ${prediction ? `<span>7 day forecast <strong>${formatDiamonds(prediction.predicted7)}</strong></span>` : ""}
      ${prediction ? `<span>30 day forecast <strong>${formatDiamonds(prediction.predicted30)}</strong></span>` : ""}
      ${prediction ? `<span>Confidence <strong>${escapeHtml(prediction.confidence)}</strong></span>` : ""}
      <span>Points <strong>${payload.history.length.toLocaleString()}</strong></span>
    </div>
  `;

  attachChartInspector(points, forecastPoints);
}

function buildForecastPoints(points, prediction) {
  const [lastTimestamp, currentRap] = points[points.length - 1];
  const dailyTrend = Number(prediction.dailyTrendPercent || 0) / 100;
  const forecast = [[lastTimestamp, currentRap, "Now"]];

  for (let day = 1; day <= 30; day += 1) {
    const timestamp = lastTimestamp + day * 86400;
    const rap = day === 7
      ? prediction.predicted7
      : day === 30
        ? prediction.predicted30
        : Math.max(1, Math.round(currentRap * Math.pow(1 + dailyTrend, day)));
    forecast.push([timestamp, rap, `${day} day forecast`]);
  }

  return forecast;
}

function buildSparkline(points, forecastPoints = []) {
  const width = 720;
  const height = 240;
  const padding = 18;
  const divider = width / 2;
  const values = points.map(([, value]) => value).concat(forecastPoints.map(([, value]) => value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);

  const historyStep = points.length > 1 ? (divider - padding) / (points.length - 1) : 0;
  const forecastStep = forecastPoints.length > 1 ? (width - padding - divider) / (forecastPoints.length - 1) : 0;
  const pointY = (value) => height - padding - ((value - min) / span) * (height - padding * 2);
  const historyPath = points.map(([, value], index) => {
    const x = padding + index * historyStep;
    const y = pointY(value);
    return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  const forecastPath = forecastPoints.map(([, value], index) => {
    const x = divider + index * forecastStep;
    const y = height - padding - ((value - min) / span) * (height - padding * 2);
    return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");

  return `
    <svg id="historyChart" class="history-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="RAP price history chart">
      <path class="history-grid" d="M ${padding} ${padding} H ${width - padding} M ${padding} ${height / 2} H ${width - padding} M ${padding} ${height - padding} H ${width - padding}"></path>
      <rect class="history-past-zone" x="${padding}" y="${padding}" width="${divider - padding}" height="${height - padding * 2}"></rect>
      <rect class="history-future-zone" x="${divider}" y="${padding}" width="${width - padding - divider}" height="${height - padding * 2}"></rect>
      <line class="history-now-line" x1="${divider}" y1="${padding}" x2="${divider}" y2="${height - padding}"></line>
      <text class="history-zone-label" x="${padding + 4}" y="${padding + 16}">Previous value</text>
      <text class="history-zone-label" x="${divider + 8}" y="${padding + 16}">Future prediction</text>
      <path class="history-line" d="${historyPath}"></path>
      ${forecastPath ? `<path class="history-line prediction-line" d="${forecastPath}"></path>` : ""}
      <line id="historyCursorLine" class="history-cursor-line" x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" hidden></line>
      <circle id="historyCursorDot" class="history-cursor-dot" cx="${padding}" cy="${height - padding}" r="7" hidden></circle>
    </svg>
  `;
}

function attachChartInspector(points, forecastPoints = []) {
  const chart = document.querySelector("#historyChart");
  const tooltip = document.querySelector("#historyTooltip");
  const line = document.querySelector("#historyCursorLine");
  const dot = document.querySelector("#historyCursorDot");
  if (!chart || !tooltip || !line || !dot) return;

  const width = 720;
  const height = 240;
  const padding = 18;
  const divider = width / 2;
  const values = points.map(([, value]) => value).concat(forecastPoints.map(([, value]) => value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const historyStep = points.length > 1 ? (divider - padding) / (points.length - 1) : 0;
  const forecastStep = forecastPoints.length > 1 ? (width - padding - divider) / (forecastPoints.length - 1) : 0;

  function inspect(clientX) {
    const rect = chart.getBoundingClientRect();
    if (!rect.width) return;
    const xRatio = (clientX - rect.left) / rect.width;
    const svgX = Math.min(width - padding, Math.max(padding, xRatio * width));
    const usingForecast = forecastPoints.length && svgX >= divider;
    const activePoints = usingForecast ? forecastPoints : points;
    const step = usingForecast ? forecastStep : historyStep;
    const origin = usingForecast ? divider : padding;
    const index = Math.min(activePoints.length - 1, Math.max(0, Math.round((svgX - origin) / Math.max(step, 1))));
    if (!activePoints[index]) return;
    const [timestamp, rap, label] = activePoints[index];
    const x = origin + index * step;
    const y = height - padding - ((rap - min) / span) * (height - padding * 2);
    const date = new Date(timestamp * 1000);

    line.hidden = false;
    dot.hidden = false;
    line.setAttribute("x1", x);
    line.setAttribute("x2", x);
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    tooltip.innerHTML = `
      <strong>${formatDiamonds(rap)}</strong>
      <span>${escapeHtml(label || "Previous value")} - ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
    `;
  }

  chart.addEventListener("pointermove", (event) => inspect(event.clientX));
  chart.addEventListener("pointerdown", (event) => inspect(event.clientX));
  chart.addEventListener("pointerleave", () => {
    line.hidden = true;
    dot.hidden = true;
  });
}

function formatMetric(label, value, suffix) {
  if (value === null || value === undefined) return `${label} n/a`;
  const number = Number(value);
  if (Number.isNaN(number)) return `${label} n/a`;
  return `${label} ${Math.round(number)}${suffix}`;
}

function formatDiamonds(value) {
  const number = Number(value || 0);
  if (number >= 1000000000) return `${trimNumber(number / 1000000000)}b`;
  if (number >= 1000000) return `${trimNumber(number / 1000000)}m`;
  if (number >= 1000) return `${trimNumber(number / 1000)}k`;
  return number.toLocaleString();
}

function trimNumber(value) {
  return value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
