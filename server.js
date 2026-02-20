const express = require("express");
const fs = require("fs");
const path = require("path");

// ✅ Node 18+는 fetch 내장. (혹시 fetch가 없다고 나오면 아래 안내 참고)
const fetchFn = global.fetch;

const app = express();
app.use(express.json({ limit: "1mb" }));

// (선택) 같은 폴더에 있는 HTML/CSS/JS 파일을 바로 서비스
app.use(express.static(__dirname));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY 환경변수가 비어있어요. setx로 등록했는지 확인하세요.");
}

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
      const content = (typeof m.content === "string" ? m.content : (typeof m.text === "string" ? m.text : "")).trim();
      return { role, content };
    })
    .filter(m => m.content.length > 0);
}

// 🔹 공통 OpenAI 호출 함수 (Responses API 규격 준수)
async function callOpenAI(systemPrompt, messages) {
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

  const response = await fetchFn("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      // ✅ system은 instructions로 넣는 게 가장 안전
      instructions: systemPrompt || "",
      input,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`OpenAI API 오류 (${response.status}): ${errText}`);
  }

  const data = await response.json();

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
    const answer = await callOpenAI(mulgaSystem, req.body.messages);
    res.json({ text: answer });
  } catch (e) {
    console.error("❌ /api/mulgatogtog 오류:", e.message);
    res.status(500).json({ text: "물가톡톡 서버 오류", detail: e.message });
  }
});

// 🔹 산업톡톡
app.post("/api/saneobtogtog", async (req, res) => {
  try {
    const answer = await callOpenAI(sanupSystem, req.body.messages);
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
app.listen(PORT, () => {
  console.log(`✅ http://localhost:${PORT} 실행 중`);
  console.log("✅ API: POST /api/mulgatogtog  |  POST /api/saneobtogtog");
});
