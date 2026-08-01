export function addToHistory(name, text) {
  const log = document.getElementById("history-log");
  if (!log) return;
  const entry = document.createElement("div");
  entry.style.borderBottom = "1px solid #333";
  entry.style.padding = "5px 0";
  entry.innerHTML = `<strong style="color: #9c27b0">${name}:</strong> ${text}`;
  log.prepend(entry);
}

export function clearHistory() {
  const log = document.getElementById("history-log");
  if (log) log.innerHTML = "";
}