const DDRAGON = "https://ddragon.leagueoflegends.com";

let VERSION = null;
const spellCooldowns = {}; // ddragon 스펠 id -> 기본 쿨다운(초)

// 현재 렌더된 적 명단 키 (바뀔 때만 재렌더 → 타이머 보존)
let currentRosterKey = "";
// 진행 중인 쿨다운: tkey -> { endTime }
const timers = {};

// ── ddragon 정적 데이터 로드 (스펠 기본 쿨다운 표) ─────────────────
async function loadDdragon() {
  try {
    const versions = await fetch(`${DDRAGON}/api/versions.json`).then((r) => r.json());
    VERSION = versions[0]; // 최신 패치
    const summoner = await fetch(
      `${DDRAGON}/cdn/${VERSION}/data/en_US/summoner.json`
    ).then((r) => r.json());
    for (const key in summoner.data) {
      const s = summoner.data[key]; // s.id 예: "SummonerFlash", s.cooldown: [300]
      spellCooldowns[s.id] = Array.isArray(s.cooldown) ? s.cooldown[0] : 0;
    }
  } catch (e) {
    console.error("ddragon 로드 실패:", e);
    VERSION = VERSION || "15.1.1"; // 폴백 (이미지 일부 깨질 수 있음)
  }
}

// ── 챔피언 이미지 URL (로케일 무관한 rawChampionName 사용) ─────────
function champImg(rawChampionName, championName) {
  let id = "";
  if (rawChampionName) {
    // "game_character_displayname_Annie" -> "Annie"
    id = rawChampionName.replace("game_character_displayname_", "").trim();
  }
  if (!id) id = (championName || "").replace(/[^A-Za-z]/g, "");
  return `${DDRAGON}/cdn/${VERSION}/img/champion/${id}.png`;
}

// ── 스펠 정보 추출 (로케일 무관한 rawDescription 사용) ────────────
function spellInfo(spellObj) {
  // spellObj: { displayName, rawDescription, rawDisplayName }
  // rawDescription 예: "GeneratedTip_SummonerSpell_SummonerFlash_Description"
  const raw = spellObj.rawDescription || spellObj.rawDisplayName || "";
  const parts = raw.split("_");
  const id = parts.length >= 3 ? parts[2] : ""; // "SummonerFlash"
  return {
    id,
    name: spellObj.displayName || id,
    img: id ? `${DDRAGON}/cdn/${VERSION}/img/spell/${id}.png` : "",
    cd: spellCooldowns[id] || 0,
  };
}

function fmt(sec) {
  if (sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}`;
}

// ── 적 카드 렌더 (명단이 바뀔 때만 호출) ──────────────────────────
function render(enemies) {
  const container = document.getElementById("enemies");
  container.innerHTML = "";

  enemies.forEach((p, idx) => {
    const key = p.riotId || p.riotIdGameName || p.championName || `e${idx}`;

    const card = document.createElement("div");
    card.className = "card";

    const champ = document.createElement("img");
    champ.className = "champ";
    champ.src = champImg(p.rawChampionName, p.championName);
    champ.title = p.championName || "";
    card.appendChild(champ);

    const name = document.createElement("span");
    name.className = "cname";
    name.textContent = p.championName || "";
    card.appendChild(name);

    const spells = document.createElement("div");
    spells.className = "spells";

    const sp = p.summonerSpells || {};
    [sp.summonerSpellOne, sp.summonerSpellTwo].forEach((spRaw, sIdx) => {
      if (!spRaw) return;
      const info = spellInfo(spRaw);
      const tkey = `${key}|${sIdx}`;

      const wrap = document.createElement("div");
      wrap.className = "spell";
      wrap.dataset.tkey = tkey;

      const img = document.createElement("img");
      img.src = info.img;
      img.alt = info.name;
      img.title = `${info.name} (${info.cd}s) — 클릭 시작 / 다시 클릭 취소`;
      wrap.appendChild(img);

      const cdLabel = document.createElement("span");
      cdLabel.className = "cdtext";
      wrap.appendChild(cdLabel);

      wrap.addEventListener("click", () => toggleTimer(tkey, info.cd));
      spells.appendChild(wrap);
    });

    card.appendChild(spells);
    container.appendChild(card);
  });

  updateTimerUI(); // 재렌더 후 진행 중인 타이머 다시 반영
}

// ── 클릭: 쿨 시작 / 다시 클릭하면 취소 ────────────────────────────
function toggleTimer(tkey, cd) {
  if (timers[tkey]) {
    delete timers[tkey];
  } else {
    if (!cd || cd <= 0) return;
    timers[tkey] = { endTime: Date.now() + cd * 1000 };
  }
  updateTimerUI();
}

// ── 0.25초마다 남은 시간 표시 갱신 ────────────────────────────────
function updateTimerUI() {
  const now = Date.now();
  document.querySelectorAll(".spell").forEach((el) => {
    const tkey = el.dataset.tkey;
    const label = el.querySelector(".cdtext");
    const t = timers[tkey];
    if (t) {
      const remain = (t.endTime - now) / 1000;
      if (remain <= 0) {
        delete timers[tkey];
        el.classList.remove("active");
        label.textContent = "";
      } else {
        el.classList.add("active");
        label.textContent = fmt(remain);
      }
    } else {
      el.classList.remove("active");
      label.textContent = "";
    }
  });
}

// ── 게임 데이터 폴링 ─────────────────────────────────────────────
async function poll() {
  const statusEl = document.getElementById("status");
  const emptyEl = document.getElementById("empty");
  const enemiesEl = document.getElementById("enemies");

  const res = await window.lcu.getGameData();

  if (!res.ok) {
    statusEl.style.color = "#888";
    emptyEl.style.display = "block";
    enemiesEl.style.display = "none";
    currentRosterKey = "";
    return;
  }

  const data = res.data;
  const all = data.allPlayers || [];
  const active = data.activePlayer || {};
  const myId = active.riotId || active.summonerName || "";

  // 내 플레이어를 찾아 우리 팀(ORDER/CHAOS)을 판별 → 반대 팀이 적
  const me = all.find(
    (p) =>
      p.riotId === myId ||
      p.summonerName === myId ||
      (active.riotIdGameName && p.riotIdGameName === active.riotIdGameName)
  );
  const myTeam = me ? me.team : "ORDER";
  const enemies = all.filter((p) => p.team !== myTeam);

  statusEl.style.color = "#3fb950";
  emptyEl.style.display = "none";
  enemiesEl.style.display = "flex";

  // 명단이 바뀐 경우에만 재렌더 (그래야 돌고 있는 타이머가 안 날아감)
  const rosterKey = enemies.map((p) => p.riotId || p.championName).join(",");
  if (rosterKey !== currentRosterKey) {
    currentRosterKey = rosterKey;
    render(enemies);
  }
}

// ── 닫기 버튼 ────────────────────────────────────────────────────
document.getElementById("close").addEventListener("click", () => window.close());

// ── 시작 ─────────────────────────────────────────────────────────
(async function init() {
  await loadDdragon();
  poll();
  setInterval(poll, 2000); // 게임 데이터 폴링 (2초)
  setInterval(updateTimerUI, 250); // 타이머 표시 갱신
})();
