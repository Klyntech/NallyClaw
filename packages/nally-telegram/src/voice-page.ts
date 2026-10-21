export const voicePage = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#101114">
<title>Nally — Voice</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#101114;color:#f5f5f7}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 50% 25%,#25232d 0, #101114 58%)}
main{width:min(100%,520px);display:flex;flex-direction:column;align-items:center;gap:22px;text-align:center}
.brand{font-size:14px;letter-spacing:.22em;text-transform:uppercase;color:#b8b7c4}.brand b{color:#fff}
h1{font-size:clamp(32px,7vw,48px);margin:0;letter-spacing:-.05em}.sub{color:#a8a8b3;line-height:1.55;margin:0;max-width:370px}
.orb-wrap{height:210px;width:210px;display:grid;place-items:center;position:relative;margin:8px 0}
.orb{height:142px;width:142px;border-radius:50%;background:radial-gradient(circle at 35% 28%,#c9b8ff,#7962d7 42%,#30284c 78%);box-shadow:0 0 70px #7e67d966,inset 0 0 25px #ffffff30;transition:transform .25s}
.ring{position:absolute;border:1px solid #a995ed42;border-radius:50%;inset:12px;transition:transform .2s,opacity .2s}.ring:nth-child(2){inset:0}.ring:nth-child(3){inset:25px}
body[data-state="listening"] .ring{animation:pulse 2s ease-out infinite}body[data-state="speaking"] .orb{transform:scale(1.08)}body[data-state="thinking"] .orb{animation:breathe 1.3s ease-in-out infinite}
@keyframes pulse{0%{transform:scale(.88);opacity:.2}50%{opacity:.8}100%{transform:scale(1.12);opacity:.1}}@keyframes breathe{50%{transform:scale(.94);filter:brightness(1.25)}}
.status{font-size:14px;color:#d0c8f8;min-height:20px}.transcript{width:100%;max-height:190px;overflow:auto;text-align:left;display:flex;flex-direction:column;gap:12px}
.line{padding:12px 14px;border-radius:14px;background:#ffffff0a;border:1px solid #ffffff10;line-height:1.5;overflow-wrap:anywhere}.line small{display:block;color:#aaa7b8;font-size:11px;text-transform:uppercase;letter-spacing:.12em;margin-bottom:5px}
.controls{display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap}.btn{border:1px solid #ffffff24;border-radius:999px;padding:13px 19px;background:#ffffff0c;color:#fff;font:inherit;cursor:pointer}.btn:disabled{opacity:.4;cursor:not-allowed}.primary{background:#e8e0ff;color:#17131f;border:0;font-weight:650;min-width:145px}.end{border-color:#f8717140;color:#ffb0b0}
.settings{width:100%;display:grid;gap:10px;text-align:left;margin-top:2px}.settings label{font-size:12px;color:#aaa7b8}.settings input{width:100%;margin-top:6px;padding:12px;border-radius:10px;border:1px solid #ffffff20;background:#15161b;color:#fff;font:inherit}.hint{font-size:12px;color:#777782;line-height:1.5;margin:0}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
</style>
</head>
<body data-state="idle">
<main>
<div class="brand"><b>NALLY</b> / VOICE</div>
<h1>Talk to Nally.</h1>
<p class="sub">A live voice conversation with your personal assistant. Your microphone audio is used for live transcription.</p>
<div class="orb-wrap" aria-hidden="true"><div class="ring"></div><div class="ring"></div><div class="ring"></div><div class="orb"></div></div>
<div class="status" id="status" role="status" aria-live="polite">Ready when you are</div>
<div class="controls">
<button class="btn primary" id="start">Start call</button>
<button class="btn" id="mute" disabled>Mute mic</button>
<button class="btn end" id="end" disabled>End call</button>
</div>
<div class="transcript" id="transcript" aria-live="polite"></div>
<details class="settings">
<summary>Connection settings</summary>
<label>Voice access token
<input id="access" type="password" autocomplete="current-password" placeholder="Enter the Nally voice access token">
</label>
<p class="hint">This is the Nally voice access token configured by the service owner. It is kept in this tab only and is not your Deepgram or ElevenLabs API key.</p>
</details>
<p class="hint">Use headphones for the best experience. Ending the call stops microphone capture and disconnects live transcription.</p>
</main>
<script>
(() => {
const $ = (id) => document.getElementById(id);
const status = $("status"), transcript = $("transcript"), start = $("start"), mute = $("mute"), end = $("end"), access = $("access");
let media, audioContext, source, processor, socket, sessionId, keepAliveTimer, muted = false, busy = false, ended = true, utterance = "", speakingAudio;
const setState = (state, label) => { document.body.dataset.state = state; status.textContent = label; };
const authHeaders = () => ({ "authorization": "Bearer " + access.value.trim() });
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  if (!response.ok) { let msg = "Request failed (" + response.status + ")"; try { msg = (await response.json()).error || msg; } catch {} throw new Error(msg); }
  return response;
}
function addLine(who, text) {
  if (!text) return;
  const line = document.createElement("div"); line.className = "line";
  const label = document.createElement("small"); label.textContent = who;
  const content = document.createElement("div"); content.textContent = text;
  line.append(label, content); transcript.append(line); transcript.scrollTop = transcript.scrollHeight;
}
function floatTo16BitPCM(input, fromRate, toRate = 16000) {
  const ratio = fromRate / toRate, length = Math.floor(input.length / ratio), output = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0; for (let j = start; j < end; j++) sum += input[j];
    const sample = sum / Math.max(1, end - start);
    output[i] = Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767);
  }
  return output;
}
async function speak(text) {
  if (ended) return;
  setState("speaking", "Nally is speaking…");
  const response = await request("/api/voice/speech", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ text }) });
  const blob = await response.blob();
  if (ended) return;
  if (speakingAudio) { speakingAudio.pause(); URL.revokeObjectURL(speakingAudio.src); }
  speakingAudio = new Audio(URL.createObjectURL(blob));
  await speakingAudio.play();
  await new Promise(resolve => { speakingAudio.onended = resolve; speakingAudio.onerror = resolve; });
  if (speakingAudio) URL.revokeObjectURL(speakingAudio.src);
  if (!ended) setState("listening", "Listening… speak naturally");
}
const recentFillers = [];
const fillerOptions = [
  { match: value => value.includes("searching the web"), lines: ["I'm looking that up now.", "Let me find the most relevant sources.", "I'll check a couple of sources first.", "I'm searching for reliable information.", "Let me see what the web turns up."] },
  { match: value => value.includes("fetching page"), lines: ["I'm opening that page now.", "I've found a page to check.", "Let me pull up the page details.", "I'm fetching the page so I can inspect it."] },
  { match: value => value.includes("reading page"), lines: ["Let me go through the page.", "I'm reading through the relevant sections.", "I'll check what the page actually says.", "Let me pull out the useful details."] },
  { match: value => value.includes("reading file"), lines: ["Let me inspect the file first.", "I'm reading through that file.", "I'll trace how this file is put together.", "Let me see how this is wired up."] },
  { match: value => value.includes("searching files"), lines: ["I'm checking the relevant files.", "I'll trace where that comes from.", "Let me find the part that matters.", "I'm looking across the project for that."] },
  { match: value => value.includes("editing file"), lines: ["I'm making that change now.", "I've found where to update it.", "I'm adjusting that part of the code.", "Let me make the change in the right place."] },
  { match: value => value.includes("writing file"), lines: ["I'm writing that out now.", "I'm putting the changes into the file.", "Let me update the implementation.", "I'm applying that edit now."] },
  { match: value => value.includes("running command"), lines: ["I'm running that and checking the result.", "Let's see what the command reports.", "I'm checking the output now.", "I'll verify what that produces."] },
  { match: value => value.includes("searching memory") || value.includes("saving memory"), lines: ["Let me check what I have in memory.", "I'm checking the saved context.", "I'll look at the relevant conversation context.", "Let me check what was saved."] },
  { match: value => value.includes("subagent"), lines: ["I'm splitting up part of the work to check it carefully.", "I'm asking a helper process to inspect one part.", "I'll check this part separately as well."] },
  { match: value => value.includes("using ") && value.includes(" tool"), lines: ["I'm using a tool to check that.", "I'm checking that with the relevant tool.", "Let me use the right tool for this.", "I'm verifying that with a tool."] },
  { match: value => value.includes("thinking"), lines: ["Let me work through this.", "I'm connecting the pieces now.", "I'm working out the next step.", "Give me a moment to reason this through."] },
];
function fillerForProgress(status) {
  const value = String(status || "").toLowerCase();
  const group = fillerOptions.find(option => option.match(value));
  const choices = (group?.lines || ["I'm working through that now.", "Let me check the next step.", "I'm putting the pieces together."])
    .filter(line => !recentFillers.includes(line));
  const pool = choices.length ? choices : (group?.lines || ["I'm working through that now."]);
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  recentFillers.push(chosen);
  if (recentFillers.length > 6) recentFillers.shift();
  return chosen;
}
async function speakFiller(text) {
  if (ended) return;
  const response = await request("/api/voice/speech", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ text }) });
  const blob = await response.blob();
  if (ended) return;
  if (speakingAudio) { speakingAudio.pause(); URL.revokeObjectURL(speakingAudio.src); }
  speakingAudio = new Audio(URL.createObjectURL(blob));
  await speakingAudio.play();
  await new Promise(resolve => { speakingAudio.onended = resolve; speakingAudio.onerror = resolve; });
  if (speakingAudio) URL.revokeObjectURL(speakingAudio.src);
}
async function sendTurn(text) {
  if (ended || busy || !text.trim()) return;
  busy = true; setState("thinking", "Nally is working…");
  addLine("YOU", text.trim());
  const turnStarted = Date.now();
  let progressDone = false, lastStatus = "", lastFillerAt = 0, fillerCount = 0;
  const progressWatcher = (async () => {
    while (!progressDone && !ended) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1200));
        if (progressDone || ended || !sessionId) break;
        const response = await request("/api/voice/progress", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ sessionId }) });
        const data = await response.json();
        const current = String(data.status || "");
        if (current && !ended) setState("thinking", current);
        if (current && current !== lastStatus && Date.now() - turnStarted >= 3200 && Date.now() - lastFillerAt >= 4500 && fillerCount < 3) {
          lastStatus = current;
          const filler = fillerForProgress(current);
          if (!ended) {
            lastFillerAt = Date.now(); fillerCount++;
            try { await speakFiller(filler); } catch {}
          }
        } else if (current) {
          lastStatus = current;
        }
      } catch {}
    }
  })();
  try {
    const response = await request("/api/voice/message", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,text:text.trim()})});
    progressDone = true;
    await progressWatcher;
    const data = await response.json();
    if (!data.text) throw new Error("Nally returned an empty response");
    addLine("NALLY", data.text);
    await speak(data.text);
  } catch (error) {
    progressDone = true;
    await progressWatcher;
    if (!ended) setState("listening", error.message || "Could not complete that turn");
  } finally {
    progressDone = true;
    busy = false;
    if (!ended && document.body.dataset.state !== "speaking") setState("listening", "Listening… speak naturally");
  }
}
function onTranscript(event) {
  let data; try { data = JSON.parse(event.data); } catch { return; }
  if (data.type === "Error") { setState("idle", "Live transcription disconnected. End the call and try again."); return; }
  const alternative = data.channel?.alternatives?.[0];
  const text = alternative?.transcript?.trim();
  if (!text) return;
  if (data.is_final) utterance += (utterance ? " " : "") + text;
  if (data.speech_final) {
    const finalText = (utterance || text).trim(); utterance = "";
    if (finalText) void sendTurn(finalText);
  } else if (!data.is_final) setState(busy ? "thinking" : "listening", busy ? "Nally is working…" : "Hearing: " + text);
}
async function begin() {
  if (!access.value.trim()) { document.querySelector(".settings").open = true; access.focus(); setState("idle", "Enter your voice access token in Connection settings first."); return; }
  start.disabled = true;
  try {
    setState("thinking", "Connecting securely…");
    const [sessionResponse, tokenResponse] = await Promise.all([
      request("/api/voice/session", {method:"POST"}),
      request("/api/voice/deepgram-token", {method:"POST"})
    ]);
    sessionId = (await sessionResponse.json()).sessionId;
    const token = (await tokenResponse.json()).access_token;
    media = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    audioContext = new AudioContext();
    source = audioContext.createMediaStreamSource(media);
    processor = audioContext.createScriptProcessor(4096,1,1);
    socket = new WebSocket("wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&endpointing=300&utterance_end_ms=1000&vad_events=true", ["bearer", token]);
    socket.onmessage = onTranscript;
    socket.onerror = () => { if (!ended) setState("idle", "Live transcription connection error."); };
    socket.onclose = (event) => { if (!ended) setState("idle", "Live transcription disconnected (code " + event.code + "). End the call and retry."); };
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("Could not connect to live transcription")); setTimeout(() => reject(new Error("Transcription connection timed out")), 12000); });
    // Deepgram closes live streams after periods without audio unless KeepAlive
    // control messages are sent. We pause PCM while Nally responds to avoid
    // transcribing Nally's own voice, so keep the socket alive during that pause.
    keepAliveTimer = setInterval(() => {
      if (!ended && socket?.readyState === WebSocket.OPEN && (muted || busy || document.body.dataset.state === "speaking")) {
        try { socket.send(JSON.stringify({ type: "KeepAlive" })); } catch {}
      }
    }, 3000);
    socket.onerror = () => { if (!ended) setState("idle", "Live transcription connection error."); };
    processor.onaudioprocess = (event) => {
      // Keep the ScriptProcessor silent on output to avoid playing microphone audio
      // through the speakers and feeding it back into transcription.
      event.outputBuffer.getChannelData(0).fill(0);
      if (ended || muted || busy || document.body.dataset.state === "speaking" || socket?.readyState !== WebSocket.OPEN) return;
      const pcm = floatTo16BitPCM(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
      socket.send(pcm.buffer);
    };
    source.connect(processor); processor.connect(audioContext.destination);
    ended = false; muted = false; busy = false; utterance = "";
    start.hidden = true; mute.disabled = false; end.disabled = false; mute.textContent = "Mute mic";
    setState("listening", "Listening… speak naturally");
  } catch (error) {
    await stopCall(false);
    setState("idle", error.message || "Could not start the call. Check microphone permission and configuration.");
    start.disabled = false;
  }
}
async function stopCall(reset = true) {
  const previousSessionId = sessionId;
  if (previousSessionId && access.value.trim()) {
    void fetch("/api/voice/end", { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ sessionId: previousSessionId }) }).catch(() => {});
  }
  ended = true;
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = undefined; }
  if (socket) { try { socket.close(); } catch {} socket = undefined; }
  if (processor) { try { processor.disconnect(); } catch {} processor = undefined; }
  if (source) { try { source.disconnect(); } catch {} source = undefined; }
  if (media) { media.getTracks().forEach(track => track.stop()); media = undefined; }
  if (audioContext) { try { await audioContext.close(); } catch {} audioContext = undefined; }
  if (speakingAudio) { speakingAudio.pause(); URL.revokeObjectURL(speakingAudio.src); speakingAudio = undefined; }
  sessionId = undefined; muted = false; busy = false;
  mute.disabled = true; end.disabled = true; start.hidden = false; start.disabled = false; mute.textContent = "Mute mic";
  if (reset) setState("idle", "Call ended");
}
start.addEventListener("click", begin);
end.addEventListener("click", () => stopCall(true));
mute.addEventListener("click", () => { muted = !muted; mute.textContent = muted ? "Unmute mic" : "Mute mic"; setState(muted ? "idle" : "listening", muted ? "Microphone muted" : "Listening… speak naturally"); });
window.addEventListener("beforeunload", () => { ended = true; media?.getTracks().forEach(track => track.stop()); socket?.close(); });
})();
</script>
</body>
</html>`;
