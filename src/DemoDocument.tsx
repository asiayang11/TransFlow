import { ArrowRight, BookOpen, CaretDown, Check, Compass, Heart, MagnifyingGlass } from "@phosphor-icons/react";

export type SampleId = "guide" | "article" | "product";
export type PageTab = "overview" | "details" | "resources";
export interface DemoState {
  tab: PageTab;
  expanded: string[];
  saved: boolean;
  search: string;
  hovered: string | null;
}

export const SAMPLES: Record<SampleId, { label: string; title: string; subtitle: string; url: string }> = {
  guide: { label: "文档页", title: "Read without losing your place.", subtitle: "A practical guide to a more focused reading workspace. Keep the structure, follow the ideas, and explore at your own pace.", url: "https://demo.transflow.local/guide" },
  article: { label: "文章页", title: "Small details. Better reading.", subtitle: "What makes a page feel easy to read? A few thoughtful choices can make room for the ideas that matter.", url: "https://demo.transflow.local/article" },
  product: { label: "产品页", title: "A workspace for curious minds.", subtitle: "Bring your reading into one place. Explore documents and websites with their original context close at hand.", url: "https://demo.transflow.local/product" },
};

const SECTIONS = [
  { id: "context", heading: "Keep the context close", text: "A page is more than a collection of sentences. Headings, images, navigation, and the space between paragraphs help us understand how ideas connect. Keeping that structure makes it easier to follow an unfamiliar subject.", note: "Start with the overview. Use the navigation to find a section, then return to the details whenever you need them." },
  { id: "structure", heading: "Make space for the details", text: "Good reading does not always happen from top to bottom. Sometimes we pause on a definition, open a related section, or return to an earlier example. A useful workspace follows these small changes without making us start again.", note: "Try the tabs above, save the page, or expand a question below. The other view will follow the same interaction." },
  { id: "explore", heading: "Explore at your own pace", text: "A consistent layout leaves more attention for the content. Scroll to a new idea, adjust the view to a comfortable size, and keep both perspectives within reach. The reading experience should feel familiar even when the language changes.", note: "This demonstration uses the same English content in both views. It lets you review the interaction before translation is connected." },
];

const QUESTIONS = [
  { id: "sync", question: "How do the two views stay together?", answer: "Both views share the same page state. Switching a tab, opening a section, or saving a page updates the matching component on the other side." },
  { id: "zoom", question: "Can I adjust the reading size?", answer: "Yes. Use the zoom controls above the page, or hold Ctrl / Cmd while scrolling inside either view. The reading size changes on both sides." },
  { id: "translation", question: "Is this page translated?", answer: "Not yet. Both views intentionally show the same page. Real website loading and translation will be built after this interaction demo is reviewed." },
];

export const initialDemoState = (): DemoState => ({ tab: "overview", expanded: [], saved: false, search: "", hovered: null });

interface Props {
  sample: SampleId;
  state: DemoState;
  onChange: (next: Partial<DemoState>) => void;
  onAnchor: (id: string) => void;
  prefix: string;
}

export default function DemoDocument({ sample, state, onChange, onAnchor, prefix }: Props) {
  const page = SAMPLES[sample];
  const visibleSections = SECTIONS.filter((section) => `${section.heading} ${section.text}`.toLowerCase().includes(state.search.trim().toLowerCase()));
  const hover = (id: string) => ({ onPointerEnter: () => onChange({ hovered: id }), onPointerLeave: () => onChange({ hovered: null }) });
  return (
    <div className={`demo-document demo-kind-${sample}`} lang="en">
      <header className="sample-header"><span className="sample-brand"><Compass size={23} weight="duotone" />TransFlow <small>Guide</small></span><button className={state.hovered === "save" ? "is-mirrored-hover" : ""} aria-label={state.saved ? "Unsave page" : "Save page"} aria-pressed={state.saved} onClick={() => onChange({ saved: !state.saved })} {...hover("save")}><Heart size={18} weight={state.saved ? "fill" : "regular"} /><span>{state.saved ? "Saved" : "Save"}</span></button></header>
      <div className="sample-layout">
        <aside className="sample-sidebar"><span>ON THIS PAGE</span>{SECTIONS.map((section) => <button key={section.id} onClick={() => onAnchor(section.id)} className={state.hovered === section.id ? "is-mirrored-hover" : ""} {...hover(section.id)}>{section.heading}</button>)}<div className="sidebar-note"><BookOpen size={20} /><p>One page.<br />Two perspectives.</p></div></aside>
        <article className="sample-article">
          <div className="sample-breadcrumb">Library <span>/</span> {sample === "article" ? "Reading notes" : sample === "product" ? "Workspace" : "Getting started"}</div>
          <h2>{page.title}</h2><p className="sample-lead">{page.subtitle}</p>
          <div className="sample-art" aria-label="The same reading structure in two views"><div><span>Keep the structure</span><strong>Aa</strong></div><ArrowRight size={24} /><div><span>Keep the perspective</span><strong>Aa</strong></div></div>
          <div className="sample-tabs" role="tablist" aria-label="Page sections">
            {(["overview", "details", "resources"] as const).map((tab) => <button key={tab} id={`${prefix}-tab-${tab}`} role="tab" aria-selected={state.tab === tab} aria-controls={`${prefix}-panel`} tabIndex={state.tab === tab ? 0 : -1} onClick={() => onChange({ tab })} onKeyDown={(event) => {
              const tabs: PageTab[] = ["overview", "details", "resources"];
              const index = tabs.indexOf(tab);
              const next = event.key === "ArrowRight" ? tabs[(index + 1) % 3] : event.key === "ArrowLeft" ? tabs[(index + 2) % 3] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[2] : null;
              if (next) { event.preventDefault(); onChange({ tab: next }); document.getElementById(`${prefix}-tab-${next}`)?.focus(); }
            }}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}
          </div>
          <div id={`${prefix}-panel`} role="tabpanel" aria-labelledby={`${prefix}-tab-${state.tab}`}>
            {state.tab === "overview" ? <>
              <label className="sample-search"><MagnifyingGlass size={17} /><input aria-label="Find a section" placeholder="Find a section…" value={state.search} onChange={(event) => onChange({ search: event.target.value })} /></label>
              {visibleSections.length ? visibleSections.map((section) => <section className="sample-section" data-anchor={section.id} key={section.id}><h3>{section.heading}</h3><p>{section.text}</p><blockquote>{section.note}</blockquote></section>) : <div className="sample-empty"><h3>No matching sections</h3><p>Try “context”, “details”, or clear the search to see the full guide.</p><button onClick={() => onChange({ search: "" })}>Clear search</button></div>}
            </> : state.tab === "details" ? <section className="sample-section"><h3>The details that make a difference</h3><p>A shared reading state keeps navigation, expanded content, and saved items consistent. You can start on either side and continue from the same place.</p><ul className="sample-checklist"><li><Check size={17} />A consistent page structure</li><li><Check size={17} />Tabs and sections that stay in sync</li><li><Check size={17} />A comfortable, shared reading size</li></ul><p>Switch back to Overview to explore the longer page, or open the questions below to see how expanded content is mirrored.</p></section> : <section className="sample-section"><h3>Continue exploring</h3><p>Use this demonstration to review the layout and interaction. Each example page keeps the same content in both views.</p><div className="sample-resource"><BookOpen size={23} /><div><strong>Reading with context</strong><p>A short guide to keeping your place.</p></div></div><div className="sample-resource"><Compass size={23} /><div><strong>Exploring a page</strong><p>Try navigation, zoom, and shared state.</p></div></div></section>}
          </div>
          <section className="sample-faq"><h3>A few useful answers</h3>{QUESTIONS.map((item) => {
            const open = state.expanded.includes(item.id);
            return <div className="sample-disclosure" key={item.id}><button aria-expanded={open} aria-controls={`${prefix}-answer-${item.id}`} onClick={() => onChange({ expanded: open ? state.expanded.filter((id) => id !== item.id) : [...state.expanded, item.id] })} {...hover(`faq-${item.id}`)} className={state.hovered === `faq-${item.id}` ? "is-mirrored-hover" : ""}>{item.question}<CaretDown size={16} className={open ? "is-open" : ""} /></button><div id={`${prefix}-answer-${item.id}`} hidden={!open}><p>{item.answer}</p></div></div>;
          })}</section>
          <footer className="sample-footer">TransFlow Guide<span>Built for reading in context.</span></footer>
        </article>
      </div>
    </div>
  );
}
