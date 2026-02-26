const express = require("express");
const fs = require("fs");
const path = require("path");

// ✅ Node 18+는 fetch 내장
const fetchFn = global.fetch;

const app = express();
app.use(express.json({ limit: "1mb" }));

// (선택) 같은 폴더에 있는 HTML/CSS/JS 파일을 바로 서비스
app.use(express.static(__dirname));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY 환경변수가 비어있어요. Render 환경변수 설정을 확인하세요.");
}

// ✅ Vector Store IDs (사용자 제공)
const VS_MULGA = "vs_699fec9f42b8819188937d8b856c94ea"; // 물가정보
const VS_SANUP = "vs_69a001fb3f148191ae4117046b412fb5"; // 산업활동

// ✅ 최신 필터 준비 여부(벡터스토어별)
const latestFilterReady = { [VS_MULGA]: false, [VS_SANUP]: false };

// 🔹 지침 파일 로드 (없으면 서버가 바로 죽지 않게 안전 처리)
function safeRead(fileName) {
  try {
    return fs.readFileSync(path.join(__dirname, fileName), "utf8");
  } catch (e) {
    console.warn(`⚠️ ${fileName} 파일을 못 읽었어요. 같은 폴더에 있는지 확인!`);
    return "";
  }
}

const mulgaSystem = safeRead("mulga_prompt.txt");
const sanupSystem = safeRead("sanup_prompt.txt");

// ✅ 프론트에서 messages를 어떤 키로 보내도 흡수 (content/text 둘 다)
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(m => m && typeof m === "object")
    .map(m => {
      const role = m.role === "assistant" ? "assistant" : "user";
      const content = (
        typeof m.content === "string"
          ? m.content
          : typeof m.text === "string"
            ? m.text
            : ""
      ).trim();
      return { role, content };
    })
    .filter(m => m.content.length > 0);
}

function extractPeriod(filename) {
  // ex) CPI_2026-01.pdf, IND_2025-12.pdf
  const m = String(filename || "").match(/(\d{4}-\d{2})/);
  return m ? m[1] : null;
}

function periodToInt(p) {
  const parts = String(p).split("-");
  if (parts.length !== 2) return null;
  const y = Number(parts[0]);
  const mo = Number(parts[1]);
  if (!Number.isFinite(y) || !Number.isFinite(mo)) return null;
  return y * 100 + mo;
}

async function openaiFetch(url, { method = "GET", body = null } = {}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY가 비어있습니다.");
  if (!fetchFn) throw new Error("현재 Node에 fetch가 없습니다. Node 18 이상 필요");

  const res = await fetchFn(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI API 오류 (${res.status}): ${errText}`);
  }

  return await res.json();
}

async function listVectorStoreFiles(vectorStoreId, limit = 100) {
  return await openaiFetch(`https://api.openai.com/v1/vector_stores/${vectorStoreId}/files?limit=${limit}`);
}

async function retrieveFile(fileId) {
  return await openaiFetch(`https://api.openai.com/v1/files/${fileId}`);
}

async function updateVectorStoreFile(vectorStoreId, vectorStoreFileId, attributes) {
  // API는 vector_store_file 업데이트를 지원 (attributes)
  // 엔드포인트는 POST를 사용 (일부 SDK는 update로 추상화)
  return await openaiFetch(
    `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${vectorStoreFileId}`,
    { method: "POST", body: { attributes } }
  );
}

/**
 * 벡터스토어 내 파일명이 YYYY-MM을 포함하면, 가장 최신(최대 YYYYMM) 파일만 is_latest=true로 지정.
 * - period: "YYYY-MM"
 * - period_int: YYYYMM
 * - is_latest: boolean
 */
async function refreshLatestInVectorStore(vectorStoreId) {
  try {
    const list = await listVectorStoreFiles(vectorStoreId, 100);
    const data = Array.isArray(list.data) ? list.data : [];

    const items = [];
    for (const vsFile of data) {
      const fileId = vsFile.file_id;
      const vsFileId = vsFile.id;
      if (!fileId || !vsFileId) continue;

      const f = await retrieveFile(fileId);
      const filename = f.filename || "";
      const period = extractPeriod(filename);
      if (!period) continue;
      const periodInt = periodToInt(period);
      if (!periodInt) continue;

      items.push({
        vector_store_file_id: vsFileId,
        file_id: fileId,
        filename,
        period,
        period_int: periodInt,
      });
    }

    if (items.length === 0) {
      console.warn(`⚠️ ${vectorStoreId}: YYYY-MM 패턴 파일을 찾지 못했어요. (필터 최신 적용 불가)`);
      return { ok: false, reason: "no_period_files" };
    }

    items.sort((a, b) => b.period_int - a.period_int);
    const latestPeriod = items[0].period;

    for (const it of items) {
      await updateVectorStoreFile(vectorStoreId, it.vector_store_file_id, {
        period: it.period,
        period_int: it.period_int,
        is_latest: it.period === latestPeriod,
        filename: it.filename,
      });
    }

    console.log(`✅ ${vectorStoreId}: 최신 자료 period=${latestPeriod} 로 지정 완료 (총 ${items.length}개 파일)`);
    return { ok: true, latestPeriod, count: items.length };
  } catch (e) {
    console.warn(`⚠️ ${vectorStoreId}: 최신 지정(refresh) 실패 - ${e.message}`);
    // 실패해도 서버는 동작하게 두되, 최신필터는 기대대로 안될 수 있음
    return { ok: false, reason: "refresh_failed", error: e.message };
  }
}

// 🔹 공통 OpenAI 호출 함수 (Responses API + File Search)
async function callOpenAI(systemPrompt, messages, options = {}) {
  const {
    vectorStoreId = null,
    domainLabel = "",
    enforceLatest = true,
    maxNumResults = 8,
  } = options;

  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY가 비어있습니다.");
  if (!fetchFn) {
    throw new Error(
      "현재 Node에 fetch가 없습니다. Node 18 이상 설치하거나, node-fetch를 설치/적용해야 합니다."
    );
  }

  const normalized = normalizeMessages(messages);

  // ✅ Responses API: user -> input_text, assistant -> output_text
  const input = normalized.map(m => {
    if (m.role === "assistant") {
      return { role: "assistant", content: [{ type: "output_text", text: m.content }] };
    }
    return { role: "user", content: [{ type: "input_text", text: m.content }] };
  });

  const strictInstructions = `
${systemPrompt || ""}

[중요 규칙]
- 반드시 file_search(벡터스토어) 검색 결과에 근거해서만 답변하세요.
- 벡터스토어 검색 결과에서 근거를 찾지 못하면: "등록된 자료에서 확인되지 않습니다."라고만 답하고 추측/일반지식으로 보완하지 마세요.
- 답변은 가능한 한 자료의 기준월/발표월(예: 2026-01)과 핵심 수치를 함께 제시하세요.
${enforceLatest ? "- 최신 자료만 사용하세요. (is_latest=true로 필터된 검색 결과만 근거로 사용)" : ""}
`.trim();

  const body = {
    model: "gpt-4.1",
    instructions: strictInstructions,
    input,
    tools: [],
    include: ["file_search_call.results"], // ✅ 검색결과를 서버가 확인
  };

  if (vectorStoreId) {
    const tool = {
      type: "file_search",
      vector_store_ids: [vectorStoreId],
      max_num_results: maxNumResults,
    };

    // ✅ 최신만 필터 (refreshLatestInVectorStore가 attributes 설정해둔 경우)
    if (enforceLatest) {
      tool.filters = { type: "eq", key: "is_latest", value: true };
    }

    body.tools.push(tool);
  }

  const response = await fetchFn("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`OpenAI API 오류 (${response.status}): ${errText}`);
  }

  const data = await response.json();

  // ✅ file_search 결과가 0개면 아예 서버가 “자료 없음”으로 고정 응답
  const searchResults =
    (data.output || [])
      .filter(o => o.type === "file_search_call")
      .flatMap(o => o.results || []);

  if (vectorStoreId && (!searchResults || searchResults.length === 0)) {
    const label = domainLabel ? `(${domainLabel}) ` : "";
    return `${label}등록된 벡터 자료(최신 자료 포함)에서 관련 내용을 찾지 못했습니다.\n자료가 벡터스토어에 없으면 답변할 수 없습니다.`;
  }

  // ✅ 응답 텍스트 추출 (output_text 모으기)
  const text =
    (data.output || [])
      .flatMap(o => o.content || [])
      .filter(c => c.type === "output_text")
      .map(c => c.text)
      .join("\n") || "";

  return text.trim();
}

// 🔹 물가톡톡
app.post("/api/mulgatogtog", async (req, res) => {
  try {
    const answer = await callOpenAI(mulgaSystem, req.body.messages, {
      vectorStoreId: VS_MULGA,
      domainLabel: "물가정보",
      enforceLatest: latestFilterReady[VS_MULGA],
      maxNumResults: 8,
    });
    res.json({ text: answer });
  } catch (e) {
    console.error("❌ /api/mulgatogtog 오류:", e.message);
    res.status(500).json({ text: "물가톡톡 서버 오류", detail: e.message });
  }
});

// 🔹 산업톡톡
app.post("/api/saneobtogtog", async (req, res) => {
  try {
    const answer = await callOpenAI(sanupSystem, req.body.messages, {
      vectorStoreId: VS_SANUP,
      domainLabel: "산업활동",
      enforceLatest: latestFilterReady[VS_SANUP],
      maxNumResults: 8,
    });
    res.json({ text: answer });
  } catch (e) {
    console.error("❌ /api/saneobtogtog 오류:", e.message);
    res.status(500).json({ text: "산업톡톡 서버 오류", detail: e.message });
  }
});

// (선택) 루트로 들어오면 index 파일 보여주기
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index_public_v3.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ http://localhost:${PORT} 실행 중`);
  console.log("✅ API: POST /api/mulgatogtog  |  POST /api/saneobtogtog");

  // ✅ 서버 시작 시 최신 파일 자동 지정
  // - 벡터스토어 안에 파일이 1개면 그 파일이 최신
  // - 2개 이상이면 파일명 YYYY-MM 비교해서 최신만 is_latest=true
    const r1 = await refreshLatestInVectorStore(VS_MULGA);
  latestFilterReady[VS_MULGA] = !!(r1 && r1.ok);

  const r2 = await refreshLatestInVectorStore(VS_SANUP);
  latestFilterReady[VS_SANUP] = !!(r2 && r2.ok);

  if (!latestFilterReady[VS_MULGA]) console.warn("⚠️ 물가 벡터스토어: 최신 필터(is_latest) 설정에 실패해서 전체 파일 검색으로 동작합니다.");
  if (!latestFilterReady[VS_SANUP]) console.warn("⚠️ 산업 벡터스토어: 최신 필터(is_latest) 설정에 실패해서 전체 파일 검색으로 동작합니다.");
});
