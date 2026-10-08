import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Moon, Sun } from "@phosphor-icons/react";
import { AppLink } from "./navigation";

type Theme = "light" | "dark";

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem("transflow-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch { /* Storage can be disabled; keep the control usable. */ }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function AppHeader({ active, children }: { active: "home" | "pdf" | "web"; children?: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const headerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const update = () => header.closest<HTMLElement>(".app-shell")?.style.setProperty("--app-header-height", `${header.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem("transflow-theme", next); } catch { /* Optional preference. */ }
  };
  return (
    <header ref={headerRef} className={`topbar app-header ${children ? "has-workspace-actions" : ""}`}>
      <AppLink className="brand" href="/" title="返回首页">
        <span className="brand-mark">T</span><span>TransFlow</span><small>对照翻译工作台</small>
      </AppLink>
      <div className="header-navigation">
        <nav aria-label="功能导航">
          <AppLink href="/pdf" aria-current={active === "pdf" ? "page" : undefined}>PDF 翻译</AppLink>
          <AppLink href="/web" aria-current={active === "web" ? "page" : undefined}>网页翻译</AppLink>
        </nav>
        <button className="icon-button theme-toggle" aria-label={theme === "dark" ? "切换浅色模式" : "切换深色模式"} onClick={toggleTheme}>
          {theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
        </button>
      </div>
      {children}
    </header>
  );
}
