const DDRAGON = "https://ddragon.leagueoflegends.com";

let VERSION = null;
const spellCooldowns = {}; // ddragon 스펠 id -> 기본 쿨다운(초)

// 현재 렌더된 적 명단 키 (바뀔 때만 재렌더 → 타이머 보존)
let currentRosterKey = "";
// 진행 중인 쿨다운: tkey -> { endTime }
const timers = {};

// ── 하드코딩 폴백 쿨다운 표 (ddragon 미수록 스펠 / 로드 실패 대비) ──
// 패치 26.12 기준. ddragon 로드 성공 시 해당 값으로 덮어써짐.
const FALLBACK_COOLDOWNS = {
  // 소환사 리프트
  SummonerFlash: 300,
  SummonerDot: 180,                       // 점화
  SummonerTeleport: 360,                  // 일반 텔포 (10분 전)
  SummonerTeleportUpgrade: 240,           // 강화 텔포 (10분 후 자동 교체)
  SummonerSmite: 15,                      // 강타
  SummonerSmitePlayerGanker: 15,          // 강화 강타 (퀘스트 완료 후)
  SummonerSmiteAvatarOffensive: 15,       // 불꽃발톱 강타
  SummonerSmiteAvatarDefensive: 15,       // 이끼밟기 강타
  SummonerSmiteAvatarUtility: 15,         // 구름걷기 강타
  SummonerHeal: 240,                      // 회복
  SummonerExhaust: 210,                   // 탈진
  SummonerBarrier: 180,                   // 방어막
  SummonerHaste: 240,                     // 유체화 (Ghost)
  SummonerBoost: 210,                     // 정화 (Cleanse)
  // 헥스플래시 (우주적 통찰 룬) — V1, V2 둘 다 대응
  SummonerFlashPerksHextechFlashtraption: 20,
  SummonerFlashPerksHextechFlashtraptionV2: 20,
  // ARAM
  SummonerSnowball: 80,                   // 표식 (Mark)
  SummonerSnowURFSnowball_Mark: 80,
};

// ── ddragon 정적 데이터 로드 (스펠 기본 쿨다운 표) ─────────────────
async function loadDdragon() {
  // 먼저 폴백 값으로 채워둠 → ddragon 로드 실패해도 기본 스펠은 동작
  Object.assign(spellCooldowns, FALLBACK_COOLDOWNS);
  try {
    const versions = await fetch(`${DDRAGON}/api/versions.json`).then((r) => r.json());
    VERSION = versions[0];
    const summoner = await fetch(
      `${DDRAGON}/cdn/${VERSION}/data/en_US/summoner.json`
    ).then((r) => r.json());
    for (const key in summoner.data) {
      const s = summoner.data[key];
      // ddragon 값으로 덮어쓰기 (더 정확한 최신 값)
      spellCooldowns[s.id] = Array.isArray(s.cooldown) ? s.cooldown[0] : 0;
    }
    console.log(`ddragon 로드 완료: ${VERSION}, 스펠 ${Object.keys(spellCooldowns).length}개`);
  } catch (e) {
    const msg = `ddragon 로드 실패: ${e.message}`;
    console.error(msg);
    window.lcu.logError(msg);
    VERSION = VERSION || "16.11.1";
  }
}

// ── [FIX 2] 챔피언 이미지 URL ────────────────────────────────────
// rawChampionName 패턴이 두 가지 존재:
// 패턴A: "game_character_displayname_Seraphine" → "Seraphine"
// 패턴B: "Character_Seraphine_Name"             → "Seraphine"
function extractChampId(rawChampionName, championName) {
  if (rawChampionName) {
    // 패턴A
    if (rawChampionName.startsWith("game_character_displayname_")) {
      return rawChampionName.replace("game_character_displayname_", "").trim();
    }
    // 패턴B: "Character_Seraphine_Name" → 중간 토큰 추출
    const m = rawChampionName.match(/^Character_(.+)_Name$/);
    if (m) return m[1].trim();
  }
  // 폴백: championName에서 영문자만 (한국어면 빈 문자열이 되지만 onerror가 처리)
  return (championName || "").replace(/[^A-Za-z]/g, "");
}

// 이미지 로드 실패한 챔프는 캐싱 → 2초 폴링마다 로그 도배 방지
const failedChampImages = new Set();

function champImg(rawChampionName, championName) {
  const id = extractChampId(rawChampionName, championName);
  return `${DDRAGON}/cdn/${VERSION}/img/champion/${id}.png`;
}

// ── [FIX 3] 스펠 정보 추출 — 다양한 rawDescription 패턴 처리 ────
// 패턴1 (일반): "GeneratedTip_SummonerSpell_SummonerFlash_Description"
// 패턴2 (일부): "GeneratedTip_SummonerSpell_SummonerFlash_DisplayName"
// 패턴3 (폴백): rawDisplayName이 "SummonerFlash" 형태로 직접 올 때
function extractSpellId(raw) {
  if (!raw) return "";
  // 패턴1·2: _로 분리해서 3번째 토큰이 ID
  const parts = raw.split("_");
  if (parts.length >= 3 && parts[0] === "GeneratedTip") {
    return parts[2]; // "SummonerFlash"
  }
  // 패턴3: "Summoner"로 시작하는 단어가 그대로 오면 그게 ID
  if (raw.startsWith("Summoner")) return raw;
  return "";
}

function spellInfo(spellObj) {
  if (!spellObj) return { id: "", name: "?", img: "", cd: 0 };

  // rawDescription → rawDisplayName → displayName 순으로 시도
  const id =
    extractSpellId(spellObj.rawDescription) ||
    extractSpellId(spellObj.rawDisplayName) ||
    "";

  // ddragon에 없는 새 스펠이면 cd=0 → 클릭해도 타이머 안 시작
  // 그 경우엔 스펠 이름을 tooltip에 표시해서 "얼마짜리인지" 알 수 있게
  const cd = spellCooldowns[id] || 0;

  return {
    id,
    name: spellObj.displayName || id || "?",
    img: id ? `${DDRAGON}/cdn/${VERSION}/img/spell/${id}.png` : "",
    cd,
  };
}

function fmt(sec) {
  if (sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}`;
}

// ── 적 카드 렌더 ──────────────────────────────────────────────────
function render(enemies) {
  const container = document.getElementById("enemies");
  container.innerHTML = "";

  enemies.forEach((p, idx) => {
    const key = p.riotId || p.riotIdGameName || p.championName || `e${idx}`;

    const card = document.createElement("div");
    card.className = "card";

    // 챔피언 이미지
    const champ = document.createElement("img");
    champ.className = "champ";
    champ.src = champImg(p.rawChampionName, p.championName);
    champ.title = p.championName || "";
    // [FIX 2] 이미지 로드 실패 시 이니셜 플레이스홀더로 대체
    champ.onerror = function () {
      this.onerror = null;
      // 이미 실패 기록된 챔프는 로그 중복 방지
      if (!failedChampImages.has(p.championName)) {
        failedChampImages.add(p.championName);
        const msg = `챔피언 이미지 로드 실패: championName="${p.championName}" rawChampionName="${p.rawChampionName || ''}" src="${this.src}"`;
        console.error(msg);
        window.lcu.logError(msg);
      }
      this.style.display = "none";
      const ph = document.createElement("div");
      ph.className = "champ-ph";
      ph.textContent = (p.championName || "?").slice(0, 2).toUpperCase();
      card.insertBefore(ph, this.nextSibling);
    };
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
      // [FIX 3] ddragon에 없는 새 스펠은 쿨 0 → tooltip에 "쿨 미확인" 표시
      const cdText = info.cd > 0 ? `${info.cd}s` : "쿨 미확인";
      wrap.title = `${info.name} (${cdText}) — 클릭 시작 / 다시 클릭 취소`;

      if (info.img) {
        const img = document.createElement("img");
        img.src = info.img;
        img.alt = info.name;
        // [FIX 3] 스펠 이미지 로드 실패 시 텍스트 폴백
        img.onerror = function () {
          this.onerror = null;
          this.style.display = "none";
          const lb = document.createElement("span");
          lb.className = "spell-ph";
          lb.textContent = info.name.replace("Summoner", "").slice(0, 2);
          wrap.appendChild(lb);
        };
        wrap.appendChild(img);
      } else {
        // ID조차 없는 미인식 스펠
        const lb = document.createElement("span");
        lb.className = "spell-ph";
        lb.textContent = "?";
        wrap.appendChild(lb);
      }

      const cdLabel = document.createElement("span");
      cdLabel.className = "cdtext";
      wrap.appendChild(cdLabel);

      wrap.addEventListener("click", () => {
        if (info.cd > 0) toggleTimer(tkey, info.cd);
        else {
          const msg = `미인식 스펠: displayName="${info.name}" id="${info.id}" rawDescription="${spRaw.rawDescription || ''}" rawDisplayName="${spRaw.rawDisplayName || ''}"`;
          console.warn(msg);
          window.lcu.logError(msg);
        }
      });
      spells.appendChild(wrap);
    });

    card.appendChild(spells);
    container.appendChild(card);
  });

  updateTimerUI();
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

// ── [FIX 1] 전역 단축키 자리 (현재는 main.js의 keepOnTopTimer가 자동 처리)
// 필요시 여기에 키보드 단축키 추가 가능

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

  if (all.length === 0) {
    statusEl.style.color = "#888";
    emptyEl.style.display = "block";
    enemiesEl.style.display = "none";
    currentRosterKey = "";
    return;
  }

  const gname = (s) => (s || "").split("#")[0].trim().toLowerCase();
  const myName =
    gname(active.riotId) || gname(active.riotIdGameName) || gname(active.summonerName);
  const me = myName
    ? all.find(
        (p) =>
          gname(p.riotId) === myName ||
          gname(p.riotIdGameName) === myName ||
          gname(p.summonerName) === myName
      )
    : null;

  const myTeam = me ? me.team : null;
  const enemies = myTeam ? all.filter((p) => p.team !== myTeam) : all;

  statusEl.style.color = me ? "#3fb950" : "#e3b341";
  statusEl.title = me ? "게임 연결됨" : "내 팀 자동판별 실패 — 전체 표시 중";
  emptyEl.style.display = "none";
  enemiesEl.style.display = "flex";

  const rosterKey = enemies.map((p) => p.riotId || p.championName).join(",");
  if (rosterKey !== currentRosterKey) {
    currentRosterKey = rosterKey;
    render(enemies);
  }
}

// ── Click-Through 토글 ────────────────────────────────────────────
// 기본: 마우스가 게임으로 통과 (오버레이 위에서 클릭해도 게임에 전달됨)
// 예외: 클릭 가능한 요소(스펠 아이콘, 타이틀바, 닫기) 위에 올라오면
//       잠깐 클릭을 오버레이가 받음 → 스펠 클릭 가능
//
// 핵심: .no-passthrough 클래스가 붙은 요소 위에서만 클릭이 오버레이로 옴
//       나머지 빈 공간은 전부 게임으로 통과 → 이동/스킬 사용에 지장 없음

const INTERACTIVE_SELECTOR = '.spell, #titlebar, #close, #status';
const RESIZE_MARGIN = 6; // 창 테두리에서 몇 px 안쪽까지 리사이즈 영역으로 볼지

// 마우스가 창 테두리(리사이즈 핸들) 근처인지 판별
function isNearEdge(e) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const x = e.clientX;
  const y = e.clientY;
  return x <= RESIZE_MARGIN || x >= w - RESIZE_MARGIN ||
         y <= RESIZE_MARGIN || y >= h - RESIZE_MARGIN;
}

// ── 타이틀바 JS 드래그 ───────────────────────────────────────────
// -webkit-app-region: drag 는 click-through(setIgnoreMouseEvents)와 충돌해서
// mousedown → mousemove 방식으로 직접 창 이동 처리
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;

const titlebar = document.getElementById('titlebar');

titlebar.addEventListener('mousedown', (e) => {
  if (e.target.id === 'close') return; // 닫기 버튼은 드래그 제외
  isDragging = true;
  dragStartX = e.screenX;
  dragStartY = e.screenY;
  window.lcu.setIgnoreMouse(false);
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const dx = e.screenX - dragStartX;
  const dy = e.screenY - dragStartY;
  dragStartX = e.screenX;
  dragStartY = e.screenY;
  window.lcu.moveWindow(dx, dy);
});

document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    window.lcu.setIgnoreMouse(true);
  }
});

// ── Click-Through 토글 (스펠 클릭 + 리사이즈용) ─────────────────
document.addEventListener('mousemove', (e) => {
  if (isDragging) return;
  // 창 테두리 근처: 리사이즈 가능하도록 click-through 끄기
  if (isNearEdge(e)) {
    window.lcu.setIgnoreMouse(false);
    return;
  }
  // 클릭 가능 요소 위: click-through 끄기
  if (e.target.closest(INTERACTIVE_SELECTOR)) {
    window.lcu.setIgnoreMouse(false);
    return;
  }
  // 그 외 빈 영역: 게임으로 통과
  window.lcu.setIgnoreMouse(true);
});

document.addEventListener('mouseover', (e) => {
  if (isNearEdge(e) || e.target.closest(INTERACTIVE_SELECTOR)) {
    window.lcu.setIgnoreMouse(false);
  }
});

document.addEventListener('mouseleave', () => {
  if (!isDragging) window.lcu.setIgnoreMouse(true);
});

document.addEventListener('mouseout', (e) => {
  if (isDragging) return;
  if (
    e.target.closest(INTERACTIVE_SELECTOR) &&
    !e.relatedTarget?.closest(INTERACTIVE_SELECTOR)
  ) {
    window.lcu.setIgnoreMouse(true);
  }
});

// ── 닫기 버튼 ────────────────────────────────────────────────────
document.getElementById("close").addEventListener("click", () => window.close());

// ── 시작 ─────────────────────────────────────────────────────────
(async function init() {
  await loadDdragon();
  poll();
  setInterval(poll, 2000);
  setInterval(updateTimerUI, 250);
})();
