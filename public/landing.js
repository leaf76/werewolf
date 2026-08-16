const err = document.getElementById("landing-err");
const showErr = (text) => {
  err.textContent = text;
  err.hidden = false;
};

document.getElementById("create").addEventListener("click", async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    const res = await fetch("/api/rooms", { method: "POST" });
    if (res.status === 429) throw new Error("rate limited");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { code } = await res.json();
    location.href = `/r/${code}`;
  } catch (cause) {
    showErr(cause?.message === "rate limited" ? "建房太頻繁，請稍後再試。" : "建立房間失敗，請再試一次。");
    btn.disabled = false;
  }
});

document.getElementById("join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const code = document.getElementById("join-code").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    showErr("房號是 6 碼英數字。");
    return;
  }
  location.href = `/r/${code}`;
});
