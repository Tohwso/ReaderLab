// ============ ReaderLab — Tema (light/dark/system) ============
// Persistido em localStorage; "system" acompanha prefers-color-scheme.
const STORAGE_KEY = "readerlab:theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

function resolve(pref) {
  return pref === "system" ? (media.matches ? "dark" : "light") : pref;
}

export function getThemePreference() {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function applyTheme(pref = getThemePreference()) {
  document.documentElement.setAttribute("data-theme", resolve(pref));
}

export function setThemePreference(pref) {
  localStorage.setItem(STORAGE_KEY, pref);
  applyTheme(pref);
}

export function initTheme() {
  applyTheme();
  media.addEventListener("change", () => {
    if (getThemePreference() === "system") applyTheme("system");
  });
}
