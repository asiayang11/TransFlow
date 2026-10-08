import { lazy, Suspense, useEffect, useState } from "react";
import Home from "./Home";

const PdfWorkspace = lazy(() => import("./PdfWorkspace"));
const WebDemo = lazy(() => import("./WebDemo"));

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    document.title = path === "/web" ? "网页翻译 Demo · TransFlow" : path === "/pdf" || path.startsWith("/tasks/") ? "PDF 翻译 · TransFlow" : "TransFlow · 对照翻译工作台";
  }, [path]);

  return (
    <Suspense fallback={<main className="route-loading" role="status"><span className="brand-mark">T</span><p>正在打开工作区…</p></main>}>
      {path === "/pdf" || path.startsWith("/tasks/") ? <PdfWorkspace /> : path === "/web" ? <WebDemo /> : <Home />}
    </Suspense>
  );
}
