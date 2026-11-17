import { ArrowDown, ArrowRight, FilePdf, GlobeHemisphereWest, TextAlignLeft, CursorClick, LockSimple } from "@phosphor-icons/react";
import AppHeader from "./AppHeader";
import { AppLink } from "./navigation";

export default function Home() {
  return (
    <main className="app-shell home-shell">
      <AppHeader active="home" />
      <div className="home-content">
        <section className="home-intro" aria-labelledby="home-title">
          <span className="eyebrow">READ IN CONTEXT</span>
          <h1 id="home-title" tabIndex={-1}>让每一份内容，<br />都在语境里被理解。</h1>
          <p>从一份 PDF，或一个网址开始。<br className="mobile-break" />在熟悉的排版里，对照阅读。</p>
        </section>
        <section className="entry-grid" aria-label="选择翻译方式">
          <AppLink href="/pdf" className="feature-entry pdf-entry">
            <div className="entry-topline"><FilePdf size={26} weight="duotone" /><span>PDF 文档</span><ArrowRight className="entry-arrow" size={22} /></div>
            <div className="entry-visual paper-visual" aria-hidden="true">
              <div className="paper-sample paper-original"><span>Original</span><strong>A new<br />perspective.</strong><p>Great ideas deserve<br />to be understood.</p><i /></div>
              <div className="paper-sample paper-translated"><span>简体中文</span><strong>换一种语言，<br />理解同一个世界。</strong><p>让好的想法，<br />跨越语言的边界。</p><i /></div>
            </div>
            <div className="entry-copy"><h2>PDF 翻译</h2><p>保留文档版式，逐页对照阅读。</p></div>
            <div className="entry-bottom"><span>上传文件，开始翻译</span><span>最大 50 MB <ArrowRight size={16} /></span></div>
          </AppLink>
          <AppLink href="/web" className="feature-entry web-entry">
            <div className="entry-topline"><GlobeHemisphereWest size={26} weight="duotone" /><span>网页内容</span><ArrowRight className="entry-arrow" size={22} /></div>
            <div className="entry-visual browser-visual" aria-hidden="true">
              <div className="browser-sample"><div className="browser-sample-bar"><span>transflow.demo / guide</span></div><div className="browser-sample-content"><span>READ TOGETHER</span><strong>Same page.<br />A shared perspective.</strong><p>Keep your place.<br />Explore with context.</p><div><span>Overview</span><ArrowDown size={13} /></div></div></div>
              <div className="paired-cursor"><CursorClick size={28} weight="fill" /><span>两侧联动</span></div>
            </div>
            <div className="entry-copy"><h2>网页翻译</h2><p>保留原站结构，双侧联动浏览。</p></div>
            <div className="entry-bottom"><span>输入网址，开始翻译</span><span>公开网页 <ArrowRight size={16} /></span></div>
          </AppLink>
        </section>
        <footer className="home-footer"><span><TextAlignLeft size={16} />熟悉的排版，更连贯的阅读</span><span><LockSimple size={15} />PDF 本机存储</span></footer>
      </div>
    </main>
  );
}
