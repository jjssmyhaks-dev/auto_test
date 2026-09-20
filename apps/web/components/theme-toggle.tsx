"use client";

import { useEffect, useState } from "react";

const KEY = "veriflow_theme";

/** Dark-mode toggle: flips the `.dark` class on <html>, persisted to localStorage. */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(KEY);
    const prefers = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    const initial = stored ? stored === "dark" : prefers;
    setDark(initial);
    document.documentElement.classList.toggle("dark", initial);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem(KEY, next ? "dark" : "light");
  }

  return (
    <button type="button" onClick={toggle} aria-label="Toggle dark mode" title="Toggle dark mode">
      {dark ? "☀" : "☾"}
    </button>
  );
}
